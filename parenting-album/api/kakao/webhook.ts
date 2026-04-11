import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';

import {
  kakaoRequestSchema,
  extractPayload,
  simpleTextResponse,
} from '../../lib/kakao.js';
import { uploadFromUrl } from '../../lib/cloudinary.js';
import {
  findUserByKakaoId,
  createUser,
  updateUserNameAndActivate,
  findEntryByIdempotencyKey,
  createRawEntry,
  type NotionUser,
} from '../../lib/notion.js';
import { generateIdempotencyKey } from '../../lib/idempotency.js';

// ────────────────────────────────────────────────────────────────
// Messages
// ────────────────────────────────────────────────────────────────

const WELCOME_MESSAGE = `안녕하세요! 원우 앨범봇이에요 🌷
원우와 어떤 관계이신가요?
(예: 아빠, 엄마, 외할머니, 큰이모, 큰삼촌)`;

const MEDIA_BEFORE_REGISTRATION = `먼저 원우와 어떤 관계이신지 알려주세요 🌷
(예: 아빠, 엄마, 외할머니, 큰이모)
등록이 끝나면 사진을 다시 보내주세요.`;

const REGISTRATION_RETRY = `어떻게 불러드리면 좋을까요?
1~10자로 다시 알려주세요 🙏 (예: 아빠, 외할머니)`;

const ACK_MESSAGE = (name: string): string => `${name}의 기록 저장 중이야 📸`;

const REGISTRATION_COMPLETE = (name: string): string =>
  `${name}(으)로 등록 완료! 🎉
이제 원우 사진이나 짧은 영상을 보내주시면 예쁜 앨범으로 만들어드릴게요.`;

const DISABLED_REPLY = ''; // 조용히 무응답

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** 가족이 답한 display_name이 저장 가능한 형태인지 검증 */
function isValidDisplayName(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 1 || s.length > 10) return false;
  // 한글/영문/숫자 중 하나라도 포함되어야 (특수문자나 공백만 있는 것 거부)
  if (!/[\p{L}\p{N}]/u.test(s)) return false;
  return true;
}

function formatYearMonth(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  try {
    // 1. Method
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }

    // 2. Secret (제안 E)
    const providedSecret = typeof req.query.secret === 'string' ? req.query.secret : '';
    const expectedSecret = process.env.KAKAO_WEBHOOK_SECRET ?? '';
    if (!expectedSecret || providedSecret !== expectedSecret) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // 3. Body schema
    const parsed = kakaoRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      console.warn('[webhook] body parse failed', parsed.error.flatten());
      res.status(400).json({ error: 'invalid payload' });
      return;
    }

    // 4. Extract
    const payload = extractPayload(parsed.data);

    // 5. State machine
    const existingUser = await findUserByKakaoId(payload.userId);

    // 5-a. 첫 만남
    if (!existingUser) {
      const created = await createUser({ kakaoUserId: payload.userId });
      console.log('[webhook] new user created', {
        userId: payload.userId,
        pageId: created.pageId,
      });
      res.status(200).json(simpleTextResponse(WELCOME_MESSAGE));
      return;
    }

    // 5-b. 비활성화된 사용자
    if (existingUser.state === 'disabled') {
      console.log('[webhook] disabled user attempted', {
        userId: payload.userId,
      });
      res.status(200).json(simpleTextResponse(DISABLED_REPLY));
      return;
    }

    // 5-c. 관계 답변 대기 중
    if (existingUser.state === 'awaiting_name') {
      // 미디어가 섞여오면 등록 먼저
      if (payload.mediaUrls.length > 0) {
        res.status(200).json(simpleTextResponse(MEDIA_BEFORE_REGISTRATION));
        return;
      }
      if (isValidDisplayName(payload.utterance)) {
        const name = payload.utterance.trim();
        await updateUserNameAndActivate(existingUser.pageId, existingUser.kakaoUserId, name);
        console.log('[webhook] user activated', {
          userId: payload.userId,
          name,
        });
        res.status(200).json(simpleTextResponse(REGISTRATION_COMPLETE(name)));
        return;
      }
      res.status(200).json(simpleTextResponse(REGISTRATION_RETRY));
      return;
    }

    // 5-d. 활성 사용자 — 정상 저장 플로우
    const activeUser: NotionUser = existingUser;
    const displayName = activeUser.displayName ?? '가족';

    const idempotencyKey = generateIdempotencyKey(
      payload.userId,
      payload.timestamp.getTime(),
      payload.utterance,
      payload.mediaUrls.join('|'),
    );

    // 6. 즉시 응답 (제안 B-2)
    res.status(200).json(simpleTextResponse(ACK_MESSAGE(displayName)));

    // 7. 백그라운드 처리 (Vercel waitUntil)
    waitUntil(
      processInBackground({
        user: activeUser,
        displayName,
        idempotencyKey,
        payload,
      }),
    );
  } catch (err) {
    console.error('[webhook] top-level error', err);
    if (!res.headersSent) {
      // Kakao에겐 5xx 대신 빈 simpleText로 응답해 사용자 UX 보호
      res.status(200).json(simpleTextResponse(''));
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Background worker
// ────────────────────────────────────────────────────────────────

interface BackgroundJob {
  user: NotionUser;
  displayName: string;
  idempotencyKey: string;
  payload: ReturnType<typeof extractPayload>;
}

async function processInBackground(job: BackgroundJob): Promise<void> {
  const { user, displayName, idempotencyKey, payload } = job;
  try {
    const existing = await findEntryByIdempotencyKey(idempotencyKey);
    if (existing) {
      console.log('[webhook bg] duplicate skipped', { key: idempotencyKey });
      return;
    }

    const baseFolder = process.env.CLOUDINARY_FOLDER ?? 'wonwoo-album';
    const folder = `${baseFolder}/${formatYearMonth(payload.timestamp)}`;

    // 미디어 없는 순수 텍스트
    if (payload.mediaUrls.length === 0) {
      if (payload.utterance) {
        await createRawEntry({
          idempotencyKey,
          timestamp: payload.timestamp,
          mediaKind: 'Text',
          rawContent: payload.utterance,
          author: displayName,
          authorKakaoUserId: user.kakaoUserId,
        });
        console.log('[webhook bg] text entry saved', { key: idempotencyKey });
      }
      return;
    }

    // 미디어 업로드 (여러 장 순차 처리)
    for (let i = 0; i < payload.mediaUrls.length; i += 1) {
      const url = payload.mediaUrls[i]!;
      const perItemKey =
        payload.mediaUrls.length > 1 ? `${idempotencyKey}_${i}` : idempotencyKey;

      try {
        const upload = await uploadFromUrl({
          sourceUrl: url,
          folder,
          publicId: perItemKey,
          maxVideoSeconds: 60,
        });
        await createRawEntry({
          idempotencyKey: perItemKey,
          timestamp: payload.timestamp,
          mediaKind: upload.kind === 'video' ? 'Video' : 'Image',
          rawContent: payload.utterance,
          author: displayName,
          authorKakaoUserId: user.kakaoUserId,
          media: upload,
        });
        console.log('[webhook bg] media entry saved', {
          key: perItemKey,
          kind: upload.kind,
        });
      } catch (inner) {
        console.error('[webhook bg] media upload failed', {
          url,
          error: inner instanceof Error ? inner.message : inner,
        });
      }
    }
  } catch (err) {
    console.error('[webhook bg] fatal', err);
  }
}
