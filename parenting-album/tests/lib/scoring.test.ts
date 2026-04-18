import { describe, it, expect } from 'vitest';
import { scorePhoto, EXCLUDE_CODES } from '../../lib/scoring';
import type { RawEntryRow } from '../../lib/notion';
import type { ScoreContext } from '../../lib/scoring';

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<RawEntryRow> = {}): RawEntryRow {
  return {
    pageId: 'page-001',
    idempotencyKey: 'idem-001',
    date: new Date('2026-04-12T10:00:00Z'),
    type: 'Image',
    rawContent: '',
    author: '엄마',
    authorKakaoUserId: 'kakao-001',
    mediaUrl: 'https://example.com/photo.jpg',
    status: 'Draft',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ScoreContext> = {}): ScoreContext {
  return {
    commentCount: 0,
    totalPhotosSameDay: 1,
    isFirstOfDay: false,
    isClusterTop: false,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────
// Non-image types
// ────────────────────────────────────────────────────────────────

describe('scorePhoto – non-image types', () => {
  it('Video type → qualityScore 0, excludeCode null', () => {
    const result = scorePhoto(makeEntry({ type: 'Video' }), makeCtx());
    expect(result.qualityScore).toBe(0);
    expect(result.excludeCode).toBeNull();
    expect(result.isPrintEligible).toBe(false);
  });

  it('Text type → qualityScore 0, excludeCode null', () => {
    const result = scorePhoto(makeEntry({ type: 'Text' }), makeCtx());
    expect(result.qualityScore).toBe(0);
    expect(result.excludeCode).toBeNull();
    expect(result.isPrintEligible).toBe(false);
  });

  it('Video type does not get INVALID_MEDIA excludeCode even without mediaUrl', () => {
    const result = scorePhoto(
      makeEntry({ type: 'Video', mediaUrl: undefined }),
      makeCtx(),
    );
    expect(result.excludeCode).toBeNull();
  });

  it('Text type isPrintEligible is false', () => {
    const result = scorePhoto(makeEntry({ type: 'Text', mediaWidth: 3000 }), makeCtx());
    expect(result.isPrintEligible).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Hidden entries
// ────────────────────────────────────────────────────────────────

describe('scorePhoto – hidden entries', () => {
  it('is_hidden → HIDDEN_BY_USER, score 0', () => {
    const result = scorePhoto(makeEntry({ isHidden: true }), makeCtx());
    expect(result.qualityScore).toBe(0);
    expect(result.excludeCode).toBe(EXCLUDE_CODES.HIDDEN_BY_USER);
    expect(result.isPrintEligible).toBe(false);
  });

  it('isHidden false → not hidden', () => {
    const result = scorePhoto(
      makeEntry({ isHidden: false, mediaWidth: 2000 }),
      makeCtx(),
    );
    expect(result.excludeCode).not.toBe(EXCLUDE_CODES.HIDDEN_BY_USER);
    expect(result.qualityScore).toBeGreaterThan(0);
  });

  it('hidden image ignores high resolution — still returns 0', () => {
    const result = scorePhoto(
      makeEntry({ isHidden: true, mediaWidth: 3000 }),
      makeCtx({ commentCount: 3, isFirstOfDay: true }),
    );
    expect(result.qualityScore).toBe(0);
    expect(result.excludeCode).toBe(EXCLUDE_CODES.HIDDEN_BY_USER);
  });
});

// ────────────────────────────────────────────────────────────────
// Invalid media
// ────────────────────────────────────────────────────────────────

describe('scorePhoto – invalid media', () => {
  it('no mediaUrl and no mediaPrintUrl → INVALID_MEDIA', () => {
    const result = scorePhoto(
      makeEntry({ mediaUrl: undefined, mediaPrintUrl: undefined }),
      makeCtx(),
    );
    expect(result.qualityScore).toBe(0);
    expect(result.excludeCode).toBe(EXCLUDE_CODES.INVALID_MEDIA);
    expect(result.isPrintEligible).toBe(false);
  });

  it('mediaPrintUrl present but no mediaUrl → valid', () => {
    const result = scorePhoto(
      makeEntry({ mediaUrl: undefined, mediaPrintUrl: 'https://example.com/print.jpg', mediaWidth: 2000 }),
      makeCtx(),
    );
    expect(result.excludeCode).not.toBe(EXCLUDE_CODES.INVALID_MEDIA);
    expect(result.qualityScore).toBeGreaterThan(0);
  });

  it('mediaUrl present but no mediaPrintUrl → valid', () => {
    const result = scorePhoto(
      makeEntry({ mediaUrl: 'https://example.com/photo.jpg', mediaPrintUrl: undefined, mediaWidth: 2000 }),
      makeCtx(),
    );
    expect(result.excludeCode).not.toBe(EXCLUDE_CODES.INVALID_MEDIA);
  });
});

// ────────────────────────────────────────────────────────────────
// Resolution thresholds
// ────────────────────────────────────────────────────────────────

describe('scorePhoto – resolution scoring', () => {
  it('width 800 (< 1000) → LOW_RES, isPrintEligible false', () => {
    const result = scorePhoto(makeEntry({ mediaWidth: 800 }), makeCtx());
    expect(result.excludeCode).toBe(EXCLUDE_CODES.LOW_RES);
    expect(result.isPrintEligible).toBe(false);
    // baseline 35, no resolution bonus
    expect(result.qualityScore).toBe(35);
  });

  it('width 999 → LOW_RES', () => {
    const result = scorePhoto(makeEntry({ mediaWidth: 999 }), makeCtx());
    expect(result.excludeCode).toBe(EXCLUDE_CODES.LOW_RES);
    expect(result.isPrintEligible).toBe(false);
  });

  it('width 1000 → +8 pts, no LOW_RES, isPrintEligible false (< 1200)', () => {
    const result = scorePhoto(makeEntry({ mediaWidth: 1000 }), makeCtx());
    expect(result.excludeCode).toBeNull();
    // baseline 35 + resolution 8
    expect(result.qualityScore).toBe(43);
    expect(result.isPrintEligible).toBe(false);
  });

  it('width 1199 → +8 pts, isPrintEligible false', () => {
    const result = scorePhoto(makeEntry({ mediaWidth: 1199 }), makeCtx());
    expect(result.qualityScore).toBe(43);
    expect(result.isPrintEligible).toBe(false);
  });

  it('width 1200 → +15 pts, isPrintEligible true', () => {
    const result = scorePhoto(makeEntry({ mediaWidth: 1200 }), makeCtx());
    expect(result.excludeCode).toBeNull();
    // baseline 35 + resolution 15
    expect(result.qualityScore).toBe(50);
    expect(result.isPrintEligible).toBe(true);
  });

  it('width 1499 → +15 pts, isPrintEligible true', () => {
    const result = scorePhoto(makeEntry({ mediaWidth: 1499 }), makeCtx());
    expect(result.qualityScore).toBe(50);
    expect(result.isPrintEligible).toBe(true);
  });

  it('width 1500 → +25 pts, isPrintEligible true', () => {
    const result = scorePhoto(makeEntry({ mediaWidth: 1500 }), makeCtx());
    expect(result.excludeCode).toBeNull();
    // baseline 35 + resolution 25
    expect(result.qualityScore).toBe(60);
    expect(result.isPrintEligible).toBe(true);
  });

  it('width 3000 → +25 pts', () => {
    const result = scorePhoto(makeEntry({ mediaWidth: 3000 }), makeCtx());
    expect(result.qualityScore).toBe(60);
  });

  it('unknown width (undefined) → +10 pts neutral bonus', () => {
    const result = scorePhoto(makeEntry({ mediaWidth: undefined }), makeCtx());
    // baseline 35 + neutral 10
    expect(result.qualityScore).toBe(45);
    expect(result.excludeCode).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Comment bonus
// ────────────────────────────────────────────────────────────────

describe('scorePhoto – comment bonus', () => {
  it('commentCount 0 → no bonus', () => {
    const baseline = scorePhoto(makeEntry({ mediaWidth: 1500 }), makeCtx({ commentCount: 0 }));
    const withComment = scorePhoto(makeEntry({ mediaWidth: 1500 }), makeCtx({ commentCount: 1 }));
    expect(withComment.qualityScore - baseline.qualityScore).toBe(10);
  });

  it('commentCount 1 → +10 pts', () => {
    const result = scorePhoto(makeEntry({ mediaWidth: 1500 }), makeCtx({ commentCount: 1 }));
    // 35 + 25 + 10
    expect(result.qualityScore).toBe(70);
  });

  it('commentCount 5 → +10 pts (same bonus regardless of count)', () => {
    const result = scorePhoto(makeEntry({ mediaWidth: 1500 }), makeCtx({ commentCount: 5 }));
    expect(result.qualityScore).toBe(70);
  });
});

// ────────────────────────────────────────────────────────────────
// Memo (rawContent) bonus
// ────────────────────────────────────────────────────────────────

describe('scorePhoto – memo bonus', () => {
  it('empty rawContent → no bonus', () => {
    const result = scorePhoto(
      makeEntry({ mediaWidth: 1500, rawContent: '' }),
      makeCtx(),
    );
    expect(result.qualityScore).toBe(60);
  });

  it('whitespace only rawContent → no bonus', () => {
    const result = scorePhoto(
      makeEntry({ mediaWidth: 1500, rawContent: '   ' }),
      makeCtx(),
    );
    expect(result.qualityScore).toBe(60);
  });

  it('non-empty rawContent → +10 pts', () => {
    const result = scorePhoto(
      makeEntry({ mediaWidth: 1500, rawContent: '원우 첫 걸음마!' }),
      makeCtx(),
    );
    expect(result.qualityScore).toBe(70);
  });
});

// ────────────────────────────────────────────────────────────────
// isFirstOfDay bonus
// ────────────────────────────────────────────────────────────────

describe('scorePhoto – isFirstOfDay bonus', () => {
  it('isFirstOfDay false → no bonus', () => {
    const result = scorePhoto(
      makeEntry({ mediaWidth: 1500 }),
      makeCtx({ isFirstOfDay: false }),
    );
    expect(result.qualityScore).toBe(60);
  });

  it('isFirstOfDay true → +10 pts', () => {
    const result = scorePhoto(
      makeEntry({ mediaWidth: 1500 }),
      makeCtx({ isFirstOfDay: true }),
    );
    expect(result.qualityScore).toBe(70);
  });
});

// ────────────────────────────────────────────────────────────────
// isClusterTop bonus
// ────────────────────────────────────────────────────────────────

describe('scorePhoto – isClusterTop bonus', () => {
  it('isClusterTop false → no bonus', () => {
    const result = scorePhoto(
      makeEntry({ mediaWidth: 1500 }),
      makeCtx({ isClusterTop: false }),
    );
    expect(result.qualityScore).toBe(60);
  });

  it('isClusterTop true → +10 pts', () => {
    const result = scorePhoto(
      makeEntry({ mediaWidth: 1500 }),
      makeCtx({ isClusterTop: true }),
    );
    expect(result.qualityScore).toBe(70);
  });

  it('isClusterTop undefined → no bonus', () => {
    const result = scorePhoto(
      makeEntry({ mediaWidth: 1500 }),
      makeCtx({ isClusterTop: undefined }),
    );
    expect(result.qualityScore).toBe(60);
  });
});

// ────────────────────────────────────────────────────────────────
// Score capping
// ────────────────────────────────────────────────────────────────

describe('scorePhoto – score cap at 100', () => {
  it('all bonuses combined cannot exceed 100', () => {
    // baseline 35 + res 25 + comment 10 + memo 10 + firstDay 10 + clusterTop 10 = 100
    const result = scorePhoto(
      makeEntry({ mediaWidth: 1500, rawContent: '메모 있음' }),
      makeCtx({ commentCount: 2, isFirstOfDay: true, isClusterTop: true }),
    );
    expect(result.qualityScore).toBe(100);
  });

  it('score never exceeds 100 with extreme input', () => {
    const result = scorePhoto(
      makeEntry({ mediaWidth: 9999, rawContent: '최고의 사진' }),
      makeCtx({ commentCount: 999, isFirstOfDay: true, isClusterTop: true }),
    );
    expect(result.qualityScore).toBeLessThanOrEqual(100);
  });
});

// ────────────────────────────────────────────────────────────────
// Mixed type
// ────────────────────────────────────────────────────────────────

describe('scorePhoto – Mixed type', () => {
  it('Mixed type is scored like Image', () => {
    const imageResult = scorePhoto(makeEntry({ type: 'Image', mediaWidth: 1500 }), makeCtx());
    const mixedResult = scorePhoto(makeEntry({ type: 'Mixed', mediaWidth: 1500 }), makeCtx());
    expect(mixedResult.qualityScore).toBe(imageResult.qualityScore);
    expect(mixedResult.isPrintEligible).toBe(imageResult.isPrintEligible);
  });

  it('Mixed type with no media URL → INVALID_MEDIA', () => {
    const result = scorePhoto(
      makeEntry({ type: 'Mixed', mediaUrl: undefined, mediaPrintUrl: undefined }),
      makeCtx(),
    );
    expect(result.excludeCode).toBe(EXCLUDE_CODES.INVALID_MEDIA);
    expect(result.qualityScore).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Combined scenarios
// ────────────────────────────────────────────────────────────────

describe('scorePhoto – combined scenarios', () => {
  it('low-res image with comment and memo: score 55, LOW_RES excludeCode', () => {
    // 35 + 0(LOW_RES) + 10(comment) + 10(memo) = 55
    const result = scorePhoto(
      makeEntry({ mediaWidth: 800, rawContent: '원우 사진' }),
      makeCtx({ commentCount: 1 }),
    );
    expect(result.qualityScore).toBe(55);
    expect(result.excludeCode).toBe(EXCLUDE_CODES.LOW_RES);
    expect(result.isPrintEligible).toBe(false);
  });

  it('high-res image, first of day, cluster top: score 80', () => {
    // 35 + 25 + 10 + 10 = 80
    const result = scorePhoto(
      makeEntry({ mediaWidth: 2000 }),
      makeCtx({ isFirstOfDay: true, isClusterTop: true }),
    );
    expect(result.qualityScore).toBe(80);
    expect(result.isPrintEligible).toBe(true);
  });

  it('hidden image with high-res: returns 0, HIDDEN_BY_USER (not INVALID_MEDIA)', () => {
    const result = scorePhoto(
      makeEntry({ mediaWidth: 3000, isHidden: true }),
      makeCtx({ commentCount: 3, isFirstOfDay: true }),
    );
    expect(result.qualityScore).toBe(0);
    expect(result.excludeCode).toBe(EXCLUDE_CODES.HIDDEN_BY_USER);
  });

  it('unknown width + comment + memo + isFirstOfDay: 45+10+10+10=75', () => {
    const result = scorePhoto(
      makeEntry({ rawContent: '기록' }),
      makeCtx({ commentCount: 1, isFirstOfDay: true }),
    );
    // baseline 35 + neutral 10 + comment 10 + memo 10 + firstDay 10 = 75
    expect(result.qualityScore).toBe(75);
    expect(result.excludeCode).toBeNull();
  });

  it('mid-res (1200) + all bonuses = 35+15+10+10+10+10 = 90', () => {
    const result = scorePhoto(
      makeEntry({ mediaWidth: 1200, rawContent: '사진 메모' }),
      makeCtx({ commentCount: 1, isFirstOfDay: true, isClusterTop: true }),
    );
    expect(result.qualityScore).toBe(90);
    expect(result.isPrintEligible).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// EXCLUDE_CODES export
// ────────────────────────────────────────────────────────────────

describe('EXCLUDE_CODES', () => {
  it('exports LOW_RES code', () => {
    expect(EXCLUDE_CODES.LOW_RES).toBe('LOW_RES');
  });

  it('exports HIDDEN_BY_USER code', () => {
    expect(EXCLUDE_CODES.HIDDEN_BY_USER).toBe('HIDDEN_BY_USER');
  });

  it('exports INVALID_MEDIA code', () => {
    expect(EXCLUDE_CODES.INVALID_MEDIA).toBe('INVALID_MEDIA');
  });

  it('exports CLUSTER_DUPLICATE code', () => {
    expect(EXCLUDE_CODES.CLUSTER_DUPLICATE).toBe('CLUSTER_DUPLICATE');
  });
});
