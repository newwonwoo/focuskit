import { z } from 'zod';

/**
 * Kakao i OpenBuilder Webhook 요청 스키마.
 *
 * 설계 원칙: 카카오는 버전마다 / 블록 설정마다 페이로드 구조가 달라지고
 * 일부 필드에 null을 보낼 때가 있다. 그래서 스키마는 **최대한 관대하게** 만들고
 * (필드 대부분 nullish + passthrough), 우리가 실제로 읽는 user.id만 명시한다.
 * 나머지는 extractPayload에서 optional chaining으로 안전하게 조회한다.
 */
const userSchema = z
  .object({
    id: z.string().nullish(),
    type: z.string().nullish(),
    properties: z.record(z.unknown()).nullish(),
  })
  .passthrough();

const userRequestSchema = z
  .object({
    timezone: z.string().nullish(),
    utterance: z.string().nullish(),
    user: userSchema.nullish(),
    block: z
      .object({
        id: z.string().nullish(),
        name: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    lang: z.string().nullish(),
    params: z.record(z.unknown()).nullish(),
  })
  .passthrough();

const actionSchema = z
  .object({
    name: z.string().nullish(),
    id: z.string().nullish(),
    params: z.record(z.unknown()).nullish(),
    detailParams: z.record(z.unknown()).nullish(),
    clientExtra: z.record(z.unknown()).nullish(),
  })
  .passthrough();

export const kakaoRequestSchema = z
  .object({
    intent: z
      .object({
        id: z.string().nullish(),
        name: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    userRequest: userRequestSchema.nullish(),
    action: actionSchema.nullish(),
    bot: z
      .object({
        id: z.string().nullish(),
        name: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    contexts: z.array(z.unknown()).nullish(),
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
 *
 * 지원 확장자:
 *  - 이미지: jpg/jpeg, png, gif, webp, heic/heif, avif, bmp, tif/tiff
 *  - 영상:   mp4, mov, m4v, webm, 3gp, avi, mkv, mts, m2ts, wmv, flv
 *
 * 확장자가 없는 URL도 /secureimage/ 등 카카오 스타일 경로면 미디어로 인식.
 */
function isLikelyMediaUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (
    /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|mp4|mov|m4v|webm|3gp|avi|mkv|mts|m2ts|wmv|flv)(\?|$|#)/i.test(
      lower,
    )
  ) {
    return true;
  }
  if (/\/(secureimage|media|images?|files?|multimedia|attachment|photo|video|clip)\//i.test(lower)) {
    return true;
  }
  return false;
}

export function extractPayload(req: KakaoRequest): ExtractedPayload {
  // 모든 경로를 안전하게 조회. Kakao가 null을 섞어 보내도 안전.
  const userId = req.userRequest?.user?.id ?? '';
  const utterance = (req.userRequest?.utterance ?? '').trim();
  const messageBlockId = req.userRequest?.block?.id ?? req.action?.id ?? 'unknown';
  const timestamp = new Date();

  const urls = new Set<string>();
  collectUrlStrings(req.action?.params, urls);
  collectUrlStrings(req.action?.detailParams, urls);
  collectUrlStrings(req.action?.clientExtra, urls);
  collectUrlStrings(req.userRequest?.params, urls);

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
