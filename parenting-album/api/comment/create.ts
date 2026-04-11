import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { createComment, findUserByKakaoId } from '../../lib/notion.js';

/**
 * POST /api/comment/create
 *
 * Body:
 *   { momentRefId, authorKakaoUserId, authorName, text }
 *
 * 검증:
 *   1. 필드 스키마 검증
 *   2. authorKakaoUserId가 Notion Users DB에 존재하고 state='active'인지 확인
 *      → 등록되지 않은 가족이나 쫓겨난 사용자 차단
 *   3. 텍스트 길이 500자 제한
 *   4. 간단 rate limit (메모리 기반, 동일 IP 10초당 5개)
 *
 * IP는 해시해서 저장 (개인정보 최소화).
 */

const bodySchema = z.object({
  momentRefId: z.string().min(1),
  authorKakaoUserId: z.string().min(1),
  authorName: z.string().min(1).max(10),
  text: z.string().min(1).max(500),
});

// In-memory rate limit (per serverless instance)
interface RateEntry {
  count: number;
  windowStart: number;
}
const rateLimitMap = new Map<string, RateEntry>();
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 5;

function checkRateLimit(ipHash: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ipHash);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ipHash, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }
  entry.count += 1;
  return true;
}

function getClientIp(req: VercelRequest): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0]!.trim();
  if (Array.isArray(xff) && xff.length > 0) return xff[0]!;
  return req.socket?.remoteAddress ?? 'unknown';
}

function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;

    // Rate limit
    const ipHash = hashIp(getClientIp(req));
    if (!checkRateLimit(ipHash)) {
      res.status(429).json({ error: '댓글을 너무 빨리 작성하셨어요. 잠시 후 다시 시도해주세요.' });
      return;
    }

    // Validate author exists and is active
    const user = await findUserByKakaoId(body.authorKakaoUserId);
    if (!user || user.state !== 'active') {
      res.status(403).json({ error: '등록되지 않은 사용자입니다.' });
      return;
    }

    // displayName은 Notion DB 기준으로 override (클라이언트 속임 방지)
    const trustedAuthorName = user.displayName ?? body.authorName;

    const commentId = await createComment({
      momentRefId: body.momentRefId,
      authorKakaoUserId: body.authorKakaoUserId,
      authorName: trustedAuthorName,
      text: body.text,
      ipHash,
    });

    res.status(200).json({ ok: true, commentId });
  } catch (err) {
    console.error('[comment create] error', err);
    res.status(500).json({ error: '서버 오류' });
  }
}
