/**
 * 주간 Gemini 요약 배치 스크립트.
 *
 * 실행 방식:
 *   - GitHub Actions: 매주 일요일 22:00 KST 자동
 *   - 로컬 수동: `npm run summarize` 또는 `npm run summarize:dry`
 *
 * 동작:
 *   1. 지난 7일간 Status='Draft'인 Raw_Entry 전부 조회
 *   2. 각 엔트리에 달린 Comments 조회
 *   3. ISO 주차 단위로 그룹화
 *   4. 각 주차마다 Gemini에 전송 → {week_title, essay} 받음
 *   5. Weekly_Summary DB에 생성 (이미 있으면 업데이트)
 *   6. 해당 엔트리들의 Status를 'Summarized'로 전환 + Week_Ref 설정
 *
 * 플래그:
 *   --dry-run    실제 쓰기 대신 결과만 출력
 *   --days=14    기본 7일 대신 14일치 조회 (누적 복구용)
 */

import { config as loadDotenv } from 'dotenv';

import {
  queryRawEntriesInRange,
  listCommentsForEntries,
  findWeeklySummaryByWeekId,
  createWeeklySummary,
  updateWeeklySummary,
  updateEntriesStatus,
  type RawEntryRow,
  type CommentRow,
} from '../lib/notion.js';
import { summarizeWeek, type WeekEntryInput } from '../lib/gemini.js';

loadDotenv({ path: '.env.local' });
loadDotenv({ path: '.env' });

// ────────────────────────────────────────────────────────────────
// CLI parsing
// ────────────────────────────────────────────────────────────────

interface CliOptions {
  dryRun: boolean;
  days: number;
}

function parseCli(argv: string[]): CliOptions {
  let dryRun = false;
  let days = 7;
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--days=')) {
      const n = Number(arg.slice('--days='.length));
      if (Number.isFinite(n) && n > 0) days = n;
    }
  }
  return { dryRun, days };
}

// ────────────────────────────────────────────────────────────────
// ISO week computation (RFC-style, Mon-Sun)
// ────────────────────────────────────────────────────────────────

interface IsoWeek {
  year: number;
  week: number;
  weekId: string;
  startMonday: Date;
  endSunday: Date;
}

function getIsoWeek(date: Date): IsoWeek {
  // Normalize to UTC midnight to avoid TZ edge cases
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = d.getUTCDay() || 7; // Sun=0 → 7
  // Shift to Thursday in current week (ISO week-year definition)
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  const weekId = `${year}-W${String(week).padStart(2, '0')}`;

  // Compute Monday of this week
  const base = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const baseDayNum = base.getUTCDay() || 7;
  const startMonday = new Date(base);
  startMonday.setUTCDate(base.getUTCDate() - (baseDayNum - 1));
  const endSunday = new Date(startMonday);
  endSunday.setUTCDate(startMonday.getUTCDate() + 6);
  endSunday.setUTCHours(23, 59, 59, 999);

  return { year, week, weekId, startMonday, endSunday };
}

// ────────────────────────────────────────────────────────────────
// Grouping
// ────────────────────────────────────────────────────────────────

interface WeekGroup {
  weekId: string;
  startMonday: Date;
  endSunday: Date;
  entries: RawEntryRow[];
}

function groupByIsoWeek(entries: RawEntryRow[]): WeekGroup[] {
  const map = new Map<string, WeekGroup>();
  for (const entry of entries) {
    const iso = getIsoWeek(entry.date);
    const existing = map.get(iso.weekId);
    if (existing) {
      existing.entries.push(entry);
    } else {
      map.set(iso.weekId, {
        weekId: iso.weekId,
        startMonday: iso.startMonday,
        endSunday: iso.endSunday,
        entries: [entry],
      });
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.startMonday.getTime() - b.startMonday.getTime(),
  );
}

// ────────────────────────────────────────────────────────────────
// Build Gemini input from a week group
// ────────────────────────────────────────────────────────────────

function buildWeekInput(
  group: WeekGroup,
  commentsByEntry: Map<string, CommentRow[]>,
): WeekEntryInput[] {
  return group.entries
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((entry) => {
      const comments = (commentsByEntry.get(entry.pageId) ?? []).map((c) => ({
        author: c.authorName,
        text: c.text,
      }));
      return {
        date: entry.date,
        author: entry.author || '가족',
        rawContent: entry.rawContent,
        mediaKind: entry.type,
        comments,
      };
    });
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  console.log(`[summarize] starting (dryRun=${opts.dryRun}, days=${opts.days})`);

  const now = new Date();
  const fromDate = new Date(now.getTime() - opts.days * 86_400_000);

  // 1. Fetch draft entries
  const entries = await queryRawEntriesInRange({
    fromDate,
    toDate: now,
    status: 'Draft',
  });
  console.log(`[summarize] fetched ${entries.length} draft entries`);

  if (entries.length === 0) {
    console.log('[summarize] nothing to summarize, exiting');
    return;
  }

  // 2. Fetch comments for those entries
  const entryIds = entries.map((e) => e.pageId);
  const commentsByEntry = await listCommentsForEntries(entryIds);
  const totalComments = Array.from(commentsByEntry.values()).reduce(
    (sum, list) => sum + list.length,
    0,
  );
  console.log(`[summarize] fetched ${totalComments} comments`);

  // 3. Group by ISO week
  const groups = groupByIsoWeek(entries);
  console.log(`[summarize] grouped into ${groups.length} week(s)`);

  // 4-6. Process each week
  let successCount = 0;
  let failCount = 0;
  for (const group of groups) {
    console.log(
      `[summarize] processing ${group.weekId} (${group.entries.length} entries)`,
    );
    try {
      const weekInput = buildWeekInput(group, commentsByEntry);
      const result = await summarizeWeek({
        startDate: group.startMonday,
        endDate: group.endSunday,
        entries: weekInput,
      });

      console.log(`  → title: "${result.weekTitle}"`);
      console.log(`  → essay: ${result.essay.slice(0, 80)}...`);

      if (opts.dryRun) {
        console.log('  (dry-run: skipping Notion writes)');
      } else {
        // Upsert Weekly_Summary
        const existing = await findWeeklySummaryByWeekId(group.weekId);
        let weeklyPageId: string;
        if (existing) {
          await updateWeeklySummary(existing.pageId, {
            weekTitle: result.weekTitle,
            essay: result.essay,
            entryCount: group.entries.length,
          });
          weeklyPageId = existing.pageId;
          console.log(`  ✓ updated existing Weekly_Summary ${weeklyPageId}`);
        } else {
          weeklyPageId = await createWeeklySummary({
            weekId: group.weekId,
            startDate: group.startMonday,
            endDate: group.endSunday,
            weekTitle: result.weekTitle,
            essay: result.essay,
            entryCount: group.entries.length,
          });
          console.log(`  ✓ created Weekly_Summary ${weeklyPageId}`);
        }

        // Mark entries as Summarized + link to week
        await updateEntriesStatus(
          group.entries.map((e) => e.pageId),
          'Summarized',
          weeklyPageId,
        );
        console.log(`  ✓ marked ${group.entries.length} entries as Summarized`);
      }
      successCount += 1;
    } catch (err) {
      console.error(`  ✗ week ${group.weekId} failed:`, (err as Error).message);
      failCount += 1;
    }
  }

  console.log(
    `[summarize] done. success=${successCount} fail=${failCount} total=${groups.length}`,
  );
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[summarize] fatal', err);
  process.exit(1);
});
