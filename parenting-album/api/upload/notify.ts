import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';

import {
  findUserByKakaoId,
  createRawEntry,
} from '../../lib/notion.js';

/**
 * POST /api/upload/notify
 *
 * 웹 업로드 페이지에서 Cloudinary 직접 업로드 후 호출.
 * Cloudinary upload 결과를 받아 Notion Raw_Entry에 저장한다.
 */

const bodySchema = z.object({
  authorKakaoUserId: z.string().min(1),
  caption: z.string().default(''),
  cloudinaryResult: z.object({
    secure_url: z.string().url(),
    public_id: z.string(),
    resource_type: z.string(),
    width: z.number().nullish(),
    height: z.number().nullish(),
    duration: z.number().nullish(),
    bytes: z.number().nullish(),
    eager: z.array(z.record(z.unknown())).nullish(),
  }),
});

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  try {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
      return;
    }
    const { authorKakaoUserId, caption, cloudinaryResult: cr } = parsed.data;

    const user = await findUserByKakaoId(authorKakaoUserId);
    if (!user || user.state !== 'active') {
      res.status(403).json({ error: '등록되지 않은 사용자입니다.' });
      return;
    }

    const displayName = user.displayName ?? '가족';
    const isVideo = cr.resource_type === 'video';
    const publicId = cr.public_id;

    // eager 변환본 URL 추출 (Cloudinary unsigned upload preset에서 eager가 설정된 경우)
    const eagerUrl = (idx: number): string | undefined => {
      const e = cr.eager;
      if (!e || !e[idx]) return undefined;
      return (e[idx] as { secure_url?: string }).secure_url;
    };

    await createRawEntry({
      idempotencyKey: `web_${publicId}`,
      timestamp: new Date(),
      mediaKind: isVideo ? 'Video' : 'Image',
      rawContent: caption,
      author: displayName,
      authorKakaoUserId: user.kakaoUserId,
      media: {
        kind: isVideo ? 'video' : 'image',
        publicId,
        originalUrl: cr.secure_url,
        printUrl: eagerUrl(0) ?? cr.secure_url,
        thumbUrl: eagerUrl(1) ?? cr.secure_url,
        webVideoUrl: isVideo ? (eagerUrl(0) ?? cr.secure_url) : undefined,
        durationSeconds: cr.duration ?? undefined,
        width: cr.width ?? undefined,
        height: cr.height ?? undefined,
      },
    });

    console.log('[upload notify] entry saved', { publicId, author: displayName });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[upload notify] error', err);
    res.status(500).json({ error: '서버 오류' });
  }
}
