/**
 * 사진 품질 점수 계산 (0~100점).
 *
 * 설계: 간단한 규칙 기반. AI 미학 평가 대신 확정 가능한 지표만 사용.
 * - 해상도 (폭 기준)
 * - 댓글 존재
 * - 메모(Raw_Content) 존재
 * - 날짜 대표성 (해당 일자 첫 사진인지)
 * - 군집 대표성 (유사사진 군집 1위인지)
 */

import type { RawEntryRow } from './notion.js';

export interface ScoreContext {
  /** 이 엔트리에 달린 댓글 수 */
  commentCount: number;
  /** 같은 날 업로드된 전체 사진 수 */
  totalPhotosSameDay: number;
  /** 해당 날짜 시간순 1번째인지 */
  isFirstOfDay: boolean;
  /** 속한 군집의 1위인지 (true면 가산) */
  isClusterTop?: boolean;
}

export interface PhotoScoring {
  qualityScore: number; // 0~100
  excludeCode: string | null;
  isPrintEligible: boolean;
}

const EXCLUDE_CODES = {
  LOW_RES: 'LOW_RES',
  LOW_PRINT_QUALITY: 'LOW_PRINT_QUALITY',
  CLUSTER_DUPLICATE: 'CLUSTER_DUPLICATE',
  HIDDEN_BY_USER: 'HIDDEN_BY_USER',
  INVALID_MEDIA: 'INVALID_MEDIA',
} as const;

/**
 * 사진 1장의 품질 점수 계산.
 * 비이미지 (Video, Text) 는 점수 0, excludeCode null.
 */
export function scorePhoto(entry: RawEntryRow, ctx: ScoreContext): PhotoScoring {
  // 이미지 아닌 경우 점수 계산 제외
  if (entry.type !== 'Image' && entry.type !== 'Mixed') {
    return { qualityScore: 0, excludeCode: null, isPrintEligible: false };
  }

  // 사용자가 숨김
  if (entry.isHidden) {
    return {
      qualityScore: 0,
      excludeCode: EXCLUDE_CODES.HIDDEN_BY_USER,
      isPrintEligible: false,
    };
  }

  // Media URL 없음 = 업로드 실패
  if (!entry.mediaUrl && !entry.mediaPrintUrl) {
    return {
      qualityScore: 0,
      excludeCode: EXCLUDE_CODES.INVALID_MEDIA,
      isPrintEligible: false,
    };
  }

  let score = 35; // 기준선
  let excludeCode: string | null = null;
  let isPrintEligible = true;

  // 1. 해상도 (25점)
  const width = entry.mediaWidth;
  if (typeof width === 'number') {
    if (width >= 1500) score += 25;
    else if (width >= 1200) score += 15;
    else if (width >= 1000) score += 8;
    else {
      // 1000px 미만 = 인쇄 부적합
      excludeCode = EXCLUDE_CODES.LOW_RES;
      isPrintEligible = false;
    }

    // 1000~1199는 preview OK but print 주의
    if (width >= 1000 && width < 1500 && !excludeCode) {
      isPrintEligible = width >= 1200;
    }
  } else {
    // width 모름 = 중립 (10점만)
    score += 10;
  }

  // 2. 댓글 존재 (10점)
  if (ctx.commentCount > 0) score += 10;

  // 3. 메모 존재 (10점)
  if (entry.rawContent && entry.rawContent.trim().length > 0) score += 10;

  // 4. 날짜 대표성 (10점)
  if (ctx.isFirstOfDay) score += 10;

  // 5. 군집 대표성 (10점)
  if (ctx.isClusterTop) score += 10;

  // 상한 100
  score = Math.min(100, Math.max(0, score));

  return {
    qualityScore: score,
    excludeCode,
    isPrintEligible,
  };
}

export { EXCLUDE_CODES };
