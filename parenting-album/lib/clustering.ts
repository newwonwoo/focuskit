/**
 * 유사사진 군집화.
 *
 * 설계: 간단 규칙 기반 (pHash/AI 없이).
 * 같은 author + takenDate(or date) 5분 이내 = 동일 군집.
 *
 * 군집당 상위 2장만 채택. 나머지는 excludeCode='CLUSTER_DUPLICATE'.
 */

import type { RawEntryRow } from './notion.js';

export interface ClusterAssignment {
  entryId: string;
  clusterId: string;
  isTop: boolean; // 군집 내 상위 2장이면 true
  rank: number; // 1=최상위, 2=2위, 3+ = 제외 대상
}

const CLUSTER_WINDOW_MS = 5 * 60_000; // 5분
const MAX_PER_CLUSTER = 2;

/**
 * 엔트리들을 군집화.
 * 입력 순서와 무관하게, 각 엔트리에 clusterId/rank 부여.
 *
 * 군집 키: ${author}_${YYYYMMDDHHMM_5분단위}
 * 예: "아빠_20260412_1900" (19시 00-04분 5분 슬롯)
 *
 * @param entries 대상 사진 엔트리들
 * @param scores entryId → qualityScore 맵 (순위 결정용). 없으면 timestamp 기준.
 */
export function clusterEntries(
  entries: RawEntryRow[],
  scores?: Map<string, number>,
): ClusterAssignment[] {
  // 이미지/Mixed만 군집화
  const photoEntries = entries.filter(
    (e) => e.type === 'Image' || e.type === 'Mixed',
  );

  // author + 5분 버킷 기준으로 군집 매핑
  const clusters = new Map<string, RawEntryRow[]>();

  for (const entry of photoEntries) {
    const refDate = entry.takenDate ?? entry.date;
    const clusterId = makeClusterId(entry.author, refDate);
    const list = clusters.get(clusterId) ?? [];
    list.push(entry);
    clusters.set(clusterId, list);
  }

  // 각 군집 내에서 점수(or 시각) 순으로 정렬 → rank 부여
  const assignments: ClusterAssignment[] = [];
  for (const [clusterId, list] of clusters) {
    list.sort((a, b) => {
      const scoreA = scores?.get(a.pageId) ?? 0;
      const scoreB = scores?.get(b.pageId) ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA; // 점수 내림차순
      // 동점 시 시간 빠른 순
      const dateA = (a.takenDate ?? a.date).getTime();
      const dateB = (b.takenDate ?? b.date).getTime();
      return dateA - dateB;
    });

    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i]!;
      assignments.push({
        entryId: entry.pageId,
        clusterId,
        isTop: i < MAX_PER_CLUSTER,
        rank: i + 1,
      });
    }
  }

  return assignments;
}

/**
 * 같은 author + 5분 슬롯 기준 clusterId.
 * 예: author="아빠", date="2026-04-12T19:02:34"
 *   → 5분 단위로 내림 (00-04, 05-09, ...)
 *   → "아빠_20260412_1900"
 */
function makeClusterId(author: string, date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const mi = date.getUTCMinutes();
  const bucketMin = Math.floor(mi / 5) * 5;
  const miStr = String(bucketMin).padStart(2, '0');
  // author에 공백/특수문자 있으면 언더스코어로 정규화
  const safeAuthor = author.replace(/[^가-힣a-zA-Z0-9]/g, '_');
  return `${safeAuthor}_${y}${mo}${d}_${h}${miStr}`;
}

export { CLUSTER_WINDOW_MS, MAX_PER_CLUSTER };
