import { z } from 'zod';

/**
 * Kakao i OpenBuilder Webhook 요청 스키마.
 * OpenBuilder는 봇 설정에 따라 필드 구성이 달라지므로 관대하게(passthrough) 파싱하고,
 * 우리가 필요한 필드(user.id, utterance, 이미지 URL)만 extractPayload에서 탐색한다.
 */
const userSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    properties: z.record(z.unknown()).optional(),
  })
  .passthrough();

const userRequestSchema = z
  .object({
    timezone: z.string().optional(),
    utterance: z.string().default(''),
    user: userSchema,
    block: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
    lang: z.string().optional(),
    params: z.record(z.unknown()).optional(),
  })
  .passthrough();

const actionSchema = z
  .object({
    name: z.string().optional(),
    id: z.string().optional(),
    params: z.record(z.unknown()).optional(),
    detailParams: z.record(z.unknown()).optional(),
    clientExtra: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const kakaoRequestSchema = z
  .object({
    intent: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
    userRequest: userRequestSchema,
    action: actionSchema.optional(),
    bot: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
    contexts: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type KakaoRequest = z.infer<typeof kakaoRequestSchema>;

export interface ExtractedPayload {
  userId: string;
  utterance: string;
  mediaUrls: string[];
  messageBlockId: string;
  timestamp: Date;
}

/**
 * 임의의 JSON 값을 재귀 탐색하여 http(s) URL 문자열을 모두 수집.
 * Kakao OpenBuilder는 스킬 설정에 따라 이미지 URL을 다양한 위치(action.params, detailParams 등)에
 * 실어 보내기 때문에 고정된 경로 대신 전체 탐색이 안전하다.
 */
function collectUrlStrings(value: unknown, acc: Set<string>): void {
  if (value == null) return;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) {
      acc.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectUrlStrings(v, acc);
    return;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectUrlStrings(v, acc);
    }
  }
}

/**
 * 미디어처럼 보이는 URL인지 간단 판정.
 * 확장자 or 경로 keyword 기반. 카카오 임시 URL은 쿼리파라미터가 붙어있는 경우가 많다.
 */
function isLikelyMediaUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (/\.(jpe?g|png|gif|webp|heic|heif|mp4|mov|m4v|webm|3gp)(\?|$|#)/i.test(lower)) {
    return true;
  }
  if (/\/(secureimage|media|images?|files?|multimedia|attachment)\//i.test(lower)) {
    return true;
  }
  return false;
}

export function extractPayload(req: KakaoRequest): ExtractedPayload {
  const userId = req.userRequest.user.id;
  const utterance = (req.userRequest.utterance ?? '').trim();
  const messageBlockId = req.userRequest.block?.id ?? req.action?.id ?? 'unknown';
  const timestamp = new Date();

  const urls = new Set<string>();
  collectUrlStrings(req.action?.params, urls);
  collectUrlStrings(req.action?.detailParams, urls);
  collectUrlStrings(req.action?.clientExtra, urls);
  collectUrlStrings(req.userRequest.params, urls);

  const mediaUrls = Array.from(urls).filter(isLikelyMediaUrl);

  return { userId, utterance, mediaUrls, messageBlockId, timestamp };
}

/**
 * Kakao OpenBuilder 응답의 simpleText 템플릿.
 * Webhook 응답은 반드시 이 형식이어야 사용자에게 메시지가 표시된다.
 */
export function simpleTextResponse(text: string): {
  version: '2.0';
  template: { outputs: Array<{ simpleText: { text: string } }> };
} {
  return {
    version: '2.0',
    template: {
      outputs: [
        {
          simpleText: { text },
        },
      ],
    },
  };
}
