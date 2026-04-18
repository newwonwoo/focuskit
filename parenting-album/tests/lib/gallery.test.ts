import { describe, it, expect } from 'vitest';
import { escapeHtml, renderGallery, renderErrorPage } from '../../lib/gallery';
import type { RawEntryRow, WeeklySummaryRow, CommentRow, NotionUser } from '../../lib/notion';

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

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

function baseGalleryData(overrides: Partial<Parameters<typeof renderGallery>[0]> = {}) {
  return {
    year: 2026,
    month: 4,
    entries: [mkEntry()],
    weeklySummaries: [] as WeeklySummaryRow[],
    commentsByEntry: new Map<string, CommentRow[]>(),
    activeUsers: [mockUser],
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────
// escapeHtml
// ────────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('< → &lt;', () => expect(escapeHtml('<')).toBe('&lt;'));
  it('> → &gt;', () => expect(escapeHtml('>')).toBe('&gt;'));
  it('& → &amp;', () => expect(escapeHtml('&')).toBe('&amp;'));
  it('" → &quot;', () => expect(escapeHtml('"')).toBe('&quot;'));
  it("' → &#39;", () => expect(escapeHtml("'")).toBe('&#39;'));

  it('script 태그 완전 이스케이프', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('복합 문자 연속 이스케이프', () => {
    expect(escapeHtml(`"test"&'<>`)).toBe('&quot;test&quot;&amp;&#39;&lt;&gt;');
  });

  it('이스케이프 불필요 문자는 그대로', () => {
    expect(escapeHtml('hello world 안녕')).toBe('hello world 안녕');
  });

  it('빈 문자열 → 빈 문자열', () => {
    expect(escapeHtml('')).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────
// renderGallery
// ────────────────────────────────────────────────────────────────

describe('renderGallery', () => {
  it('빈 entries → "아직 이 달의 기록이 없어요" 메시지', () => {
    const html = renderGallery(baseGalleryData({ entries: [], activeUsers: [] }));
    expect(html).toContain('아직 이 달의 기록이 없어요');
  });

  it('entries 있으면 thumb-grid 포함', () => {
    const html = renderGallery(baseGalleryData());
    expect(html).toContain('thumb-grid');
  });

  it('이미지 엔트리는 thumb-tile 포함', () => {
    const html = renderGallery(baseGalleryData());
    expect(html).toContain('thumb-tile');
  });

  it('이미지 엔트리는 data-type="image"', () => {
    const html = renderGallery(baseGalleryData({ entries: [mkEntry({ type: 'Image' })] }));
    expect(html).toContain('data-type="image"');
  });

  it('영상 엔트리는 data-type="video"', () => {
    const html = renderGallery(baseGalleryData({
      entries: [mkEntry({
        type: 'Video',
        webVideoUrl: 'https://cdn.ex.com/v.mp4',
        videoDuration: 23,
      })],
    }));
    expect(html).toContain('data-type="video"');
  });

  it('AI 에세이 미표시 (v2 디지털 앨범)', () => {
    const html = renderGallery(baseGalleryData({
      weeklySummaries: [{
        pageId: 'w1', weekId: '2026-W15', startDate: new Date(), endDate: new Date(),
        weekTitle: '제목', essay: '에세이 내용 테스트', entryCount: 1, status: 'Summarized',
      }],
    }));
    expect(html).not.toContain('에세이 내용 테스트');
  });

  it('댓글 폼 포함', () => {
    const html = renderGallery(baseGalleryData());
    expect(html).toContain('comment-form');
  });

  it('XSS rawContent 이스케이프', () => {
    const html = renderGallery(baseGalleryData({
      entries: [mkEntry({ rawContent: '<script>xss</script>' })],
    }));
    expect(html).not.toContain('<script>xss</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('월 제목에 올바른 year/month 표시', () => {
    const html = renderGallery(baseGalleryData({ year: 2026, month: 4 }));
    expect(html).toContain('2026년 4월');
  });

  it('월 제목 전체: "원우 앨범 · 2026년 4월"', () => {
    const html = renderGallery(baseGalleryData({ year: 2026, month: 4 }));
    expect(html).toContain('원우 앨범 · 2026년 4월');
  });

  it('다른 월에 대한 정확한 타이틀', () => {
    const html = renderGallery(baseGalleryData({
      year: 2025, month: 12,
      entries: [mkEntry({ date: new Date('2025-12-15T10:00:00Z') })],
    }));
    expect(html).toContain('2025년 12월');
  });

  it('HTML 기본 구조 포함 (doctype, html, head, body)', () => {
    const html = renderGallery(baseGalleryData());
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html');
    expect(html).toContain('<head>');
    expect(html).toContain('<body>');
  });

  it('빈 entries는 thumb-tile을 포함하지 않음 (실제 타일 없음)', () => {
    const html = renderGallery(baseGalleryData({ entries: [], activeUsers: [] }));
    // CSS contains .thumb-grid class definition, but no <div class="thumb-grid"> in body
    expect(html).not.toContain('<div class="thumb-grid">');
  });

  it('rawContent에 XSS가 있어도 이미지 alt 속성에서 이스케이프됨', () => {
    const html = renderGallery(baseGalleryData({
      entries: [mkEntry({ rawContent: '"><img src=x onerror=alert(1)>' })],
    }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

// ────────────────────────────────────────────────────────────────
// renderErrorPage
// ────────────────────────────────────────────────────────────────

describe('renderErrorPage', () => {
  it('제목 이스케이프', () => {
    const html = renderErrorPage('<test>', 'msg');
    expect(html).toContain('&lt;test&gt;');
    expect(html).not.toContain('<test>');
  });

  it('메시지 이스케이프', () => {
    const html = renderErrorPage('title', '"xss"');
    expect(html).toContain('&quot;xss&quot;');
  });

  it('제목이 <title> 태그에 포함', () => {
    const html = renderErrorPage('에러 발생', '잠시 후 다시 시도해주세요');
    expect(html).toContain('<title>에러 발생</title>');
  });

  it('메시지가 페이지 본문에 포함', () => {
    const html = renderErrorPage('에러', '잠시 후 다시 시도해주세요');
    expect(html).toContain('잠시 후 다시 시도해주세요');
  });

  it('title에 싱글쿼트 이스케이프', () => {
    const html = renderErrorPage("it's broken", 'msg');
    expect(html).toContain('&#39;');
    expect(html).not.toContain("'s broken");
  });

  it('메시지에 & 이스케이프', () => {
    const html = renderErrorPage('에러', '오류 A & B');
    expect(html).toContain('오류 A &amp; B');
  });

  it('HTML 기본 구조 포함', () => {
    const html = renderErrorPage('title', 'msg');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html');
  });
});
