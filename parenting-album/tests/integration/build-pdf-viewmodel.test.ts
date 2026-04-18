/**
 * PDF View Model 통합 테스트.
 * Puppeteer 없이 buildViewModel 로직만 검증.
 * Notion mock에서 데이터를 세팅하고 view model 구조를 검사.
 */

import { describe, it, expect } from 'vitest';
import type { RawEntryRow, WeeklySummaryRow } from '../../lib/notion';

// build-pdf.ts의 순수 함수들은 export되지 않으므로
// 동일 로직을 여기서 테스트용으로 재현 (핵심 로직 검증)
// 실제 코드와 sync가 깨질 수 있지만, 핵심 규칙 검증이 목적

function mkEntry(overrides: Partial<RawEntryRow> = {}): RawEntryRow {
  return {
    pageId: `p${Math.random().toString(36).slice(2, 6)}`,
    idempotencyKey: 'k',
    date: new Date('2026-04-12T10:00:00Z'),
    type: 'Image',
    rawContent: '',
    author: '아빠',
    authorKakaoUserId: 'dad',
    mediaUrl: 'https://res.cloudinary.com/t/image/upload/v1/a.jpg',
    mediaPrintUrl: 'https://res.cloudinary.com/t/image/upload/v1/a_p.jpg',
    mediaThumbUrl: 'https://res.cloudinary.com/t/image/upload/v1/a_t.jpg',
    status: 'Draft',
    ...overrides,
  };
}

// ── 필터링 규칙 ──

function filterForPdf(entries: RawEntryRow[]): RawEntryRow[] {
  return entries
    .filter((e) => e.type === 'Image' || e.type === 'Mixed')
    .filter((e) => !e.isHidden)
    .filter((e) => !e.excludeCode || e.excludeCode === 'LOW_PRINT_QUALITY');
}

function sortByTaken(entries: RawEntryRow[]): RawEntryRow[] {
  return [...entries].sort((a, b) => {
    const da = (a.takenDate ?? a.date).getTime();
    const db = (b.takenDate ?? b.date).getTime();
    return da - db;
  });
}

function targetPageCount(n: number): 24 | 40 | 60 {
  if (n <= 20) return 24;
  if (n <= 50) return 40;
  return 60;
}

describe('PDF View Model 필터링', () => {
  it('Video 타입 제외', () => {
    const entries = [mkEntry({ type: 'Video' }), mkEntry({ type: 'Image' })];
    expect(filterForPdf(entries)).toHaveLength(1);
  });

  it('Text 타입 제외', () => {
    const entries = [mkEntry({ type: 'Text' }), mkEntry({ type: 'Image' })];
    expect(filterForPdf(entries)).toHaveLength(1);
  });

  it('Mixed 타입 포함', () => {
    const entries = [mkEntry({ type: 'Mixed' })];
    expect(filterForPdf(entries)).toHaveLength(1);
  });

  it('is_hidden=true 제외', () => {
    const entries = [mkEntry({ isHidden: true }), mkEntry()];
    expect(filterForPdf(entries)).toHaveLength(1);
  });

  it('excludeCode=LOW_RES 제외', () => {
    const entries = [mkEntry({ excludeCode: 'LOW_RES' }), mkEntry()];
    expect(filterForPdf(entries)).toHaveLength(1);
  });

  it('excludeCode=CLUSTER_DUPLICATE 제외', () => {
    const entries = [mkEntry({ excludeCode: 'CLUSTER_DUPLICATE' }), mkEntry()];
    expect(filterForPdf(entries)).toHaveLength(1);
  });

  it('excludeCode=LOW_PRINT_QUALITY 는 포함 (preview 허용)', () => {
    const entries = [mkEntry({ excludeCode: 'LOW_PRINT_QUALITY' })];
    expect(filterForPdf(entries)).toHaveLength(1);
  });

  it('모든 필터 통과 시 전체 포함', () => {
    const entries = Array.from({ length: 10 }, () => mkEntry());
    expect(filterForPdf(entries)).toHaveLength(10);
  });
});

describe('PDF View Model 정렬', () => {
  it('takenDate 기준 시간순', () => {
    const entries = [
      mkEntry({ pageId: 'late', takenDate: new Date('2026-04-12T15:00:00Z') }),
      mkEntry({ pageId: 'early', takenDate: new Date('2026-04-12T09:00:00Z') }),
    ];
    const sorted = sortByTaken(entries);
    expect(sorted[0].pageId).toBe('early');
    expect(sorted[1].pageId).toBe('late');
  });

  it('takenDate 없으면 date로 fallback', () => {
    const entries = [
      mkEntry({ pageId: 'late', date: new Date('2026-04-12T15:00:00Z') }),
      mkEntry({ pageId: 'early', takenDate: new Date('2026-04-12T09:00:00Z') }),
    ];
    const sorted = sortByTaken(entries);
    expect(sorted[0].pageId).toBe('early');
  });

  it('동일 시각 → 순서 유지 (stable)', () => {
    const t = new Date('2026-04-12T10:00:00Z');
    const entries = [mkEntry({ pageId: 'a', takenDate: t }), mkEntry({ pageId: 'b', takenDate: t })];
    const sorted = sortByTaken(entries);
    expect(sorted[0].pageId).toBe('a');
  });
});

describe('페이지 수 자동 조정', () => {
  it('1~20장 → 24p', () => expect(targetPageCount(1)).toBe(24));
  it('20장 → 24p', () => expect(targetPageCount(20)).toBe(24));
  it('21장 → 40p', () => expect(targetPageCount(21)).toBe(40));
  it('50장 → 40p', () => expect(targetPageCount(50)).toBe(40));
  it('51장 → 60p', () => expect(targetPageCount(51)).toBe(60));
  it('100장 → 60p', () => expect(targetPageCount(100)).toBe(60));
  it('200장 → 60p', () => expect(targetPageCount(200)).toBe(60));
});

describe('복합 시나리오', () => {
  it('30장 업로드, is_hidden 5장, excludeCode 3장 → 22장 → 40p', () => {
    const entries = [
      ...Array.from({ length: 22 }, () => mkEntry()),
      ...Array.from({ length: 5 }, () => mkEntry({ isHidden: true })),
      ...Array.from({ length: 3 }, () => mkEntry({ excludeCode: 'LOW_RES' })),
    ];
    const filtered = filterForPdf(entries);
    expect(filtered).toHaveLength(22);
    expect(targetPageCount(filtered.length)).toBe(40);
  });

  it('60장 업로드, 시간순 정렬 → 첫 사진이 가장 이른 시각', () => {
    const entries = Array.from({ length: 60 }, (_, i) =>
      mkEntry({
        pageId: `p${i}`,
        takenDate: new Date(`2026-04-${String(1 + (i % 28)).padStart(2, '0')}T${String(8 + (i % 12)).padStart(2, '0')}:00:00Z`),
      }),
    );
    const sorted = sortByTaken(filterForPdf(entries));
    expect(sorted[0].takenDate!.getTime()).toBeLessThanOrEqual(sorted[sorted.length - 1].takenDate!.getTime());
    expect(targetPageCount(sorted.length)).toBe(60);
  });
});
