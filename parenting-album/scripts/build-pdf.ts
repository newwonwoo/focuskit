/**
 * 로컬 PDF 빌더.
 *
 * 사용 예:
 *   npm run build:pdf -- --month=2026-04
 *   npm run build:pdf -- --month=2026-04 --digital-url=https://wonwoo.example.com/album/2026-04
 *
 * 동작:
 *   1. Notion에서 해당 월의 사진 기록(Summarized 또는 Printed) + Weekly_Summary fetch
 *   2. Handlebars 템플릿(templates/album.hbs)에 주입
 *   3. Puppeteer로 HTML → A5 PDF 변환
 *   4. dist/wonwoo-album-YYYY-MM.pdf 저장
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';
import Handlebars from 'handlebars';
import puppeteer from 'puppeteer';

import {
  queryRawEntriesByMonth,
  queryWeeklySummariesByMonth,
  type RawEntryRow,
  type WeeklySummaryRow,
} from '../lib/notion.js';

loadDotenv({ path: '.env.local' });
loadDotenv({ path: '.env' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────

interface CliOptions {
  month: string; // YYYY-MM
  digitalUrl?: string;
  outputDir: string;
}

function parseCli(argv: string[]): CliOptions {
  const now = new Date();
  let month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  let digitalUrl: string | undefined;
  let outputDir = process.env.PDF_OUTPUT_DIR ?? './dist';

  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--month=')) {
      month = arg.slice('--month='.length);
    } else if (arg.startsWith('--digital-url=')) {
      digitalUrl = arg.slice('--digital-url='.length);
    } else if (arg.startsWith('--output=')) {
      outputDir = arg.slice('--output='.length);
    }
  }

  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`--month=${month} 은 올바르지 않습니다. 예: 2026-04`);
  }
  return { month, digitalUrl, outputDir };
}

// ────────────────────────────────────────────────────────────────
// ISO Week helper
// ────────────────────────────────────────────────────────────────

function isoWeekLabel(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// ────────────────────────────────────────────────────────────────
// View model builder
// ────────────────────────────────────────────────────────────────

interface PhotoSlot {
  imageUrl: string;
  alt: string;
  author: string;
  dateLabel: string;
  content: string;
  qualityScore: number;
  hasCaption: boolean;
  isPortrait: boolean;
}

export type TemplateCode = 'T1' | 'T2' | 'T3' | 'T4' | 'T5';

interface PhotoPage {
  template: TemplateCode;
  slots: PhotoSlot[];
}

interface WeekView {
  weekId: string;
  weekLabel: string;
  title: string;
  essay: string;
  photoPages: PhotoPage[];
}

interface AlbumViewModel {
  cover: {
    title: string;
    subtitle: string;
    dateLabel: string;
    coverPhotoUrl?: string;
  };
  intro: {
    totalPhotos: number;
    totalComments: number;
    firstDate: string;
    lastDate: string;
    headline?: string;
  };
  weeks: WeekView[];
  retrospect: {
    heroPhotoUrl?: string;
    headline?: string;
    summary?: string;
  };
  backCover: {
    url?: string;
  };
  pageCount: number;
}

function formatDate(d: Date): string {
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${m}월 ${day}일`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Cloudinary URL에 크롭/리사이즈 파라미터 추가.
 * - 기본 (가로 세로 무관): A5 비율 근접 c_fill
 * - portrait_only=true: 세로 비율로 포트레이트 채움
 */
function transformUrl(
  rawUrl: string,
  opts: { width: number; quality: number; ratio?: string } = { width: 1200, quality: 60 },
): string {
  if (!rawUrl.includes('/upload/')) return rawUrl;
  const ratio = opts.ratio ?? '148:195';
  return rawUrl.replace(
    '/upload/',
    `/upload/c_fill,g_auto,ar_${ratio},w_${opts.width},q_${opts.quality},f_jpg/`,
  );
}

function entryToSlot(entry: RawEntryRow): PhotoSlot | null {
  const rawUrl = entry.mediaPrintUrl ?? entry.mediaUrl;
  if (!rawUrl) return null;
  const imageUrl = transformUrl(rawUrl);
  const isPortrait =
    typeof entry.mediaWidth === 'number' && typeof entry.mediaHeight === 'number'
      ? entry.mediaHeight > entry.mediaWidth
      : true; // 알 수 없으면 세로로 가정 (카톡 기본)
  return {
    imageUrl,
    alt: entry.rawContent || '사진',
    author: entry.author || '가족',
    dateLabel: formatDate(entry.takenDate ?? entry.date),
    content: entry.rawContent || '',
    qualityScore: entry.qualityScore ?? 50,
    hasCaption: (entry.rawContent?.trim().length ?? 0) > 0,
    isPortrait,
  };
}

/**
 * 엔트리들의 시간순 정렬. takenDate 우선, 없으면 date.
 */
function sortByTakenTime(a: RawEntryRow, b: RawEntryRow): number {
  const da = (a.takenDate ?? a.date).getTime();
  const db = (b.takenDate ?? b.date).getTime();
  return da - db;
}

/**
 * 사진 1장 페이지를 만드는 규칙:
 * - 점수 88+ & 대표성 있음 → T1 (풀블리드)
 * - 캡션 있음 → T2 (사진+캡션형)
 * - 기본 → T1
 */
function pickTemplateForSingle(slot: PhotoSlot): TemplateCode {
  if (slot.hasCaption) return 'T2';
  return 'T1';
}

/**
 * 주차의 사진 N장을 페이지로 배치.
 * 규칙:
 * - 대표컷(최고점) 1장 → T1 or T2 (대표페이지)
 * - 나머지는 점수 묶어서 T3/T4/T5에 분배
 * - 1장: T1 or T2
 * - 2장: T3 (2장 균등)
 * - 3장: T4 (3장 혼합)
 * - 4장 이상: 4장씩 T5 (그리드) + 남은 장수로 T3/T4
 */
function layoutWeekPhotos(slots: PhotoSlot[]): PhotoPage[] {
  const pages: PhotoPage[] = [];
  if (slots.length === 0) return pages;

  // 1. 최고점 사진을 대표페이지로
  const sortedByScore = [...slots].sort((a, b) => b.qualityScore - a.qualityScore);
  const hero = sortedByScore[0]!;
  pages.push({ template: pickTemplateForSingle(hero), slots: [hero] });

  // 2. 나머지는 시간순으로 페이지에 배치
  const remaining = slots.filter((s) => s !== hero);
  if (remaining.length === 0) return pages;

  // 2-a. 4장씩 그리드로 묶기 (최대 효율)
  let remainingCount = remaining.length;
  let i = 0;
  while (remainingCount >= 4) {
    pages.push({ template: 'T5', slots: remaining.slice(i, i + 4) });
    i += 4;
    remainingCount -= 4;
  }
  // 2-b. 남은 1~3장
  if (remainingCount === 3) {
    pages.push({ template: 'T4', slots: remaining.slice(i, i + 3) });
  } else if (remainingCount === 2) {
    pages.push({ template: 'T3', slots: remaining.slice(i, i + 2) });
  } else if (remainingCount === 1) {
    pages.push({
      template: pickTemplateForSingle(remaining[i]!),
      slots: [remaining[i]!],
    });
  }

  return pages;
}

/**
 * 페이지 수 추정 (표지1 + intro1 + essay(주차수) + photoPages + retrospect1 + backCover1).
 */
function estimateTotalPages(weeks: WeekView[]): number {
  let total = 1; // cover
  total += 1; // intro
  for (const w of weeks) {
    if (w.essay) total += 1; // essay page
    total += w.photoPages.length;
  }
  total += 1; // retrospect
  total += 1; // back cover
  return total;
}

/**
 * 24p/40p/60p 목표에 맞춰 페이지 압축.
 * 목표 페이지 수를 넘으면 낮은 점수 사진부터 페이지 제거.
 */
function targetPageCount(photoCount: number): 24 | 40 | 60 {
  if (photoCount <= 20) return 24;
  if (photoCount <= 50) return 40;
  return 60;
}

/**
 * 표지 후보 선정:
 * - quality_score 최고
 * - 해상도 2000px+ 우선
 * - 세로 사진 우선 (A5 세로)
 */
function pickCoverPhoto(entries: RawEntryRow[]): string | undefined {
  const candidates = entries
    .filter((e) => (e.type === 'Image' || e.type === 'Mixed') && (e.mediaUrl || e.mediaPrintUrl))
    .sort((a, b) => {
      const scoreDiff = (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      const aPortrait =
        typeof a.mediaWidth === 'number' && typeof a.mediaHeight === 'number'
          ? a.mediaHeight > a.mediaWidth
          : false;
      const bPortrait =
        typeof b.mediaWidth === 'number' && typeof b.mediaHeight === 'number'
          ? b.mediaHeight > b.mediaWidth
          : false;
      if (aPortrait !== bPortrait) return bPortrait ? 1 : -1;
      return (b.mediaWidth ?? 0) - (a.mediaWidth ?? 0);
    });
  const top = candidates[0];
  if (!top) return undefined;
  const raw = top.mediaPrintUrl ?? top.mediaUrl;
  if (!raw) return undefined;
  return transformUrl(raw, { width: 1600, quality: 80, ratio: '148:210' });
}

/**
 * 회고 페이지 hero 사진 (표지 2위 점수 사진).
 */
function pickHeroPhoto(entries: RawEntryRow[], excludeUrl?: string): string | undefined {
  const candidates = entries
    .filter((e) => (e.type === 'Image' || e.type === 'Mixed') && (e.mediaUrl || e.mediaPrintUrl))
    .sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0));
  for (const c of candidates) {
    const raw = c.mediaPrintUrl ?? c.mediaUrl;
    if (!raw) continue;
    const url = transformUrl(raw, { width: 1500, quality: 75 });
    if (url !== excludeUrl) return url;
  }
  return undefined;
}

function buildViewModel(
  year: number,
  month: number,
  entries: RawEntryRow[],
  weeklySummaries: WeeklySummaryRow[],
  commentsByEntry: Map<string, number>,
  digitalUrl?: string,
): AlbumViewModel {
  // 1. 사진 필터링
  const photoEntries = entries
    .filter((e) => e.type === 'Image' || e.type === 'Mixed')
    .filter((e) => !e.isHidden)
    .filter((e) => !e.excludeCode || e.excludeCode === 'LOW_PRINT_QUALITY');

  // 2. 시간순 정렬
  const sorted = [...photoEntries].sort(sortByTakenTime);

  // 3. 주차별 그룹
  const byWeek = new Map<string, RawEntryRow[]>();
  for (const e of sorted) {
    const refDate = e.takenDate ?? e.date;
    const wid = isoWeekLabel(refDate);
    const list = byWeek.get(wid) ?? [];
    list.push(e);
    byWeek.set(wid, list);
  }

  const summaryByWeek = new Map<string, WeeklySummaryRow>();
  for (const s of weeklySummaries) summaryByWeek.set(s.weekId, s);

  // 4. 각 주차를 WeekView로 변환
  const weeks: WeekView[] = Array.from(byWeek.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekId, weekEntries]) => {
      const summary = summaryByWeek.get(weekId);
      const slots = weekEntries
        .map(entryToSlot)
        .filter((s): s is PhotoSlot => s !== null);
      const photoPages = layoutWeekPhotos(slots);
      const firstDate = weekEntries[0]!;
      const refDate = firstDate.takenDate ?? firstDate.date;
      return {
        weekId,
        weekLabel: weekId,
        title:
          summary?.weekTitle ||
          `${refDate.getUTCMonth() + 1}월 ${refDate.getUTCDate()}일 주`,
        essay: summary?.essay || '',
        photoPages,
      };
    });

  // 5. 통계
  const totalPhotos = photoEntries.length;
  const totalComments = Array.from(commentsByEntry.values()).reduce((sum, n) => sum + n, 0);
  const sortedDates = sorted.map((e) => e.takenDate ?? e.date).sort((a, b) => a.getTime() - b.getTime());
  const firstDate = sortedDates[0];
  const lastDate = sortedDates[sortedDates.length - 1];

  // 6. 표지/회고 사진 선정
  const coverPhotoUrl = pickCoverPhoto(photoEntries);
  const heroPhotoUrl = pickHeroPhoto(photoEntries, coverPhotoUrl);

  // 7. 헤드라인: 가장 최근 주간 요약의 제목 우선
  const latestSummary = weeklySummaries
    .slice()
    .sort((a, b) => b.weekId.localeCompare(a.weekId))[0];
  const headline = latestSummary?.weekTitle;
  const retroSummary = latestSummary?.essay;

  return {
    cover: {
      title: `원우의 ${month}월`,
      subtitle: `${totalPhotos}장의 사진 · ${weeks.length}개 주차`,
      dateLabel: `${year}. ${String(month).padStart(2, '0')}`,
      coverPhotoUrl,
    },
    intro: {
      totalPhotos,
      totalComments,
      firstDate: firstDate ? formatDate(firstDate) : '-',
      lastDate: lastDate ? formatDate(lastDate) : '-',
      headline,
    },
    weeks,
    retrospect: {
      heroPhotoUrl,
      headline,
      summary: retroSummary,
    },
    backCover: {
      url: digitalUrl,
    },
    pageCount: estimateTotalPages(weeks),
  };
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  const [yearStr, monthStr] = opts.month.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  console.log(`[pdf] building album for ${year}-${month}`);

  // 1. Notion 조회
  // 먼저 필터 없이 DB 전체 조회 (진단용)
  const { Client } = await import('@notionhq/client');
  const diagClient = new Client({ auth: process.env.NOTION_TOKEN });
  const dbId = process.env.NOTION_DB_RAW_ID!;
  console.log(`[pdf diag] querying DB ${dbId} without any filter...`);
  const diagRes = await diagClient.databases.query({
    database_id: dbId,
    page_size: 5,
  });
  console.log(`[pdf diag] total results (no filter): ${diagRes.results.length}, has_more: ${diagRes.has_more}`);
  if (diagRes.results.length > 0) {
    const first = diagRes.results[0] as any;
    const dateVal = first.properties?.Date?.date?.start ?? 'NO DATE';
    const typeVal = first.properties?.Type?.select?.name ?? 'NO TYPE';
    const statusVal = first.properties?.Status?.status?.name ?? 'NO STATUS';
    console.log(`[pdf diag] first row: date=${dateVal}, type=${typeVal}, status=${statusVal}`);
  }

  // 날짜 범위 확인
  const fromDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const toDate = new Date(Date.UTC(year, month, 0, 23, 59, 59));
  console.log(`[pdf diag] date range: ${fromDate.toISOString()} ~ ${toDate.toISOString()}`);

  const [allEntries, weeklySummaries] = await Promise.all([
    queryRawEntriesByMonth(year, month),
    queryWeeklySummariesByMonth(year, month),
  ]);
  // v2: takenDate 우선, 없으면 date로 fallback 정렬
  const entries = [...allEntries].sort((a, b) => {
    const da = (a.takenDate ?? a.date).getTime();
    const db = (b.takenDate ?? b.date).getTime();
    return da - db;
  });

  // v2: 댓글 수 맵 (통계용)
  const commentList = await import('../lib/notion.js').then((m) =>
    m.listCommentsForEntries(entries.map((e) => e.pageId)),
  );
  const commentsCount = new Map<string, number>();
  for (const [entryId, comments] of commentList) {
    commentsCount.set(entryId, comments.length);
  }
  console.log(
    `[pdf] fetched ${entries.length} entries, ${weeklySummaries.length} weekly summaries`,
  );

  if (entries.length === 0) {
    console.error(`[pdf] no entries for ${year}-${month}, aborting`);
    console.error(`[pdf] hint: DB has data (diag found ${diagRes.results.length}), but date filter excluded everything.`);
    process.exit(1);
  }

  // 2. View model
  const viewModel = buildViewModel(year, month, entries, weeklySummaries, commentsCount, opts.digitalUrl);
  console.log(
    `[pdf] layout: ${viewModel.weeks.length} weeks, ~${viewModel.pageCount} pages`,
  );

  // 3. Load template (Handlebars helper 등록)
  Handlebars.registerHelper('eq', (a, b) => a === b);

  const templatePath = path.join(PROJECT_ROOT, 'templates', 'album.hbs');
  const templateSource = await fs.readFile(templatePath, 'utf-8');
  const template = Handlebars.compile(templateSource, { noEscape: false });
  const html = template(viewModel);

  // 4. Puppeteer render to PDF
  const outputDir = path.resolve(opts.outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(
    outputDir,
    `wonwoo-album-${opts.month}.pdf`,
  );

  console.log('[pdf] launching Puppeteer...');
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 90_000 });
    // 이미지 로드 완료 대기 (networkidle0가 커버하지만 안전하게)
    await page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(
        imgs.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          });
        }),
      );
    });
    await page.pdf({
      path: outputPath,
      format: 'A5',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    console.log(`[pdf] ✓ saved ${outputPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[pdf] fatal', err);
  process.exit(1);
});
