/**
 * Groq AI를 사용한 주간 에세이 생성.
 *
 * Groq는 OpenAI 호환 API를 제공하므로 별도 SDK 없이 fetch로 호출.
 * 무료 티어: 분당 30요청, 일 14,400요청 (충분).
 *
 * 환경변수:
 *   GROQ_API_KEY: https://console.groq.com/keys 에서 발급
 *   GROQ_MODEL: 모델명 (기본: llama-3.3-70b-versatile)
 */

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

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

function getApiKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('[ai] GROQ_API_KEY is not set');
  return key;
}

function getModel(): string {
  return process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
}

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

function parseJsonResponse(raw: string): WeekSummarizeResult {
  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `[ai] failed to parse JSON response: ${(err as Error).message}\nRaw: ${raw.slice(0, 200)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('[ai] response is not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const weekTitle = obj.week_title;
  const essay = obj.essay;

  if (typeof weekTitle !== 'string' || typeof essay !== 'string') {
    throw new Error('[ai] response missing week_title or essay');
  }
  return {
    weekTitle: weekTitle.trim(),
    essay: essay.trim(),
  };
}

/**
 * 주간 데이터를 Groq에 전송해 제목과 에세이를 받는다.
 * 실패 시 지수 백오프로 최대 3회 재시도.
 */
export async function summarizeWeek(
  input: WeekSummarizeInput,
  options: { maxRetries?: number } = {},
): Promise<WeekSummarizeResult> {
  const maxRetries = options.maxRetries ?? 3;
  const apiKey = getApiKey();
  const model = getModel();

  const mdStart = `${input.startDate.getUTCFullYear()}-${String(input.startDate.getUTCMonth() + 1).padStart(2, '0')}-${String(input.startDate.getUTCDate()).padStart(2, '0')}`;
  const mdEnd = `${input.endDate.getUTCFullYear()}-${String(input.endDate.getUTCMonth() + 1).padStart(2, '0')}-${String(input.endDate.getUTCDate()).padStart(2, '0')}`;

  const userPrompt = `주간 구간: ${mdStart} ~ ${mdEnd}

기록들:
${formatEntriesForPrompt(input)}`;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const res = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.7,
          response_format: { type: 'json_object' },
        }),
      });

      if (!res.ok) {
        const errorBody = await res.text();
        throw new Error(`Groq API ${res.status}: ${errorBody.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('[ai] empty response from Groq');

      return parseJsonResponse(content);
    } catch (err) {
      lastError = err;
      const delayMs = 2 ** attempt * 1000;
      console.warn(
        `[ai] attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delayMs}ms`,
        (err as Error).message,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(
    `[ai] exhausted ${maxRetries} retries: ${(lastError as Error)?.message ?? String(lastError)}`,
  );
}
