/**
 * Notion API in-memory mock.
 * vitest에서 vi.mock('../../lib/notion.js', ...) 으로 교체해 사용.
 */

import type {
  NotionUser,
  UserState,
  RawEntryRow,
  RawEntryMediaKind,
  RawEntryStatus,
  CommentRow,
  WeeklySummaryRow,
  CreateRawEntryInput,
  CreateCommentInput,
  CreateWeeklySummaryInput,
  PhotoScoringUpdate,
} from '../../lib/notion.js';

// ── In-memory stores ──
let users: NotionUser[] = [];
let entries: RawEntryRow[] = [];
let comments: CommentRow[] = [];
let weeklySummaries: WeeklySummaryRow[] = [];
let idCounter = 1;

function nextId(): string {
  return `mock-${idCounter++}`;
}

// ── Reset (call in beforeEach) ──
export function resetAll(): void {
  users = [];
  entries = [];
  comments = [];
  weeklySummaries = [];
  idCounter = 1;
}

// ── Users ──
export async function findUserByKakaoId(kakaoUserId: string): Promise<NotionUser | null> {
  return users.find((u) => u.kakaoUserId === kakaoUserId) ?? null;
}

export async function createUser(input: { kakaoUserId: string }): Promise<NotionUser> {
  const user: NotionUser = {
    pageId: nextId(),
    kakaoUserId: input.kakaoUserId,
    displayName: null,
    state: 'awaiting_name',
    firstSeen: new Date(),
  };
  users.push(user);
  return user;
}

export async function updateUserNameAndActivate(
  pageId: string, kakaoUserId: string, displayName: string,
): Promise<void> {
  const u = users.find((x) => x.pageId === pageId);
  if (u) { u.displayName = displayName; u.state = 'active'; }
}

export async function resetUserToAwaitingName(pageId: string, kakaoUserId: string): Promise<void> {
  const u = users.find((x) => x.pageId === pageId);
  if (u) { u.displayName = null; u.state = 'awaiting_name'; }
}

export async function listActiveUsers(): Promise<NotionUser[]> {
  return users.filter((u) => u.state === 'active');
}

// ── Raw_Entry ──
export async function findEntryByIdempotencyKey(key: string): Promise<string | null> {
  const e = entries.find((x) => x.idempotencyKey === key);
  return e?.pageId ?? null;
}

export async function createRawEntry(input: CreateRawEntryInput): Promise<string> {
  const pageId = nextId();
  const row: RawEntryRow = {
    pageId,
    idempotencyKey: input.idempotencyKey,
    date: input.timestamp,
    type: input.mediaKind,
    rawContent: input.rawContent,
    author: input.author,
    authorKakaoUserId: input.authorKakaoUserId,
    mediaUrl: input.media?.originalUrl,
    mediaPrintUrl: input.media?.printUrl,
    mediaThumbUrl: input.media?.thumbUrl,
    webVideoUrl: input.media?.webVideoUrl,
    videoDuration: input.media?.durationSeconds,
    status: 'Draft',
    takenDate: input.takenDate ?? input.media?.takenAt,
    mediaWidth: input.mediaWidth ?? input.media?.width,
    mediaHeight: input.mediaHeight ?? input.media?.height,
  };
  entries.push(row);
  return pageId;
}

export async function queryRawEntriesByMonth(
  year: number, month: number, status?: RawEntryStatus,
): Promise<RawEntryRow[]> {
  return entries.filter((e) => {
    const d = e.takenDate ?? e.date;
    if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month) return false;
    if (status && e.status !== status) return false;
    return true;
  });
}

export async function queryRawEntriesInRange(opts: {
  fromDate: Date; toDate: Date; status?: RawEntryStatus;
}): Promise<RawEntryRow[]> {
  return entries.filter((e) => {
    const d = e.takenDate ?? e.date;
    if (d < opts.fromDate || d > opts.toDate) return false;
    if (opts.status && e.status !== opts.status) return false;
    return true;
  });
}

export async function updateEntriesStatus(
  pageIds: string[], newStatus: RawEntryStatus, weekRefPageId?: string,
): Promise<void> {
  for (const id of pageIds) {
    const e = entries.find((x) => x.pageId === id);
    if (e) e.status = newStatus;
  }
}

export async function updatePhotoScoring(pageId: string, update: PhotoScoringUpdate): Promise<void> {
  const e = entries.find((x) => x.pageId === pageId);
  if (!e) return;
  if (typeof update.qualityScore === 'number') e.qualityScore = update.qualityScore;
  if (update.clusterId !== undefined) e.clusterId = update.clusterId ?? undefined;
  if (update.excludeCode !== undefined) e.excludeCode = update.excludeCode ?? undefined;
}

export async function updateTakenDate(pageId: string, takenDate: Date): Promise<void> {
  const e = entries.find((x) => x.pageId === pageId);
  if (e) e.takenDate = takenDate;
}

export async function updateMediaDimensions(pageId: string, w: number, h: number): Promise<void> {
  const e = entries.find((x) => x.pageId === pageId);
  if (e) { e.mediaWidth = w; e.mediaHeight = h; }
}

// ── Comments ──
export async function createComment(input: CreateCommentInput): Promise<string> {
  const pageId = nextId();
  comments.push({
    pageId,
    momentRefId: input.momentRefId,
    authorName: input.authorName,
    authorKakaoUserId: input.authorKakaoUserId,
    text: input.text,
    createdAt: new Date(),
  });
  return pageId;
}

export async function deleteComment(pageId: string): Promise<void> {
  comments = comments.filter((c) => c.pageId !== pageId);
}

export async function listCommentsForEntries(
  entryPageIds: string[],
): Promise<Map<string, CommentRow[]>> {
  const result = new Map<string, CommentRow[]>();
  for (const id of entryPageIds) {
    const matched = comments.filter((c) => c.momentRefId === id);
    if (matched.length > 0) result.set(id, matched);
  }
  return result;
}

// ── Weekly Summary ──
export async function findWeeklySummaryByWeekId(weekId: string): Promise<WeeklySummaryRow | null> {
  return weeklySummaries.find((s) => s.weekId === weekId) ?? null;
}

export async function createWeeklySummary(input: CreateWeeklySummaryInput): Promise<string> {
  const pageId = nextId();
  weeklySummaries.push({
    pageId,
    weekId: input.weekId,
    startDate: input.startDate,
    endDate: input.endDate,
    weekTitle: input.weekTitle,
    essay: input.essay,
    entryCount: input.entryCount,
    status: 'Summarized',
  });
  return pageId;
}

export async function updateWeeklySummary(
  pageId: string,
  input: Partial<Pick<CreateWeeklySummaryInput, 'weekTitle' | 'essay' | 'entryCount'>>,
): Promise<void> {
  const s = weeklySummaries.find((x) => x.pageId === pageId);
  if (!s) return;
  if (input.weekTitle !== undefined) s.weekTitle = input.weekTitle;
  if (input.essay !== undefined) s.essay = input.essay;
  if (input.entryCount !== undefined) s.entryCount = input.entryCount;
}

export async function queryWeeklySummariesByMonth(
  year: number, month: number,
): Promise<WeeklySummaryRow[]> {
  return weeklySummaries.filter((s) => {
    const d = s.startDate;
    return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month;
  });
}

// ── Helpers for test assertions ──
export function _getUsers(): NotionUser[] { return users; }
export function _getEntries(): RawEntryRow[] { return entries; }
export function _getComments(): CommentRow[] { return comments; }
export function _getWeeklySummaries(): WeeklySummaryRow[] { return weeklySummaries; }

export function _seedUser(u: NotionUser): void { users.push(u); }
export function _seedEntry(e: RawEntryRow): void { entries.push(e); }
export function _seedComment(c: CommentRow): void { comments.push(c); }
