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
  captions: Array<{ index: number; caption: string }>;
}

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ────────────────────────────────────────────────────────────────
// Open-Meteo (무료, 키 불필요) — 서울 기준 날씨 조회
// ────────────────────────────────────────────────────────────────

const WEATHER_CODES: Record<number, string> = {
  0: '맑음', 1: '대체로 맑음', 2: '약간 흐림', 3: '흐림',
  45: '안개', 48: '짙은 안개',
  51: '가벼운 이슬비', 53: '이슬비', 55: '짙은 이슬비',
  61: '약한 비', 63: '비', 65: '강한 비',
  71: '약한 눈', 73: '눈', 75: '강한 눈',
  80: '소나기', 81: '강한 소나기', 82: '폭우',
  95: '뇌우', 96: '우박 뇌우',
};

interface DayWeather {
  date: string;
  maxTemp: number;
  minTemp: number;
  description: string;
}

async function fetchWeather(dates: Date[]): Promise<Map<string, DayWeather>> {
  const result = new Map<string, DayWeather>();
  if (dates.length === 0) return result;

  const uniqueDates = [...new Set(dates.map((d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }))].sort();

  const startDate = uniqueDates[0]!;
  const endDate = uniqueDates[uniqueDates.length - 1]!;

  try {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=37.5665&longitude=126.9780&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=Asia/Seoul`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('[weather] fetch failed:', res.status);
      return result;
    }
    const data = (await res.json()) as {
      daily?: {
        time?: string[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        weather_code?: number[];
      };
    };
    const daily = data.daily;
    if (!daily?.time) return result;

    for (let i = 0; i < daily.time.length; i += 1) {
      const date = daily.time[i]!;
      const maxTemp = daily.temperature_2m_max?.[i] ?? 0;
      const minTemp = daily.temperature_2m_min?.[i] ?? 0;
      const code = daily.weather_code?.[i] ?? 0;
      result.set(date, {
        date,
        maxTemp: Math.round(maxTemp),
        minTemp: Math.round(minTemp),
        description: WEATHER_CODES[code] ?? '알 수 없음',
      });
    }
  } catch (err) {
    console.warn('[weather] error:', (err as Error).message);
  }
  return result;
}

function getApiKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('[ai] GROQ_API_KEY is not set');
  return key;
}

function getModel(): string {
  return process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
}

const SYSTEM_PROMPT = `당신은 24개월 아이 "원우"의 사진 앨범 캡션을 다듬는 편집자입니다.

## 절대 규칙 (위반 시 실패)
1. 입력 데이터에 없는 사실을 절대 추가하지 마세요. 한 글자도.
2. 누가 했는지(작성자)를 바꾸지 마세요. "엄마"가 올린 사진을 "아빠"가 한 것처럼 쓰지 마세요.
3. 추측하지 마세요. "아마 ~했을 것이다", "~인 것 같다"는 금지.
4. 이모지 금지. "사랑스러운", "너무나" 같은 상투적 수식어 금지.
5. 입력에 작성자가 "아빠"인데 사진 내용에 아빠가 언급 안 되면, 아빠가 그 장소에 있었다고 쓰지 마세요. 아빠는 사진을 "올린 사람"일 뿐, 사진 속 인물이 아닐 수 있습니다.

## 할 일
각 사진의 원본 메모와 댓글을 바탕으로:
1. week_title: 이번 주를 대표하는 10자 내외 제목 (입력에 있는 사건만)
2. essay: 2~3문장. 입력에 있는 사실만 연결. "~했다" 서술체.
3. captions: 각 사진(index 번호)에 대한 1문장 캡션. 해당 사진의 메모와 댓글에 있는 내용만 사용.

## 출력 형식 (JSON만, 다른 텍스트 금지)
{
  "week_title": "...",
  "essay": "...",
  "captions": [
    {"index": 0, "caption": "..."},
    {"index": 1, "caption": "..."}
  ]
}`;
function formatEntriesForPrompt(input: WeekSummarizeInput): string {
  const lines: string[] = [];
  for (let i = 0; i < input.entries.length; i += 1) {
    const entry = input.entries[i]!;
    const md = entry.date.getUTCMonth() + 1;
    const dd = entry.date.getUTCDate();
    const hh = String(entry.date.getUTCHours()).padStart(2, '0');
    const mm = String(entry.date.getUTCMinutes()).padStart(2, '0');
    const kindLabel =
      entry.mediaKind === 'Image'
        ? '사진'
        : entry.mediaKind === 'Video'
          ? '영상'
          : entry.mediaKind === 'Mixed'
            ? '사진+영상'
            : '메모';
    const content = entry.rawContent.trim() || '(본문 없음)';
    lines.push(`[${i}] ${md}월 ${dd}일 ${hh}:${mm} (올린사람: ${entry.author}) ${kindLabel}: "${content}"`);
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
  const rawCaptions = Array.isArray(obj.captions) ? obj.captions : [];
  const captions = rawCaptions
    .filter((c: unknown): c is { index: number; caption: string } =>
      typeof c === 'object' && c !== null &&
      typeof (c as Record<string, unknown>).index === 'number' &&
      typeof (c as Record<string, unknown>).caption === 'string',
    )
    .map((c) => ({ index: c.index, caption: c.caption.trim() }));

  return {
    weekTitle: weekTitle.trim(),
    essay: essay.trim(),
    captions,
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

  // 날씨 데이터 수집 (실패해도 진행)
  const weatherMap = await fetchWeather(input.entries.map((e) => e.date));

  const mdStart = `${input.startDate.getUTCFullYear()}-${String(input.startDate.getUTCMonth() + 1).padStart(2, '0')}-${String(input.startDate.getUTCDate()).padStart(2, '0')}`;
  const mdEnd = `${input.endDate.getUTCFullYear()}-${String(input.endDate.getUTCMonth() + 1).padStart(2, '0')}-${String(input.endDate.getUTCDate()).padStart(2, '0')}`;

  // 날씨 정보 요약
  let weatherInfo = '';
  if (weatherMap.size > 0) {
    const weatherLines = Array.from(weatherMap.values())
      .map((w) => `${w.date}: ${w.description}, ${w.minTemp}~${w.maxTemp}°C`)
      .join('\n');
    weatherInfo = `\n\n날씨 정보 (서울):\n${weatherLines}`;
  }

  const userPrompt = `주간 구간: ${mdStart} ~ ${mdEnd}${weatherInfo}

기록들 (번호 = 사진 index):
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
