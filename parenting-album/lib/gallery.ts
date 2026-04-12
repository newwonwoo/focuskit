/**
 * 디지털 앨범 웹 갤러리 HTML 빌더.
 *
 * 순수 함수로 Notion에서 가져온 데이터를 받아 완전한 HTML 문자열을 반환한다.
 * CSS와 클라이언트 JS는 HTML 내부에 인라인으로 포함해 별도의 정적 자산 의존성이 없다.
 *
 * XSS 방지: 모든 사용자 입력은 escapeHtml로 감싼다. URL은 https 검증 후 속성값으로 사용.
 */

import type {
  RawEntryRow,
  WeeklySummaryRow,
  CommentRow,
  NotionUser,
} from './notion.js';

export interface GalleryData {
  year: number;
  month: number;
  entries: RawEntryRow[];
  weeklySummaries: WeeklySummaryRow[];
  commentsByEntry: Map<string, CommentRow[]>;
  activeUsers: NotionUser[];
}

// ────────────────────────────────────────────────────────────────
// Escape helpers
// ────────────────────────────────────────────────────────────────

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHttpsUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}.${m}.${day}`;
}

function formatDateTime(d: Date): string {
  const base = formatDate(d);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${base} ${hh}:${mm}`;
}

function monthLabel(year: number, month: number): string {
  return `${year}년 ${month}월`;
}

// ────────────────────────────────────────────────────────────────
// Week grouping (ISO week, same logic as weekly-summarize.ts)
// ────────────────────────────────────────────────────────────────

interface WeekId {
  year: number;
  week: number;
  weekId: string;
}

function isoWeek(date: Date): WeekId {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year, week, weekId: `${year}-W${String(week).padStart(2, '0')}` };
}

interface GroupedWeek {
  weekId: string;
  summary?: WeeklySummaryRow;
  entries: RawEntryRow[];
}

function groupEntriesByWeek(
  entries: RawEntryRow[],
  summaries: WeeklySummaryRow[],
): GroupedWeek[] {
  const summaryByWeek = new Map<string, WeeklySummaryRow>();
  for (const s of summaries) summaryByWeek.set(s.weekId, s);

  const map = new Map<string, GroupedWeek>();
  for (const entry of entries) {
    const { weekId } = isoWeek(entry.date);
    const existing = map.get(weekId);
    if (existing) {
      existing.entries.push(entry);
    } else {
      map.set(weekId, {
        weekId,
        summary: summaryByWeek.get(weekId),
        entries: [entry],
      });
    }
  }

  return Array.from(map.values())
    .sort((a, b) => a.weekId.localeCompare(b.weekId))
    .map((g) => ({
      ...g,
      entries: g.entries.sort((a, b) => a.date.getTime() - b.date.getTime()),
    }));
}

// ────────────────────────────────────────────────────────────────
// HTML builders
// ────────────────────────────────────────────────────────────────

function renderMediaBlock(entry: RawEntryRow): string {
  if (entry.type === 'Video') {
    const videoSrc = safeHttpsUrl(entry.webVideoUrl) ?? safeHttpsUrl(entry.mediaUrl);
    const posterSrc = safeHttpsUrl(entry.mediaPrintUrl) ?? safeHttpsUrl(entry.mediaThumbUrl);
    if (!videoSrc) return '';
    const durationLabel = entry.videoDuration
      ? `<span class="media-duration">${Math.round(entry.videoDuration)}초</span>`
      : '';
    return `<div class="media media-video">
      <video controls preload="metadata" playsinline${posterSrc ? ` poster="${escapeHtml(posterSrc)}"` : ''}>
        <source src="${escapeHtml(videoSrc)}" type="video/mp4">
      </video>
      ${durationLabel}
    </div>`;
  }
  if (entry.type === 'Image' || entry.type === 'Mixed') {
    const imgSrc = safeHttpsUrl(entry.mediaPrintUrl) ?? safeHttpsUrl(entry.mediaUrl);
    const thumbSrc = safeHttpsUrl(entry.mediaThumbUrl) ?? imgSrc;
    if (!imgSrc) return '';
    return `<div class="media media-image">
      <img src="${escapeHtml(imgSrc)}" loading="lazy" alt="${escapeHtml(entry.rawContent || '사진')}"${thumbSrc !== imgSrc ? ` data-thumb="${escapeHtml(thumbSrc ?? '')}"` : ''}>
    </div>`;
  }
  // Text-only
  return '';
}

function renderComment(c: CommentRow): string {
  return `<li class="comment" data-comment-id="${escapeHtml(c.pageId)}">
    <div class="comment-author">${escapeHtml(c.authorName || '가족')}</div>
    <div class="comment-text">${escapeHtml(c.text)}</div>
    <div class="comment-time">${escapeHtml(formatDateTime(c.createdAt))}</div>
  </li>`;
}

function renderCommentForm(entryPageId: string, users: NotionUser[]): string {
  const options = users
    .filter((u) => u.displayName)
    .map(
      (u) =>
        `<option value="${escapeHtml(u.kakaoUserId)}">${escapeHtml(u.displayName!)}</option>`,
    )
    .join('');
  return `<form class="comment-form" data-entry-id="${escapeHtml(entryPageId)}">
    <div class="comment-form-row">
      <select name="author" class="comment-author-select" required>
        <option value="" disabled selected>이름 선택</option>
        ${options}
      </select>
      <input type="text" name="text" placeholder="댓글 남기기..." maxlength="500" required>
      <button type="submit">보내기</button>
    </div>
    <div class="comment-form-error"></div>
  </form>`;
}

function renderEntry(
  entry: RawEntryRow,
  comments: CommentRow[],
  users: NotionUser[],
): string {
  const media = renderMediaBlock(entry);
  const caption = entry.rawContent.trim()
    ? `<p class="entry-caption">${escapeHtml(entry.rawContent)}</p>`
    : '';
  const metadata = `<div class="entry-meta">
    <span class="entry-author">${escapeHtml(entry.author || '가족')}</span>
    <span class="entry-date">${escapeHtml(formatDateTime(entry.date))}</span>
  </div>`;
  const commentList = comments.length
    ? `<ul class="comment-list">${comments.map(renderComment).join('')}</ul>`
    : '';
  const commentForm = renderCommentForm(entry.pageId, users);

  return `<article class="entry" data-entry-id="${escapeHtml(entry.pageId)}">
    ${media}
    ${caption}
    ${metadata}
    <section class="comments">
      <h4 class="comments-title">댓글 ${comments.length}</h4>
      ${commentList}
      ${commentForm}
    </section>
  </article>`;
}

function renderWeek(
  group: GroupedWeek,
  users: NotionUser[],
  commentsByEntry: Map<string, CommentRow[]>,
  expanded: boolean,
): string {
  const summary = group.summary;
  const title = summary?.weekTitle ? escapeHtml(summary.weekTitle) : escapeHtml(group.weekId);
  const essay = summary?.essay ? `<p class="week-essay">${escapeHtml(summary.essay)}</p>` : '';
  const entries = group.entries
    .map((e) => renderEntry(e, commentsByEntry.get(e.pageId) ?? [], users))
    .join('');
  const photoCount = group.entries.length;
  const commentCount = group.entries.reduce(
    (sum, e) => sum + (commentsByEntry.get(e.pageId)?.length ?? 0),
    0,
  );

  // 주차 날짜 범위 표시 (예: "4월 6일 – 12일")
  const dates = group.entries
    .map((e) => e.date)
    .sort((a, b) => a.getTime() - b.getTime());
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];
  const dateRange =
    startDate && endDate
      ? `${startDate.getUTCMonth() + 1}월 ${startDate.getUTCDate()}일${
          endDate.getUTCDate() !== startDate.getUTCDate() ? ` – ${endDate.getUTCDate()}일` : ''
        }`
      : escapeHtml(group.weekId);

  return `<details class="week" ${expanded ? 'open' : ''}>
    <summary class="week-header">
      <div class="week-header-main">
        <h2 class="week-title">${title}</h2>
        <div class="week-meta">
          <span class="week-date-range">${escapeHtml(dateRange)}</span>
          <span class="week-stats">📸 ${photoCount}${commentCount > 0 ? ` · 💬 ${commentCount}` : ''}</span>
        </div>
      </div>
      <span class="week-toggle-icon" aria-hidden="true">▾</span>
    </summary>
    <div class="week-body">
      ${essay}
      <div class="entries">${entries}</div>
    </div>
  </details>`;
}

// ────────────────────────────────────────────────────────────────
// CSS (inline)
// ────────────────────────────────────────────────────────────────

const CSS = `
:root {
  --bg: #faf8f3;
  --fg: #2a2720;
  --muted: #786f60;
  --accent: #c86a3f;
  --card: #ffffff;
  --border: #e5dfd2;
  --shadow: 0 2px 8px rgba(0,0,0,.05);
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Pretendard', sans-serif;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.6;
  font-size: 16px;
}

.container {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 16px 96px;
}

.album-header {
  text-align: center;
  margin: 24px 0 40px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border);
}

.album-header h1 {
  font-size: 32px;
  font-weight: 600;
  margin: 0 0 8px;
  letter-spacing: -0.02em;
}

.album-header .subtitle {
  color: var(--muted);
  font-size: 14px;
  margin: 0;
}

.week {
  margin-bottom: 16px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
/* 기본 details marker(삼각형) 제거. 자체 토글 아이콘 사용 */
.week > summary { list-style: none; }
.week > summary::-webkit-details-marker { display: none; }

.week-header {
  cursor: pointer;
  padding: 18px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  user-select: none;
  transition: background 0.15s;
}
.week-header:hover {
  background: #fbfaf6;
}
.week-header-main {
  flex: 1;
  min-width: 0;
}
.week-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 4px;
  letter-spacing: -0.01em;
  color: var(--fg);
}
.week-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  font-size: 12px;
  color: var(--muted);
}
.week-date-range {
  font-weight: 500;
}
.week-stats {
  font-variant-numeric: tabular-nums;
}
.week-toggle-icon {
  font-size: 16px;
  color: var(--muted);
  transition: transform 0.2s;
  flex-shrink: 0;
}
.week[open] > summary .week-toggle-icon {
  transform: rotate(180deg);
}
.week-body {
  padding: 0 20px 20px;
  animation: weekBodyFadeIn 0.2s ease-out;
}
@keyframes weekBodyFadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* .week-body 내부에 있으므로 중복 배경/테두리 제거하고 상단 여백만 */
.week-essay {
  background: #fbfaf6;
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  padding: 14px 18px;
  margin: 0 0 20px;
  font-size: 15px;
  line-height: 1.8;
  white-space: pre-wrap;
}

.entries {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.entry {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--shadow);
}

.media { background: #000; display: flex; align-items: center; justify-content: center; }
.media img { max-width: 100%; max-height: 600px; display: block; }
.media video { max-width: 100%; max-height: 600px; display: block; }
.media-duration {
  position: absolute;
  background: rgba(0,0,0,.6);
  color: #fff;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  bottom: 8px;
  right: 8px;
}
.media-video { position: relative; }

.entry-caption {
  padding: 12px 20px 0;
  margin: 0;
  font-size: 15px;
  white-space: pre-wrap;
}

.entry-meta {
  padding: 8px 20px 12px;
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--muted);
}

.entry-author {
  font-weight: 600;
  color: var(--accent);
}

.comments {
  border-top: 1px solid var(--border);
  padding: 16px 20px;
  background: #fbfaf6;
}

.comments-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  margin: 0 0 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.comment-list {
  list-style: none;
  padding: 0;
  margin: 0 0 12px;
}

.comment {
  padding: 10px 12px;
  margin-bottom: 6px;
  background: #fff;
  border-radius: 8px;
  border: 1px solid var(--border);
}

.comment-author {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 2px;
}

.comment-text {
  font-size: 14px;
  white-space: pre-wrap;
}

.comment-time {
  font-size: 11px;
  color: var(--muted);
  margin-top: 4px;
}

.comment-form-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.comment-form select,
.comment-form input[type="text"] {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  font-family: inherit;
  background: #fff;
}

.comment-form select { width: 120px; }
.comment-form input[type="text"] { flex: 1; min-width: 150px; }

.comment-form button {
  padding: 8px 16px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.comment-form button:hover { opacity: 0.9; }
.comment-form button:disabled { opacity: 0.5; cursor: not-allowed; }

.comment-form-error {
  font-size: 12px;
  color: #c24444;
  margin-top: 6px;
  min-height: 14px;
}

.empty {
  text-align: center;
  padding: 80px 20px;
  color: var(--muted);
}

@media (max-width: 560px) {
  .album-header h1 { font-size: 26px; }
  .week-title { font-size: 20px; }
  .comment-form select { width: 100%; }
}
`;

// ────────────────────────────────────────────────────────────────
// Client JavaScript (inline)
// ────────────────────────────────────────────────────────────────

const CLIENT_JS = `
(function() {
  const LAST_AUTHOR_KEY = 'wonwoo-album-last-author';

  // 페이지 로드 시 마지막으로 사용한 이름 드롭다운 복원
  document.querySelectorAll('.comment-author-select').forEach(function(sel) {
    try {
      const last = localStorage.getItem(LAST_AUTHOR_KEY);
      if (last && Array.from(sel.options).some(function(o) { return o.value === last; })) {
        sel.value = last;
      }
    } catch (_) {}
  });

  // 댓글 폼 제출
  document.querySelectorAll('.comment-form').forEach(function(form) {
    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      const entryId = form.dataset.entryId;
      const authorSel = form.querySelector('.comment-author-select');
      const textInput = form.querySelector('input[name="text"]');
      const button = form.querySelector('button');
      const errorDiv = form.querySelector('.comment-form-error');

      const authorKakaoId = authorSel.value;
      const authorName = authorSel.options[authorSel.selectedIndex].textContent;
      const text = textInput.value.trim();

      errorDiv.textContent = '';
      if (!authorKakaoId || !text) {
        errorDiv.textContent = '이름과 내용을 모두 입력해주세요.';
        return;
      }

      button.disabled = true;
      button.textContent = '보내는 중...';

      try {
        const res = await fetch('/api/comment/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            momentRefId: entryId,
            authorKakaoUserId: authorKakaoId,
            authorName: authorName,
            text: text,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(function() { return {}; });
          throw new Error(err.error || ('HTTP ' + res.status));
        }
        const data = await res.json();

        // DOM에 새 댓글 추가
        const list = form.parentElement.querySelector('.comment-list') || (function() {
          const ul = document.createElement('ul');
          ul.className = 'comment-list';
          form.parentElement.insertBefore(ul, form);
          return ul;
        })();

        const li = document.createElement('li');
        li.className = 'comment';
        li.dataset.commentId = data.commentId || '';
        const now = new Date();
        const timeLabel = now.getFullYear() + '.' + String(now.getMonth()+1).padStart(2,'0') + '.' + String(now.getDate()).padStart(2,'0');
        li.innerHTML = '<div class="comment-author"></div><div class="comment-text"></div><div class="comment-time"></div>';
        li.querySelector('.comment-author').textContent = authorName;
        li.querySelector('.comment-text').textContent = text;
        li.querySelector('.comment-time').textContent = timeLabel + ' (방금)';
        list.appendChild(li);

        // 댓글 카운트 업데이트
        const titleEl = form.parentElement.querySelector('.comments-title');
        if (titleEl) {
          const count = list.querySelectorAll('.comment').length;
          titleEl.textContent = '댓글 ' + count;
        }

        textInput.value = '';
        try { localStorage.setItem(LAST_AUTHOR_KEY, authorKakaoId); } catch (_) {}
      } catch (err) {
        errorDiv.textContent = '등록 실패: ' + err.message;
      } finally {
        button.disabled = false;
        button.textContent = '보내기';
      }
    });
  });
})();
`;

// ────────────────────────────────────────────────────────────────
// Main render
// ────────────────────────────────────────────────────────────────

export function renderGallery(data: GalleryData): string {
  const title = `원우 앨범 · ${monthLabel(data.year, data.month)}`;
  const groups = groupEntriesByWeek(data.entries, data.weeklySummaries);
  const totalEntries = data.entries.length;
  const totalComments = Array.from(data.commentsByEntry.values()).reduce(
    (sum, list) => sum + list.length,
    0,
  );

  const body =
    groups.length === 0
      ? `<div class="empty">아직 이 달의 기록이 없어요 🌱</div>`
      : groups
          .map((g, idx) =>
            // 가장 최근 주차(마지막 인덱스)만 펼친 상태로 시작. 나머지는 접어둠.
            renderWeek(g, data.activeUsers, data.commentsByEntry, idx === groups.length - 1),
          )
          .join('');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="container">
  <header class="album-header">
    <h1>${escapeHtml(title)}</h1>
    <p class="subtitle">기록 ${totalEntries}개 · 댓글 ${totalComments}개</p>
  </header>
  <main>${body}</main>
</div>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

export function renderErrorPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="container">
  <header class="album-header">
    <h1>${escapeHtml(title)}</h1>
  </header>
  <div class="empty">${escapeHtml(message)}</div>
</div>
</body>
</html>`;
}
