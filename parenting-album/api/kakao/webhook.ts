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
  resetUserToAwaitingName,
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

const RENAME_PROMPT = `이름을 바꿀게요. 새로 어떻게 불러드리면 좋을까요?
(예: 아빠, 엄마, 외할머니, 큰이모)`;

const ALREADY_REGISTERED = (name: string): string =>
  `이미 ${name}(으)로 등록되어 있어요 🌷
사진이나 영상을 바로 보내주시면 저장돼요.

혹시 이름을 바꾸고 싶으시면 "이름변경" 이라고 보내주세요.`;

/** 가족 관계를 나타내는 흔한 단어들 (중복 등록 감지용) */
const RELATIONSHIP_WORDS = new Set([
  '아빠',
  '엄마',
  '아버지',
  '어머니',
  '할아버지',
  '할머니',
  '외할아버지',
  '외할머니',
  '친할아버지',
  '친할머니',
  '할아부지',
  '할무니',
  '이모',
  '고모',
  '큰이모',
  '작은이모',
  '큰고모',
  '작은고모',
  '삼촌',
  '외삼촌',
  '큰삼촌',
  '작은삼촌',
  '큰아빠',
  '작은아빠',
  '큰엄마',
  '작은엄마',
  '누나',
  '형',
  '오빠',
  '언니',
]);

/** 이름 변경/등록 재시도 명령어 */
const RENAME_COMMANDS = new Set([
  '이름변경',
  '이름 변경',
  '이름바꿔',
  '이름 바꿔',
  '이름바꿈',
  '이름수정',
  '/rename',
  '/reset',
  '/이름',
]);

/** 디지털 앨범 월별 URL 생성 */
function getAlbumUrl(date: Date): string | null {
  const base =
    process.env.PUBLIC_ALBUM_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  if (!base) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${base}/album/${y}-${m}`;
}

const ACK_MESSAGE = (name: string, albumUrl: string | null): string => {
  const line1 = `📸 ${name}의 기록 저장 중이에요`;
  if (!albumUrl) return line1;
  return `${line1}

완료되면 여기서 확인하세요 ❤️
${albumUrl}

댓글도 달아주시면 원우에게 좋은 추억이 될 거예요 🌷`;
};

const ACK_MESSAGE_SHORT = (name: string): string =>
  `📸 ${name}의 기록 계속 저장 중이에요`;

// ────────────────────────────────────────────────────────────────
// ACK 디듭 윈도우
//
// 같은 사용자가 짧은 시간 안에 여러 장/번 보내면 링크 포함 풀 메시지가
// 반복되면 알림 스팸처럼 느껴진다. 첫 메시지만 풀 ACK + 링크를 주고,
// 이후 20초 내 메시지는 짧은 "계속 저장 중" 한 줄만 반환.
//
// 인메모리 Map이므로 Vercel 서버리스 인스턴스가 재사용되는 동안만 유효.
// 콜드 스타트 후엔 리셋되지만, 묶음 전송은 보통 수 초 내에 완료되므로
// 동일 인스턴스 내에서 처리될 확률이 높다.
// ────────────────────────────────────────────────────────────────
const ACK_DEDUP_WINDOW_MS = 20_000;
const lastAckAt = new Map<string, number>();

function shouldSendShortAck(userId: string): boolean {
  const now = Date.now();
  const last = lastAckAt.get(userId);
  lastAckAt.set(userId, now);
  // 메모리 누수 방지: 1000개 넘어가면 오래된 것부터 정리
  if (lastAckAt.size > 1000) {
    const cutoff = now - ACK_DEDUP_WINDOW_MS * 2;
    for (const [key, ts] of lastAckAt) {
      if (ts < cutoff) lastAckAt.delete(key);
    }
  }
  return last !== undefined && now - last < ACK_DEDUP_WINDOW_MS;
}

const REGISTRATION_COMPLETE = (name: string): string =>
  `${name}(으)로 등록 완료! 🎉
이제 원우 사진이나 짧은 영상을 보내주시면 예쁜 앨범으로 만들어드릴게요.`;

const DISABLED_REPLY = `이용이 제한된 사용자입니다.
관리자에게 문의해주세요.`;

const ERROR_REPLY = `잠시 후 다시 시도해주세요 🙏
(서버에서 문제가 발생했어요)`;

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
      // OpenBuilder의 "스킬 테스트" 버튼은 user.id 등을 생략한 최소 payload를 보낸다.
      // 이 때 400을 리턴하면 OpenBuilder가 "올바르지 않은 스킬 서버 응답"으로 오인하므로
      // 200 + simpleText(환영 메시지)로 응답해 검증을 통과시킨다.
      // 진짜 카톡 메시지는 user.id가 항상 포함되어 여기에 걸리지 않는다.
      console.warn('[webhook] body parse failed — returning welcome as test response', {
        issues: parsed.error.flatten(),
      });
      res.status(200).json(simpleTextResponse(WELCOME_MESSAGE));
      return;
    }

    // 4. Extract
    const payload = extractPayload(parsed.data);

    // 4-b. userId가 비어있으면 (OpenBuilder 스킬 테스트 등) 환영 메시지만 반환
    if (!payload.userId) {
      console.log('[webhook] empty userId — returning welcome (probably skill test)');
      res.status(200).json(simpleTextResponse(WELCOME_MESSAGE));
      return;
    }

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

    // 5-c-2. 활성 사용자가 "이름변경" 명령을 보낸 경우 — awaiting_name으로 되돌림
    const trimmedUtterance = payload.utterance.trim();
    if (
      existingUser.state === 'active' &&
      payload.mediaUrls.length === 0 &&
      RENAME_COMMANDS.has(trimmedUtterance)
    ) {
      await resetUserToAwaitingName(existingUser.pageId, existingUser.kakaoUserId);
      console.log('[webhook] user reset to awaiting_name by rename command', {
        userId: payload.userId,
      });
      res.status(200).json(simpleTextResponse(RENAME_PROMPT));
      return;
    }

    // 5-c-3. 활성 사용자가 관계어 1개만 달랑 보낸 경우 — 중복 등록으로 판단
    //         (이미 등록됨을 알리고 이름변경 방법 안내)
    if (
      existingUser.state === 'active' &&
      payload.mediaUrls.length === 0 &&
      RELATIONSHIP_WORDS.has(trimmedUtterance)
    ) {
      const currentName = existingUser.displayName ?? '가족';
      console.log('[webhook] already registered — relationship word ignored', {
        userId: payload.userId,
        utterance: trimmedUtterance,
      });
      res.status(200).json(simpleTextResponse(ALREADY_REGISTERED(currentName)));
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
    //    같은 사용자가 연달아 보내면 첫 번째만 링크 포함 풀 메시지,
    //    이후 20초 내 메시지는 짧은 ACK만 (스팸 방지)
    const useShortAck = shouldSendShortAck(payload.userId);
    const ackText = useShortAck
      ? ACK_MESSAGE_SHORT(displayName)
      : ACK_MESSAGE(displayName, getAlbumUrl(payload.timestamp));
    res.status(200).json(simpleTextResponse(ackText));

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
      // Kakao에겐 5xx 대신 200 + 에러 안내 메시지로 응답해 사용자 UX 보호.
      // Kakao는 빈 SimpleText를 거부하므로 반드시 내용이 있어야 함.
      res.status(200).json(simpleTextResponse(ERROR_REPLY));
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
