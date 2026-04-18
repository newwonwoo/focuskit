import { describe, it, expect } from 'vitest';
import { clusterEntries } from '../../lib/clustering';
import type { RawEntryRow } from '../../lib/notion';

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function mkEntry(overrides: Partial<RawEntryRow> = {}): RawEntryRow {
  return {
    pageId: 'p1', idempotencyKey: 'k', date: new Date('2026-04-12T10:00:00Z'),
    type: 'Image', rawContent: '', author: '아빠', authorKakaoUserId: 'dad',
    status: 'Draft', ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────
// Basic grouping
// ────────────────────────────────────────────────────────────────

describe('clusterEntries – basic grouping', () => {
  it('빈 입력 → 빈 출력', () => {
    expect(clusterEntries([])).toHaveLength(0);
  });

  it('단일 엔트리 → rank 1, isTop true', () => {
    const entries = [mkEntry({ pageId: 'solo' })];
    const result = clusterEntries(entries);
    expect(result).toHaveLength(1);
    expect(result[0]!.rank).toBe(1);
    expect(result[0]!.isTop).toBe(true);
    expect(result[0]!.entryId).toBe('solo');
  });

  it('같은 author + 5분 이내 → 같은 군집', () => {
    const t = new Date('2026-04-12T10:00:00Z');
    const entries = [
      mkEntry({ pageId: 'a', author: '아빠', takenDate: t }),
      mkEntry({ pageId: 'b', author: '아빠', takenDate: new Date(t.getTime() + 60_000) }),
    ];
    const result = clusterEntries(entries);
    const aCluster = result.find((r) => r.entryId === 'a')!.clusterId;
    const bCluster = result.find((r) => r.entryId === 'b')!.clusterId;
    expect(aCluster).toBe(bCluster);
  });

  it('같은 author + 6분 → 다른 군집 (5분 슬롯 경계)', () => {
    const t = new Date('2026-04-12T10:00:00Z');
    const entries = [
      mkEntry({ pageId: 'a', author: '아빠', takenDate: t }),
      mkEntry({ pageId: 'b', author: '아빠', takenDate: new Date(t.getTime() + 360_000) }),
    ];
    const result = clusterEntries(entries);
    const aCluster = result.find((r) => r.entryId === 'a')!.clusterId;
    const bCluster = result.find((r) => r.entryId === 'b')!.clusterId;
    expect(aCluster).not.toBe(bCluster);
  });

  it('다른 author → 다른 군집', () => {
    const t = new Date('2026-04-12T10:00:00Z');
    const entries = [
      mkEntry({ pageId: 'a', author: '아빠', takenDate: t }),
      mkEntry({ pageId: 'b', author: '엄마', takenDate: t }),
    ];
    const result = clusterEntries(entries);
    expect(result.find((r) => r.entryId === 'a')!.clusterId)
      .not.toBe(result.find((r) => r.entryId === 'b')!.clusterId);
  });

  it('takenDate 없으면 date 기반 군집', () => {
    const entries = [
      mkEntry({ pageId: 'a', author: '아빠', date: new Date('2026-04-12T10:00:00Z') }),
      mkEntry({ pageId: 'b', author: '아빠', date: new Date('2026-04-12T10:02:00Z') }),
    ];
    const result = clusterEntries(entries);
    expect(result.find((r) => r.entryId === 'a')!.clusterId)
      .toBe(result.find((r) => r.entryId === 'b')!.clusterId);
  });
});

// ────────────────────────────────────────────────────────────────
// Bucket boundary
// ────────────────────────────────────────────────────────────────

describe('clusterEntries – bucket boundary', () => {
  it('4:59 간격 → 같은 버킷 (10:00 슬롯)', () => {
    const t0 = new Date('2026-04-12T10:00:00Z');
    const t1 = new Date('2026-04-12T10:04:59Z');
    const a = mkEntry({ pageId: 'a', author: '아빠', takenDate: t0 });
    const b = mkEntry({ pageId: 'b', author: '아빠', takenDate: t1 });
    const result = clusterEntries([a, b]);
    expect(result.find((r) => r.entryId === 'a')!.clusterId)
      .toBe(result.find((r) => r.entryId === 'b')!.clusterId);
  });

  it('10:05:00 → 10:00과 다른 버킷', () => {
    const t0 = new Date('2026-04-12T10:00:00Z');
    const t1 = new Date('2026-04-12T10:05:00Z');
    const a = mkEntry({ pageId: 'a', author: '아빠', takenDate: t0 });
    const b = mkEntry({ pageId: 'b', author: '아빠', takenDate: t1 });
    const result = clusterEntries([a, b]);
    expect(result.find((r) => r.entryId === 'a')!.clusterId)
      .not.toBe(result.find((r) => r.entryId === 'b')!.clusterId);
  });
});

// ────────────────────────────────────────────────────────────────
// Rank and isTop
// ────────────────────────────────────────────────────────────────

describe('clusterEntries – rank ordering and isTop', () => {
  it('군집 내 rank는 점수 내림차순', () => {
    const t = new Date('2026-04-12T10:00:00Z');
    const entries = [
      mkEntry({ pageId: 'a', author: '아빠', takenDate: t }),
      mkEntry({ pageId: 'b', author: '아빠', takenDate: new Date(t.getTime() + 60_000) }),
      mkEntry({ pageId: 'c', author: '아빠', takenDate: new Date(t.getTime() + 120_000) }),
    ];
    const scores = new Map([['a', 90], ['b', 70], ['c', 80]]);
    const result = clusterEntries(entries, scores);
    expect(result.find((r) => r.entryId === 'a')!.rank).toBe(1);
    expect(result.find((r) => r.entryId === 'c')!.rank).toBe(2);
    expect(result.find((r) => r.entryId === 'b')!.rank).toBe(3);
  });

  it('상위 2장만 isTop=true', () => {
    const t = new Date('2026-04-12T10:00:00Z');
    const entries = [
      mkEntry({ pageId: 'a', author: '아빠', takenDate: t }),
      mkEntry({ pageId: 'b', author: '아빠', takenDate: new Date(t.getTime() + 30_000) }),
      mkEntry({ pageId: 'c', author: '아빠', takenDate: new Date(t.getTime() + 90_000) }),
    ];
    const result = clusterEntries(entries);
    const tops = result.filter((r) => r.isTop);
    const nonTops = result.filter((r) => !r.isTop);
    expect(tops).toHaveLength(2);
    expect(nonTops).toHaveLength(1);
  });

  it('동점 시 시간 빠른 순으로 rank 결정', () => {
    const t = new Date('2026-04-12T10:00:00Z');
    const entries = [
      mkEntry({ pageId: 'later', author: '아빠', takenDate: new Date(t.getTime() + 60_000) }),
      mkEntry({ pageId: 'earlier', author: '아빠', takenDate: t }),
    ];
    // Same score → earlier timestamp wins rank 1
    const scores = new Map([['later', 50], ['earlier', 50]]);
    const result = clusterEntries(entries, scores);
    expect(result.find((r) => r.entryId === 'earlier')!.rank).toBe(1);
    expect(result.find((r) => r.entryId === 'later')!.rank).toBe(2);
  });

  it('점수 없으면 시간순으로 정렬 (score 0 기본값)', () => {
    const t = new Date('2026-04-12T10:00:00Z');
    const a = mkEntry({ pageId: 'first', author: '아빠', takenDate: t });
    const b = mkEntry({ pageId: 'second', author: '아빠', takenDate: new Date(t.getTime() + 60_000) });
    const result = clusterEntries([a, b]);
    // Both score 0, so earlier timestamp (a) is rank 1
    expect(result.find((r) => r.entryId === 'first')!.rank).toBe(1);
    expect(result.find((r) => r.entryId === 'second')!.rank).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────
// Non-image filtering
// ────────────────────────────────────────────────────────────────

describe('clusterEntries – non-image types excluded', () => {
  it('Video/Text 타입 제외', () => {
    const entries = [
      mkEntry({ pageId: 'v', type: 'Video' }),
      mkEntry({ pageId: 't', type: 'Text' }),
      mkEntry({ pageId: 'i', type: 'Image' }),
    ];
    const result = clusterEntries(entries);
    expect(result).toHaveLength(1);
    expect(result[0]!.entryId).toBe('i');
  });

  it('Mixed type는 군집화에 포함', () => {
    const t = new Date('2026-04-12T10:00:00Z');
    const entries = [
      mkEntry({ pageId: 'm', type: 'Mixed', author: '아빠', takenDate: t }),
    ];
    const result = clusterEntries(entries);
    expect(result).toHaveLength(1);
    expect(result[0]!.entryId).toBe('m');
  });

  it('이미지와 Mixed를 같은 군집에 합산', () => {
    const t = new Date('2026-04-12T10:00:00Z');
    const entries = [
      mkEntry({ pageId: 'img', type: 'Image', author: '아빠', takenDate: t }),
      mkEntry({ pageId: 'mix', type: 'Mixed', author: '아빠', takenDate: new Date(t.getTime() + 60_000) }),
    ];
    const result = clusterEntries(entries);
    expect(result).toHaveLength(2);
    const cImg = result.find((r) => r.entryId === 'img')!.clusterId;
    const cMix = result.find((r) => r.entryId === 'mix')!.clusterId;
    expect(cImg).toBe(cMix);
  });
});

// ────────────────────────────────────────────────────────────────
// Author normalization (special chars)
// ────────────────────────────────────────────────────────────────

describe('clusterEntries – author normalization', () => {
  it('특수문자 포함 author도 정상 군집화', () => {
    const t = new Date('2026-04-12T10:00:00Z');
    const a = mkEntry({ pageId: 'a', author: '아 빠', takenDate: t });
    const b = mkEntry({ pageId: 'b', author: '아 빠', takenDate: new Date(t.getTime() + 60_000) });
    const result = clusterEntries([a, b]);
    expect(result.find((r) => r.entryId === 'a')!.clusterId)
      .toBe(result.find((r) => r.entryId === 'b')!.clusterId);
  });

  it('공백이 다른 author → 다른 군집 (정규화 후 서로 다름)', () => {
    const t = new Date('2026-04-12T10:00:00Z');
    const a = mkEntry({ pageId: 'a', author: '아빠', takenDate: t });
    const b = mkEntry({ pageId: 'b', author: '아 빠', takenDate: t });
    const result = clusterEntries([a, b]);
    // '아빠' vs '아_빠' — different after normalization
    expect(result.find((r) => r.entryId === 'a')!.clusterId)
      .not.toBe(result.find((r) => r.entryId === 'b')!.clusterId);
  });
});

// ────────────────────────────────────────────────────────────────
// Multiple clusters
// ────────────────────────────────────────────────────────────────

describe('clusterEntries – multiple clusters', () => {
  it('두 개의 author-time 그룹 → 두 개의 독립 군집', () => {
    const dadT = new Date('2026-04-12T09:00:00Z');
    const momT = new Date('2026-04-12T09:00:00Z');
    const entries = [
      mkEntry({ pageId: 'dad1', author: '아빠', takenDate: dadT }),
      mkEntry({ pageId: 'dad2', author: '아빠', takenDate: new Date(dadT.getTime() + 60_000) }),
      mkEntry({ pageId: 'mom1', author: '엄마', takenDate: momT }),
      mkEntry({ pageId: 'mom2', author: '엄마', takenDate: new Date(momT.getTime() + 90_000) }),
    ];
    const result = clusterEntries(entries);
    expect(result).toHaveLength(4);
    const dadCluster = result.find((r) => r.entryId === 'dad1')!.clusterId;
    const momCluster = result.find((r) => r.entryId === 'mom1')!.clusterId;
    expect(dadCluster).not.toBe(momCluster);
    expect(result.find((r) => r.entryId === 'dad2')!.clusterId).toBe(dadCluster);
    expect(result.find((r) => r.entryId === 'mom2')!.clusterId).toBe(momCluster);
  });

  it('같은 author, 시간 간격이 멀면 다른 군집', () => {
    const entries = [
      mkEntry({ pageId: 'early', author: '아빠', takenDate: new Date('2026-04-12T09:00:00Z') }),
      mkEntry({ pageId: 'late', author: '아빠', takenDate: new Date('2026-04-12T09:30:00Z') }),
    ];
    const result = clusterEntries(entries);
    expect(result.find((r) => r.entryId === 'early')!.clusterId)
      .not.toBe(result.find((r) => r.entryId === 'late')!.clusterId);
  });
});
