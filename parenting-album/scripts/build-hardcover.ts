/**
 * 스냅스 하드커버 포토북용 이미지 세트 생성.
 *
 * 출력 구조:
 *   dist/hardcover/2026-04/
 *     01_cover.png            ← 표지
 *     02_essay_w15.png        ← 주간 에세이 카드
 *     03_photo_001.jpg        ← 사진 + 하단 캡션
 *     04_photo_002.jpg
 *     05_essay_w16.png        ← 다음 주 에세이
 *     06_photo_003.jpg
 *     ...
 *     99_backcover.png        ← 뒷표지
 *
 *   dist/originals/2026-04/
 *     001_20260411_dad.jpg    ← 원본 사진 (캡션 없이)
 *     002_20260411_mom.jpg
 *     ...
 *
 * 사용:
 *   npm run build:hardcover -- --month=2026-04
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import puppeteer, { type Browser, type Page } from 'puppeteer';

import {
  queryRawEntriesByMonth,
  queryWeeklySummariesByMonth,
  type RawEntryRow,
  type WeeklySummaryRow,
} from '../lib/notion.js';

loadDotenv({ path: '.env.local' });
loadDotenv({ path: '.env' });

// ────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────

/** 스냅스 A5 하드커버 기준 (세로, 300DPI) */
const PAGE_W = 1800;
const PAGE_H = 2400;

// ────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────

function parseCli(argv: string[]): { month: string; outputDir: string } {
  const now = new Date();
  let month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  let outputDir = process.env.PDF_OUTPUT_DIR ?? './dist';
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--month=')) month = arg.slice('--month='.length);
    else if (arg.startsWith('--output=')) outputDir = arg.slice('--output='.length);
  }
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`--month=${month} invalid`);
  return { month, outputDir };
}

// ────────────────────────────────────────────────────────────────
// ISO Week
// ────────────────────────────────────────────────────────────────

function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// ────────────────────────────────────────────────────────────────
// HTML escape
// ────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ────────────────────────────────────────────────────────────────
// Render helpers
// ────────────────────────────────────────────────────────────────

const FONTS_CSS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Gaegu:wght@400;700&family=Gowun+Batang:wght@400;700&display=swap" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/variable/pretendardvariable.min.css" rel="stylesheet">
`;

const BASE_STYLE = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: ${PAGE_W}px; height: ${PAGE_H}px; overflow: hidden; background: #fdfaf1; }
`;

async function renderToFile(page: Page, html: string, outPath: string, format: 'png' | 'jpeg' = 'png'): Promise<void> {
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 });
  await page.screenshot({ path: outPath, type: format, quality: format === 'jpeg' ? 92 : undefined });
}

function coverHtml(monthLabel: string, photoCount: number): string {
  return `<!doctype html><html><head>${FONTS_CSS}<style>${BASE_STYLE}
  body { display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; background: linear-gradient(170deg, #fdfaf1 0%, #f5ecd6 100%); }
  .title { font-family: 'Gaegu', cursive; font-size: 120px; font-weight: 700; color: #2a2113; margin-bottom: 20px; }
  .line { width: 200px; height: 2px; background: #b8a576; margin: 30px 0; }
  .sub { font-family: 'Gowun Batang', serif; font-size: 48px; color: #5c4e35; }
  .date { font-family: 'Pretendard Variable', sans-serif; font-size: 32px; color: #8a7d5f; margin-top: 40px; letter-spacing: 0.1em; }
  </style></head><body>
  <div class="title">${esc(monthLabel)}</div>
  <div class="line"></div>
  <div class="sub">${photoCount}장의 사진</div>
  <div class="date">${esc(monthLabel.replace('원우의 ', ''))}</div>
  </body></html>`;
}

function essayCardHtml(weekTitle: string, essay: string, dateRange: string): string {
  return `<!doctype html><html><head>${FONTS_CSS}<style>${BASE_STYLE}
  body { display: flex; flex-direction: column; justify-content: center; padding: 120px 100px;
    background: linear-gradient(170deg, #fdfaf1 0%, #f5ecd6 100%); }
  .week-label { font-family: 'Pretendard Variable', sans-serif; font-size: 28px; color: #8a7d5f;
    text-transform: uppercase; letter-spacing: 0.12em; margin-bottom: 24px; }
  .title { font-family: 'Gaegu', cursive; font-size: 80px; font-weight: 700; color: #2a2113;
    line-height: 1.2; margin-bottom: 60px; }
  .essay { font-family: 'Gowun Batang', serif; font-size: 36px; line-height: 2; color: #332b1c;
    white-space: pre-wrap; }
  </style></head><body>
  <p class="week-label">${esc(dateRange)}</p>
  <h2 class="title">${esc(weekTitle)}</h2>
  <p class="essay">${esc(essay)}</p>
  </body></html>`;
}

function captionedPhotoHtml(imageUrl: string, author: string, date: string, caption: string): string {
  return `<!doctype html><html><head>${FONTS_CSS}<style>${BASE_STYLE}
  body { display: flex; flex-direction: column; background: #fff; }
  .photo-area { flex: 1; display: flex; align-items: center; justify-content: center;
    overflow: hidden; background: #000; min-height: 0; }
  .photo-area img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .caption-bar { padding: 40px 60px; background: #fdfaf1; border-top: 2px solid #e8e1cd; }
  .caption-meta { font-family: 'Pretendard Variable', sans-serif; font-size: 28px; color: #8a7d5f; margin-bottom: 12px; }
  .caption-author { color: #c86a3f; font-weight: 600; }
  .caption-text { font-family: 'Gowun Batang', serif; font-size: 32px; color: #332b1c;
    line-height: 1.6; font-style: italic; }
  </style></head><body>
  <div class="photo-area"><img src="${esc(imageUrl)}" alt=""></div>
  <div class="caption-bar">
    <div class="caption-meta"><span class="caption-author">${esc(author)}</span> · ${esc(date)}</div>
    ${caption ? `<div class="caption-text">"${esc(caption)}"</div>` : ''}
  </div>
  </body></html>`;
}

function backCoverHtml(albumUrl: string): string {
  return `<!doctype html><html><head>${FONTS_CSS}<style>${BASE_STYLE}
  body { display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; background: linear-gradient(170deg, #f5ecd6 0%, #fdfaf1 100%); }
  .note { font-family: 'Pretendard Variable', sans-serif; font-size: 28px; color: #8a7d5f;
    max-width: 600px; line-height: 1.8; }
  .url { font-family: 'Pretendard Variable', sans-serif; font-size: 24px; color: #8a7d5f;
    margin-top: 40px; letter-spacing: 0.05em; }
  </style></head><body>
  <p class="note">이 앨범의 사진과 영상, 가족들의 댓글은<br>디지털 버전에서 언제든 다시 볼 수 있어요.</p>
  ${albumUrl ? `<p class="url">${esc(albumUrl)}</p>` : ''}
  </body></html>`;
}

// ────────────────────────────────────────────────────────────────
// Download helper
// ────────────────────────────────────────────────────────────────

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  const [yearStr, monthStr] = opts.month.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const monthLabel = `원우의 ${month}월`;

  console.log(`[hardcover] building for ${year}-${month}`);

  // 1. Fetch data
  const [entriesDraft, entriesSummarized, entriesPrinted, weeklySummaries] = await Promise.all([
    queryRawEntriesByMonth(year, month, 'Draft'),
    queryRawEntriesByMonth(year, month, 'Summarized'),
    queryRawEntriesByMonth(year, month, 'Printed'),
    queryWeeklySummariesByMonth(year, month),
  ]);
  const allEntries = [...entriesDraft, ...entriesSummarized, ...entriesPrinted]
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const photoEntries = allEntries.filter(
    (e) => (e.type === 'Image' || e.type === 'Mixed') && (e.mediaUrl || e.mediaPrintUrl),
  );
  console.log(`[hardcover] ${photoEntries.length} photos, ${weeklySummaries.length} weekly summaries`);

  if (photoEntries.length === 0) {
    console.error('[hardcover] no photos found, aborting');
    process.exit(1);
  }

  // 2. Group by week
  const byWeek = new Map<string, RawEntryRow[]>();
  for (const e of photoEntries) {
    const wid = isoWeekLabel(e.date);
    const list = byWeek.get(wid) ?? [];
    list.push(e);
    byWeek.set(wid, list);
  }
  const summaryByWeek = new Map<string, WeeklySummaryRow>();
  for (const s of weeklySummaries) summaryByWeek.set(s.weekId, s);
  const weekIds = Array.from(byWeek.keys()).sort();

  // 3. Prepare output dirs
  const hardcoverDir = path.resolve(opts.outputDir, 'hardcover', opts.month);
  const originalsDir = path.resolve(opts.outputDir, 'originals', opts.month);
  await fs.mkdir(hardcoverDir, { recursive: true });
  await fs.mkdir(originalsDir, { recursive: true });

  // 4. Launch Puppeteer
  console.log('[hardcover] launching Puppeteer...');
  const browser: Browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page: Page = await browser.newPage();
  await page.setViewport({ width: PAGE_W, height: PAGE_H, deviceScaleFactor: 1 });

  let fileIdx = 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');

  try {
    // 5. Cover
    console.log('[hardcover] rendering cover...');
    await renderToFile(page, coverHtml(monthLabel, photoEntries.length),
      path.join(hardcoverDir, `${pad(fileIdx++)}_cover.png`));

    // 6. Weekly essay + photos
    let photoNum = 0;
    for (const weekId of weekIds) {
      const weekEntries = byWeek.get(weekId)!;
      const summary = summaryByWeek.get(weekId);

      // Essay card
      if (summary?.essay) {
        const firstDate = weekEntries[0]!.date;
        const lastDate = weekEntries[weekEntries.length - 1]!.date;
        const dateRange = `${firstDate.getUTCMonth() + 1}월 ${firstDate.getUTCDate()}일 – ${lastDate.getUTCDate()}일`;

        console.log(`[hardcover] rendering essay: ${summary.weekTitle}`);
        await renderToFile(page, essayCardHtml(summary.weekTitle, summary.essay, dateRange),
          path.join(hardcoverDir, `${pad(fileIdx++)}_essay_${weekId}.png`));
      }

      // Photos
      for (const entry of weekEntries) {
        photoNum++;
        const imageUrl = entry.mediaUrl ?? entry.mediaPrintUrl!;
        const d = entry.date;
        const dateLabel = `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`;
        const author = entry.author || '가족';
        const caption = entry.rawContent || '';

        // Hardcover version (with caption)
        console.log(`[hardcover] rendering photo ${photoNum}/${photoEntries.length}`);
        await renderToFile(
          page,
          captionedPhotoHtml(imageUrl, author, dateLabel, caption),
          path.join(hardcoverDir, `${pad(fileIdx++)}_photo_${pad3(photoNum)}.jpg`),
          'jpeg',
        );

        // Original download
        const ext = entry.type === 'Video' ? 'mp4' : 'jpg';
        const origFilename = `${pad3(photoNum)}_${dateLabel.replace(/\./g, '')}_${author}.${ext}`;
        try {
          await downloadFile(imageUrl, path.join(originalsDir, origFilename));
        } catch (e) {
          console.warn(`[hardcover] original download failed: ${origFilename}`, (e as Error).message);
        }
      }
    }

    // 7. Back cover
    const albumUrl = `https://focuskit-five.vercel.app/album/${opts.month}`;
    console.log('[hardcover] rendering back cover...');
    await renderToFile(page, backCoverHtml(albumUrl),
      path.join(hardcoverDir, `${pad(fileIdx++)}_backcover.png`));

  } finally {
    await browser.close();
  }

  // 8. Summary
  const hardcoverFiles = await fs.readdir(hardcoverDir);
  const originalFiles = await fs.readdir(originalsDir);
  console.log(`\n[hardcover] ✓ 완료!`);
  console.log(`  하드커버용: ${hardcoverDir} (${hardcoverFiles.length}개 파일)`);
  console.log(`  원본 사진:  ${originalsDir} (${originalFiles.length}개 파일)`);
  console.log(`\n  → 스냅스에서 "${hardcoverDir}" 폴더의 파일을 전부 업로드 → 자동 배치 → 인쇄`);
}

main().catch((err) => {
  console.error('[hardcover] fatal', err);
  process.exit(1);
});
