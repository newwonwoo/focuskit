/**
 * 특정 월의 사진들 점수 재계산 + 군집화 + Notion 업데이트.
 *
 * 사용:
 *   npm run rescore -- --month=2026-04
 *   npm run rescore -- --month=2026-04 --dry-run
 */

import { config as loadDotenv } from 'dotenv';

import {
  queryRawEntriesByMonth,
  listCommentsForEntries,
  updatePhotoScoring,
  type RawEntryRow,
} from '../lib/notion.js';
import { scorePhoto, EXCLUDE_CODES, type PhotoScoring } from '../lib/scoring.js';
import { clusterEntries } from '../lib/clustering.js';

loadDotenv({ path: '.env.local' });
loadDotenv({ path: '.env' });

interface CliOptions {
  month: string;
  dryRun: boolean;
}

function parseCli(argv: string[]): CliOptions {
  const now = new Date();
  let month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  let dryRun = false;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--month=')) month = arg.slice('--month='.length);
    else if (arg === '--dry-run') dryRun = true;
  }
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`--month=${month} invalid`);
  return { month, dryRun };
}

function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  const { month, dryRun } = parseCli(process.argv);
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthNum = Number(monthStr);

  console.log(`[rescore] starting for ${year}-${monthNum} (dryRun=${dryRun})`);

  // 1. 대상 월의 모든 엔트리 조회
  const entries = await queryRawEntriesByMonth(year, monthNum);
  const photoEntries = entries.filter((e) => e.type === 'Image' || e.type === 'Mixed');
  console.log(`[rescore] fetched ${entries.length} entries (${photoEntries.length} photos)`);

  if (photoEntries.length === 0) {
    console.log('[rescore] no photos to score, exiting');
    return;
  }

  // 2. 댓글 수집 (점수 계산용)
  const commentsMap = await listCommentsForEntries(photoEntries.map((e) => e.pageId));

  // 3. 날짜별 그룹 (첫 사진 판정용)
  const byDay = new Map<string, RawEntryRow[]>();
  for (const e of photoEntries) {
    const refDate = e.takenDate ?? e.date;
    const k = dayKey(refDate);
    const list = byDay.get(k) ?? [];
    list.push(e);
    byDay.set(k, list);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => {
      const da = (a.takenDate ?? a.date).getTime();
      const db = (b.takenDate ?? b.date).getTime();
      return da - db;
    });
  }
  const isFirstOfDayMap = new Map<string, boolean>();
  for (const list of byDay.values()) {
    for (let i = 0; i < list.length; i += 1) {
      isFirstOfDayMap.set(list[i]!.pageId, i === 0);
    }
  }

  // 4. 1차 점수 (군집 정보 없이)
  const scorings = new Map<string, PhotoScoring>();
  for (const e of photoEntries) {
    const commentCount = (commentsMap.get(e.pageId) ?? []).length;
    const refDate = e.takenDate ?? e.date;
    const totalSameDay = byDay.get(dayKey(refDate))?.length ?? 1;
    const scoring = scorePhoto(e, {
      commentCount,
      totalPhotosSameDay: totalSameDay,
      isFirstOfDay: isFirstOfDayMap.get(e.pageId) ?? false,
    });
    scorings.set(e.pageId, scoring);
  }

  // 5. 군집화 (점수 반영)
  const scoreMap = new Map<string, number>();
  for (const [id, s] of scorings) scoreMap.set(id, s.qualityScore);
  const clusters = clusterEntries(photoEntries, scoreMap);

  // 6. 2차 점수 (군집 대표성 반영) + exclude_code 업데이트
  const clusterMap = new Map<string, { clusterId: string; isTop: boolean; rank: number }>();
  for (const a of clusters) {
    clusterMap.set(a.entryId, { clusterId: a.clusterId, isTop: a.isTop, rank: a.rank });
  }

  let updateCount = 0;
  let skipCount = 0;
  let excludeCount = 0;

  for (const e of photoEntries) {
    const scoring = scorings.get(e.pageId)!;
    const clusterInfo = clusterMap.get(e.pageId);
    const isClusterTop = clusterInfo?.rank === 1;

    // 군집 1위면 +10 보정
    let finalScore = scoring.qualityScore;
    if (isClusterTop && !scoring.excludeCode) finalScore = Math.min(100, finalScore + 10);

    // 군집 내 3위 이하는 중복 제외 코드 부여 (기존 excludeCode가 더 심각하면 유지)
    let finalExcludeCode = scoring.excludeCode;
    if (clusterInfo && !clusterInfo.isTop && !finalExcludeCode) {
      finalExcludeCode = EXCLUDE_CODES.CLUSTER_DUPLICATE;
    }

    if (finalExcludeCode) excludeCount += 1;

    // 이미 동일 값이면 skip
    if (
      e.qualityScore === finalScore &&
      e.excludeCode === (finalExcludeCode ?? undefined) &&
      e.clusterId === clusterInfo?.clusterId
    ) {
      skipCount += 1;
      continue;
    }

    if (dryRun) {
      console.log(
        `[dry] ${e.pageId.slice(-6)} score=${finalScore} cluster=${clusterInfo?.clusterId} exclude=${finalExcludeCode ?? ''}`,
      );
      updateCount += 1;
      continue;
    }

    await updatePhotoScoring(e.pageId, {
      qualityScore: finalScore,
      clusterId: clusterInfo?.clusterId ?? null,
      excludeCode: finalExcludeCode ?? null,
    });
    updateCount += 1;

    // Notion rate limit 회피: 3 req/sec 제한 → 400ms 대기
    await new Promise((r) => setTimeout(r, 350));
  }

  console.log(
    `[rescore] done. updated=${updateCount}, skipped=${skipCount}, excluded=${excludeCount}`,
  );
}

main().catch((err) => {
  console.error('[rescore] fatal', err);
  process.exit(1);
});
