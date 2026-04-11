import { GoogleGenerativeAI } from '@google/generative-ai';

export interface WeekEntryInput {
  date: Date;
  author: string;
  rawContent: string;
  mediaKind: 'Text' | 'Image' | 'Video' | 'Mixed';
  comments: Array<{ author: string; text: string }>;
}

export interface WeekSummarizeInput {
  startDate: Date;
  endDate: Date;
  entries: WeekEntryInput[];
}

export interface WeekSummarizeResult {
  weekTitle: string;
  essay: string;
}

let clientInstance: GoogleGenerativeAI | null = null;
function getClient(): GoogleGenerativeAI {
  if (!clientInstance) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('[gemini] GEMINI_API_KEY is not set');
    clientInstance = new GoogleGenerativeAI(key);
  }
  return clientInstance;
}

const MODEL_NAME = 'gemini-1.5-flash';

const SYSTEM_PROMPT = `당신은 24개월 아이 "원우"의 성장 기록을 다듬는 따뜻한 관찰자입니다.
아래는 이번 주 가족들(아빠, 엄마, 조부모, 이모·삼촌 등)이 카카오톡으로 남긴 사진 캡션과
디지털 앨범에 단 댓글을 정리한 것입니다.

다음 두 가지를 생성해주세요:

1. week_title — 이번 주 핵심 변화나 사건을 담은 10자 내외의 감성적 제목
2. essay — 3~5문장의 짧은 에세이

에세이 규칙 (엄격히 지킬 것):
- 가족 각자의 시선(아빠, 엄마, 외할머니, 큰이모 등)이 자연스럽게 녹아들게 하세요.
- 파편화된 메모들을 연결된 서술로 엮되, 존재하지 않는 사실을 추가하지 마세요.
- 이모지 사용 금지.
- "사랑스러운", "너무나", "정말", "참으로", "꼭 닮은" 같은 상투적 수식어 피하기.
- 담백하고 정확하게. 10년 뒤 원우가 읽어도 유치하지 않게.
- 존댓말 아님. "~했다" "~였다" 같은 관찰자 서술체.

반드시 아래 JSON 형식으로만 응답 (다른 텍스트 금지):
{"week_title": "...", "essay": "..."}`;

function formatEntriesForPrompt(input: WeekSummarizeInput): string {
  const lines: string[] = [];
  for (const entry of input.entries) {
    const md = entry.date.getUTCMonth() + 1;
    const dd = entry.date.getUTCDate();
    const kindLabel =
      entry.mediaKind === 'Image'
        ? '사진'
        : entry.mediaKind === 'Video'
          ? '영상'
          : entry.mediaKind === 'Mixed'
            ? '사진+영상'
            : '메모';
    const content = entry.rawContent.trim() || '(본문 없음)';
    lines.push(`- ${md}월 ${dd}일 (${entry.author}) ${kindLabel}: "${content}"`);
    for (const c of entry.comments) {
      lines.push(`  └ ${c.author} 댓글: "${c.text.trim()}"`);
    }
  }
  return lines.join('\n');
}

function parseGeminiJson(raw: string): WeekSummarizeResult {
  // Gemini가 때때로 ```json ... ``` 코드 펜스로 감싸 반환하므로 제거.
  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `[gemini] failed to parse JSON response: ${(err as Error).message}\nRaw: ${raw.slice(0, 200)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('[gemini] response is not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const weekTitle = obj.week_title;
  const essay = obj.essay;

  if (typeof weekTitle !== 'string' || typeof essay !== 'string') {
    throw new Error('[gemini] response missing week_title or essay');
  }
  return {
    weekTitle: weekTitle.trim(),
    essay: essay.trim(),
  };
}

/**
 * 주간 데이터를 Gemini에 전송해 제목과 에세이를 받는다.
 * 실패 시 지수 백오프로 최대 3회 재시도.
 */
export async function summarizeWeek(
  input: WeekSummarizeInput,
  options: { maxRetries?: number } = {},
): Promise<WeekSummarizeResult> {
  const maxRetries = options.maxRetries ?? 3;
  const client = getClient();
  const model = client.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      temperature: 0.7,
      responseMimeType: 'application/json',
    },
  });

  const mdStart = `${input.startDate.getUTCFullYear()}-${String(input.startDate.getUTCMonth() + 1).padStart(2, '0')}-${String(input.startDate.getUTCDate()).padStart(2, '0')}`;
  const mdEnd = `${input.endDate.getUTCFullYear()}-${String(input.endDate.getUTCMonth() + 1).padStart(2, '0')}-${String(input.endDate.getUTCDate()).padStart(2, '0')}`;

  const userPrompt = `주간 구간: ${mdStart} ~ ${mdEnd}

기록들:
${formatEntriesForPrompt(input)}`;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const res = await model.generateContent({
        contents: [
          { role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\n${userPrompt}` }] },
        ],
      });
      const text = res.response.text();
      return parseGeminiJson(text);
    } catch (err) {
      lastError = err;
      const delayMs = 2 ** attempt * 1000;
      console.warn(
        `[gemini] attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delayMs}ms`,
        (err as Error).message,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(
    `[gemini] exhausted ${maxRetries} retries: ${(lastError as Error)?.message ?? String(lastError)}`,
  );
}
