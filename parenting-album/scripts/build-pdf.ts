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
}

interface PhotoPage {
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
  };
  weeks: WeekView[];
  backCover: {
    url?: string;
  };
}

function formatDate(d: Date): string {
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${m}월 ${day}일`;
}

const PHOTOS_PER_PAGE = 1;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function entryToSlot(entry: RawEntryRow): PhotoSlot | null {
  // 인쇄용(3000px, q=100) 우선. PDF 용량 최적화 + 충분한 인쇄 품질.
  const imageUrl = entry.mediaPrintUrl ?? entry.mediaUrl;
  if (!imageUrl) return null;
  return {
    imageUrl,
    alt: entry.rawContent || '사진',
    author: entry.author || '가족',
    dateLabel: formatDate(entry.date),
    content: entry.rawContent || '',
  };
}

function buildViewModel(
  year: number,
  month: number,
  entries: RawEntryRow[],
  weeklySummaries: WeeklySummaryRow[],
  digitalUrl?: string,
): AlbumViewModel {
  // 사진 기록만 (Video/Text 제외)
  const photoEntries = entries.filter(
    (e) => e.type === 'Image' || e.type === 'Mixed',
  );

  // 주차별로 그룹핑
  const byWeek = new Map<string, RawEntryRow[]>();
  for (const e of photoEntries) {
    const wid = isoWeekLabel(e.date);
    const list = byWeek.get(wid) ?? [];
    list.push(e);
    byWeek.set(wid, list);
  }

  const summaryByWeek = new Map<string, WeeklySummaryRow>();
  for (const s of weeklySummaries) summaryByWeek.set(s.weekId, s);

  const weeks: WeekView[] = Array.from(byWeek.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekId, weekEntries]) => {
      const summary = summaryByWeek.get(weekId);
      const slots = weekEntries
        .sort((a, b) => a.date.getTime() - b.date.getTime())
        .map(entryToSlot)
        .filter((s): s is PhotoSlot => s !== null);
      const photoPages: PhotoPage[] = chunk(slots, PHOTOS_PER_PAGE).map((group) => ({
        slots: group,
      }));
      return {
        weekId,
        weekLabel: weekId,
        title: summary?.weekTitle || weekId,
        essay: summary?.essay || '(이번 주 요약이 아직 준비되지 않았어요)',
        photoPages,
      };
    });

  return {
    cover: {
      title: `원우의 ${month}월`,
      subtitle: `${photoEntries.length}장의 사진 · ${weeks.length}개 주차`,
      dateLabel: `${year}. ${String(month).padStart(2, '0')}`,
    },
    weeks,
    backCover: {
      url: digitalUrl,
    },
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
  const entries = [...allEntries].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  console.log(
    `[pdf] fetched ${entries.length} entries, ${weeklySummaries.length} weekly summaries`,
  );

  if (entries.length === 0) {
    console.error(`[pdf] no entries for ${year}-${month}, aborting`);
    console.error(`[pdf] hint: DB has data (diag found ${diagRes.results.length}), but date filter excluded everything.`);
    process.exit(1);
  }

  // 2. View model
  const viewModel = buildViewModel(year, month, entries, weeklySummaries, opts.digitalUrl);

  // 3. Load template
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
