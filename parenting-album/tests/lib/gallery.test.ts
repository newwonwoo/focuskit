import { describe, it, expect } from 'vitest';
import { escapeHtml, renderGallery, renderErrorPage } from '../../lib/gallery';
import type { RawEntryRow, WeeklySummaryRow, CommentRow, NotionUser } from '../../lib/notion';

function mkEntry(overrides: Partial<RawEntryRow> = {}): RawEntryRow {
  return {
    pageId: 'e1', idempotencyKey: 'k1',
    date: new Date('2026-04-12T10:00:00Z'), type: 'Image',
    rawContent: '', author: '아빠', authorKakaoUserId: 'dad',
    mediaUrl: 'https://res.cloudinary.com/t/image/upload/v1/a.jpg',
    mediaPrintUrl: 'https://res.cloudinary.com/t/image/upload/v1/a_p.jpg',
    mediaThumbUrl: 'https://res.cloudinary.com/t/image/upload/v1/a_t.jpg',
    status: 'Draft', ...overrides,
  };
}

const mockUser: NotionUser = {
  pageId: 'u1', kakaoUserId: 'dad', displayName: '아빠', state: 'active', firstSeen: new Date(),
};

describe('escapeHtml', () => {
  it('< → &lt;', () => expect(escapeHtml('<')).toBe('&lt;'));
  it('> → &gt;', () => expect(escapeHtml('>')).toBe('&gt;'));
  it('& → &amp;', () => expect(escapeHtml('&')).toBe('&amp;'));
  it('" → &quot;', () => expect(escapeHtml('"')).toBe('&quot;'));
  it("' → &#39;", () => expect(escapeHtml("'")).toBe('&#39;'));
  it('script 태그 완전 이스케이프', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
  it('복합 문자', () => {
    expect(escapeHtml(`"test"&'<>`)).toBe('&quot;test&quot;&amp;&#39;&lt;&gt;');
  });
});

describe('renderGallery', () => {
  it('빈 entries → "기록 없어요" 메시지', () => {
    const html = renderGallery({
      year: 2026, month: 4, entries: [], weeklySummaries: [],
      commentsByEntry: new Map(), activeUsers: [],
    });
    expect(html).toContain('아직 이 달의 기록이 없어요');
  });

  it('entries 있으면 thumb-grid 포함', () => {
    const html = renderGallery({
      year: 2026, month: 4, entries: [mkEntry()], weeklySummaries: [],
      commentsByEntry: new Map(), activeUsers: [mockUser],
    });
    expect(html).toContain('thumb-grid');
  });

  it('thumb-tile 데이터 속성', () => {
    const html = renderGallery({
      year: 2026, month: 4, entries: [mkEntry()], weeklySummaries: [],
      commentsByEntry: new Map(), activeUsers: [mockUser],
    });
    expect(html).toContain('data-type="image"');
  });

  it('영상은 data-type="video"', () => {
    const html = renderGallery({
      year: 2026, month: 4,
      entries: [mkEntry({
        type: 'Video',
        webVideoUrl: 'https://cdn.ex.com/v.mp4',
        videoDuration: 23,
      })],
      weeklySummaries: [], commentsByEntry: new Map(), activeUsers: [mockUser],
    });
    expect(html).toContain('data-type="video"');
  });

  it('AI 에세이 미표시 (v2 디지털 앨범)', () => {
    const html = renderGallery({
      year: 2026, month: 4, entries: [mkEntry()],
      weeklySummaries: [{
        pageId: 'w1', weekId: '2026-W15', startDate: new Date(), endDate: new Date(),
        weekTitle: '제목', essay: '에세이 내용 테스트', entryCount: 1, status: 'Summarized',
      }],
      commentsByEntry: new Map(), activeUsers: [mockUser],
    });
    expect(html).not.toContain('에세이 내용 테스트');
  });

  it('댓글 폼 포함', () => {
    const html = renderGallery({
      year: 2026, month: 4, entries: [mkEntry()],
      weeklySummaries: [], commentsByEntry: new Map(), activeUsers: [mockUser],
    });
    expect(html).toContain('comment-form');
  });

  it('XSS rawContent 이스케이프', () => {
    const html = renderGallery({
      year: 2026, month: 4,
      entries: [mkEntry({ rawContent: '<script>xss</script>' })],
      weeklySummaries: [], commentsByEntry: new Map(), activeUsers: [mockUser],
    });
    expect(html).not.toContain('<script>xss</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('월 제목 정확', () => {
    const html = renderGallery({
      year: 2026, month: 4, entries: [mkEntry()],
      weeklySummaries: [], commentsByEntry: new Map(), activeUsers: [mockUser],
    });
    expect(html).toContain('원우 앨범 · 2026년 4월');
  });
});

describe('renderErrorPage', () => {
  it('제목 이스케이프', () => {
    const html = renderErrorPage('<test>', 'msg');
    expect(html).toContain('&lt;test&gt;');
  });

  it('메시지 이스케이프', () => {
    const html = renderErrorPage('title', '"xss"');
    expect(html).toContain('&quot;xss&quot;');
  });
});
