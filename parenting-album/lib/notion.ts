import { Client, isFullPage } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints.js';

import type { UploadResult } from './cloudinary.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export type UserState = 'awaiting_name' | 'active' | 'disabled';

export interface NotionUser {
  pageId: string;
  kakaoUserId: string;
  displayName: string | null;
  state: UserState;
  firstSeen: Date;
}

export type RawEntryMediaKind = 'Text' | 'Image' | 'Video' | 'Mixed';
export type RawEntryStatus = 'Draft' | 'Summarized' | 'Printed';

export interface CreateRawEntryInput {
  idempotencyKey: string;
  timestamp: Date;
  mediaKind: RawEntryMediaKind;
  rawContent: string;
  author: string;
  authorKakaoUserId: string;
  media?: UploadResult;
}

export interface RawEntryRow {
  pageId: string;
  idempotencyKey: string;
  date: Date;
  type: RawEntryMediaKind;
  rawContent: string;
  author: string;
  authorKakaoUserId: string;
  mediaUrl?: string;
  mediaPrintUrl?: string;
  mediaThumbUrl?: string;
  webVideoUrl?: string;
  videoDuration?: number;
  status: RawEntryStatus;
}

export interface CommentRow {
  pageId: string;
  momentRefId: string;
  authorName: string;
  authorKakaoUserId: string;
  text: string;
  createdAt: Date;
}

export interface CreateCommentInput {
  momentRefId: string;
  authorName: string;
  authorKakaoUserId: string;
  text: string;
  ipHash: string;
}

export type WeeklyStatus = 'Pending' | 'Summarized' | 'Printed';

export interface WeeklySummaryRow {
  pageId: string;
  weekId: string;
  startDate: Date;
  endDate: Date;
  weekTitle: string;
  essay: string;
  entryCount: number;
  status: WeeklyStatus;
}

export interface CreateWeeklySummaryInput {
  weekId: string;
  startDate: Date;
  endDate: Date;
  weekTitle: string;
  essay: string;
  entryCount: number;
}

// ────────────────────────────────────────────────────────────────
// Client bootstrap
// ────────────────────────────────────────────────────────────────

let clientInstance: Client | null = null;
function getClient(): Client {
  if (!clientInstance) {
    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error('[notion] NOTION_TOKEN is not set');
    clientInstance = new Client({ auth: token });
  }
  return clientInstance;
}

type DbEnvName =
  | 'NOTION_DB_USERS_ID'
  | 'NOTION_DB_RAW_ID'
  | 'NOTION_DB_WEEKLY_ID'
  | 'NOTION_DB_COMMENTS_ID';

function requireDbId(envName: DbEnvName): string {
  const value = process.env[envName];
  if (!value) throw new Error(`[notion] ${envName} is not set`);
  return value;
}

// ────────────────────────────────────────────────────────────────
// In-memory user cache (per serverless instance, 60s TTL)
// ────────────────────────────────────────────────────────────────

const USER_CACHE_TTL_MS = 60_000;
const userCache = new Map<string, { user: NotionUser; expiresAt: number }>();

function cacheGet(kakaoUserId: string): NotionUser | null {
  const entry = userCache.get(kakaoUserId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    userCache.delete(kakaoUserId);
    return null;
  }
  return entry.user;
}

function cacheSet(user: NotionUser): void {
  userCache.set(user.kakaoUserId, {
    user,
    expiresAt: Date.now() + USER_CACHE_TTL_MS,
  });
}

function cacheInvalidate(kakaoUserId: string): void {
  userCache.delete(kakaoUserId);
}

// ────────────────────────────────────────────────────────────────
// Notion property builders (write)
// ────────────────────────────────────────────────────────────────

function titleText(value: string) {
  return {
    title: [{ type: 'text' as const, text: { content: value } }],
  };
}

function richText(value: string) {
  return {
    rich_text: [{ type: 'text' as const, text: { content: value } }],
  };
}

function selectOpt(value: string) {
  return { select: { name: value } };
}

function statusOpt(value: string) {
  return { status: { name: value } };
}

function dateProp(value: Date) {
  return { date: { start: value.toISOString() } };
}

function urlProp(value: string | undefined | null) {
  return { url: value ?? null };
}

function numberProp(value: number | undefined | null) {
  return { number: value ?? null };
}

// ────────────────────────────────────────────────────────────────
// Notion property readers
// ────────────────────────────────────────────────────────────────

function readTitle(page: PageObjectResponse, propName: string): string {
  const prop = page.properties[propName];
  if (prop?.type !== 'title') return '';
  return prop.title.map((t) => t.plain_text).join('');
}

function readRichText(page: PageObjectResponse, propName: string): string {
  const prop = page.properties[propName];
  if (prop?.type !== 'rich_text') return '';
  return prop.rich_text.map((t) => t.plain_text).join('');
}

function readSelectName(page: PageObjectResponse, propName: string): string | null {
  const prop = page.properties[propName];
  if (prop?.type !== 'select') return null;
  return prop.select?.name ?? null;
}

function readDate(page: PageObjectResponse, propName: string): Date | null {
  const prop = page.properties[propName];
  if (prop?.type !== 'date') return null;
  const start = prop.date?.start;
  return start ? new Date(start) : null;
}

function readUrl(page: PageObjectResponse, propName: string): string | undefined {
  const prop = page.properties[propName];
  if (prop?.type !== 'url') return undefined;
  return prop.url ?? undefined;
}

function readNumber(page: PageObjectResponse, propName: string): number | undefined {
  const prop = page.properties[propName];
  if (prop?.type !== 'number') return undefined;
  return prop.number ?? undefined;
}

function readStatusName(page: PageObjectResponse, propName: string): string | null {
  const prop = page.properties[propName];
  if (prop?.type !== 'status') return null;
  return prop.status?.name ?? null;
}

function readRelationIds(page: PageObjectResponse, propName: string): string[] {
  const prop = page.properties[propName];
  if (prop?.type !== 'relation') return [];
  return prop.relation.map((r) => r.id);
}

function normalizeUserState(raw: string | null): UserState {
  if (raw === 'active' || raw === 'awaiting_name' || raw === 'disabled') return raw;
  return 'awaiting_name';
}

// ────────────────────────────────────────────────────────────────
// Users DB
// ────────────────────────────────────────────────────────────────

export async function findUserByKakaoId(kakaoUserId: string): Promise<NotionUser | null> {
  const cached = cacheGet(kakaoUserId);
  if (cached) return cached;

  const dbId = requireDbId('NOTION_DB_USERS_ID');
  const res = await getClient().databases.query({
    database_id: dbId,
    filter: {
      property: 'kakao_user_id',
      title: { equals: kakaoUserId },
    },
    page_size: 1,
  });

  const page = res.results[0];
  if (!page || !isFullPage(page)) return null;

  const displayNameRaw = readRichText(page, 'display_name');
  const displayName = displayNameRaw === '' ? null : displayNameRaw;
  const stateRaw = readSelectName(page, 'state');
  const firstSeen = readDate(page, 'first_seen') ?? new Date(page.created_time);

  const user: NotionUser = {
    pageId: page.id,
    kakaoUserId: readTitle(page, 'kakao_user_id') || kakaoUserId,
    displayName,
    state: normalizeUserState(stateRaw),
    firstSeen,
  };
  cacheSet(user);
  return user;
}

export async function createUser(input: { kakaoUserId: string }): Promise<NotionUser> {
  const dbId = requireDbId('NOTION_DB_USERS_ID');
  const now = new Date();
  const res = await getClient().pages.create({
    parent: { database_id: dbId },
    properties: {
      kakao_user_id: titleText(input.kakaoUserId),
      display_name: richText(''),
      state: selectOpt('awaiting_name'),
      first_seen: dateProp(now),
      last_seen: dateProp(now),
    },
  });

  const user: NotionUser = {
    pageId: res.id,
    kakaoUserId: input.kakaoUserId,
    displayName: null,
    state: 'awaiting_name',
    firstSeen: now,
  };
  cacheSet(user);
  return user;
}

export async function updateUserNameAndActivate(
  pageId: string,
  kakaoUserId: string,
  displayName: string,
): Promise<void> {
  await getClient().pages.update({
    page_id: pageId,
    properties: {
      display_name: richText(displayName),
      state: selectOpt('active'),
      last_seen: dateProp(new Date()),
    },
  });
  cacheInvalidate(kakaoUserId);
}

// ────────────────────────────────────────────────────────────────
// Raw_Entry DB
// ────────────────────────────────────────────────────────────────

export async function findEntryByIdempotencyKey(key: string): Promise<string | null> {
  const dbId = requireDbId('NOTION_DB_RAW_ID');
  const res = await getClient().databases.query({
    database_id: dbId,
    filter: {
      property: 'ID',
      title: { equals: key },
    },
    page_size: 1,
  });
  return res.results[0]?.id ?? null;
}

export async function createRawEntry(input: CreateRawEntryInput): Promise<string> {
  const dbId = requireDbId('NOTION_DB_RAW_ID');
  const { media } = input;

  const properties: Record<string, unknown> = {
    ID: titleText(input.idempotencyKey),
    Date: dateProp(input.timestamp),
    Type: selectOpt(input.mediaKind),
    Raw_Content: richText(input.rawContent),
    Author: richText(input.author),
    Author_ID: richText(input.authorKakaoUserId),
    Status: statusOpt('Draft'),
  };

  if (media) {
    properties.Media_URL = urlProp(media.originalUrl);
    properties.Media_Print_URL = urlProp(media.printUrl);
    properties.Media_Thumb_URL = urlProp(media.thumbUrl);
    if (media.kind === 'video') {
      properties.Web_Video_URL = urlProp(media.webVideoUrl);
      properties.Video_Duration = numberProp(media.durationSeconds);
    }
  }

  const res = await getClient().pages.create({
    parent: { database_id: dbId },
    // Notion SDK의 properties 타입은 매우 엄격하므로 런타임에서 검증된 값을 unknown 캐스팅.
    properties: properties as never,
  });
  return res.id;
}

// ────────────────────────────────────────────────────────────────
// Raw_Entry — read queries (Step 2/3 에서 사용)
// ────────────────────────────────────────────────────────────────

function normalizeRawEntryStatus(raw: string | null): RawEntryStatus {
  if (raw === 'Draft' || raw === 'Summarized' || raw === 'Printed') return raw;
  return 'Draft';
}

function normalizeMediaKind(raw: string | null): RawEntryMediaKind {
  if (raw === 'Text' || raw === 'Image' || raw === 'Video' || raw === 'Mixed') return raw;
  return 'Text';
}

function pageToRawEntry(page: PageObjectResponse): RawEntryRow {
  return {
    pageId: page.id,
    idempotencyKey: readTitle(page, 'ID'),
    date: readDate(page, 'Date') ?? new Date(page.created_time),
    type: normalizeMediaKind(readSelectName(page, 'Type')),
    rawContent: readRichText(page, 'Raw_Content'),
    author: readRichText(page, 'Author'),
    authorKakaoUserId: readRichText(page, 'Author_ID'),
    mediaUrl: readUrl(page, 'Media_URL'),
    mediaPrintUrl: readUrl(page, 'Media_Print_URL'),
    mediaThumbUrl: readUrl(page, 'Media_Thumb_URL'),
    webVideoUrl: readUrl(page, 'Web_Video_URL'),
    videoDuration: readNumber(page, 'Video_Duration'),
    status: normalizeRawEntryStatus(readStatusName(page, 'Status')),
  };
}

/**
 * 지정 구간의 Raw_Entry를 페이징하며 전부 수집.
 * Notion은 한 번에 최대 100개씩 반환하므로 has_more 따라 반복.
 */
async function queryAllPages(
  dbId: string,
  filter: Record<string, unknown>,
  sortField: string,
): Promise<PageObjectResponse[]> {
  const all: PageObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const res = await getClient().databases.query({
      database_id: dbId,
      filter: filter as never,
      sorts: [{ property: sortField, direction: 'ascending' }],
      start_cursor: cursor,
      page_size: 100,
    });
    for (const row of res.results) {
      if (isFullPage(row)) all.push(row);
    }
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return all;
}

export interface QueryDraftEntriesOptions {
  fromDate: Date;
  toDate: Date;
  status?: RawEntryStatus;
}

export async function queryRawEntriesInRange(
  opts: QueryDraftEntriesOptions,
): Promise<RawEntryRow[]> {
  const dbId = requireDbId('NOTION_DB_RAW_ID');
  const filter = {
    and: [
      {
        property: 'Date',
        date: { on_or_after: opts.fromDate.toISOString() },
      },
      {
        property: 'Date',
        date: { on_or_before: opts.toDate.toISOString() },
      },
      ...(opts.status
        ? [{ property: 'Status', status: { equals: opts.status } }]
        : []),
    ],
  };
  const pages = await queryAllPages(dbId, filter, 'Date');
  return pages.map(pageToRawEntry);
}

export async function queryRawEntriesByMonth(
  year: number,
  month: number,
  status?: RawEntryStatus,
): Promise<RawEntryRow[]> {
  const from = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(year, month, 0, 23, 59, 59));
  return queryRawEntriesInRange({ fromDate: from, toDate: to, status });
}

export async function updateEntriesStatus(
  pageIds: string[],
  newStatus: RawEntryStatus,
  weekRefPageId?: string,
): Promise<void> {
  const client = getClient();
  for (const pageId of pageIds) {
    const properties: Record<string, unknown> = {
      Status: statusOpt(newStatus),
    };
    if (weekRefPageId) {
      properties.Week_Ref = { relation: [{ id: weekRefPageId }] };
    }
    await client.pages.update({
      page_id: pageId,
      properties: properties as never,
    });
  }
}

// ────────────────────────────────────────────────────────────────
// Weekly_Summary DB
// ────────────────────────────────────────────────────────────────

function pageToWeeklySummary(page: PageObjectResponse): WeeklySummaryRow {
  return {
    pageId: page.id,
    weekId: readTitle(page, 'Week_ID'),
    startDate: readDate(page, 'Start_Date') ?? new Date(page.created_time),
    endDate: readDate(page, 'End_Date') ?? new Date(page.created_time),
    weekTitle: readRichText(page, 'Week_Title'),
    essay: readRichText(page, 'Essay'),
    entryCount: readNumber(page, 'Entry_Count') ?? 0,
    status: (readStatusName(page, 'Status') as WeeklyStatus | null) ?? 'Pending',
  };
}

export async function findWeeklySummaryByWeekId(
  weekId: string,
): Promise<WeeklySummaryRow | null> {
  const dbId = requireDbId('NOTION_DB_WEEKLY_ID');
  const res = await getClient().databases.query({
    database_id: dbId,
    filter: {
      property: 'Week_ID',
      title: { equals: weekId },
    },
    page_size: 1,
  });
  const page = res.results[0];
  if (!page || !isFullPage(page)) return null;
  return pageToWeeklySummary(page);
}

export async function createWeeklySummary(
  input: CreateWeeklySummaryInput,
): Promise<string> {
  const dbId = requireDbId('NOTION_DB_WEEKLY_ID');
  const res = await getClient().pages.create({
    parent: { database_id: dbId },
    properties: {
      Week_ID: titleText(input.weekId),
      Start_Date: dateProp(input.startDate),
      End_Date: dateProp(input.endDate),
      Week_Title: richText(input.weekTitle),
      Essay: richText(input.essay),
      Entry_Count: numberProp(input.entryCount),
      Status: statusOpt('Summarized'),
    } as never,
  });
  return res.id;
}

export async function updateWeeklySummary(
  pageId: string,
  input: Partial<Pick<CreateWeeklySummaryInput, 'weekTitle' | 'essay' | 'entryCount'>>,
): Promise<void> {
  const properties: Record<string, unknown> = {};
  if (input.weekTitle !== undefined) properties.Week_Title = richText(input.weekTitle);
  if (input.essay !== undefined) properties.Essay = richText(input.essay);
  if (input.entryCount !== undefined) properties.Entry_Count = numberProp(input.entryCount);
  properties.Status = statusOpt('Summarized');
  await getClient().pages.update({
    page_id: pageId,
    properties: properties as never,
  });
}

export async function queryWeeklySummariesByMonth(
  year: number,
  month: number,
): Promise<WeeklySummaryRow[]> {
  const dbId = requireDbId('NOTION_DB_WEEKLY_ID');
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0, 23, 59, 59));
  const filter = {
    and: [
      {
        property: 'Start_Date',
        date: { on_or_after: from.toISOString() },
      },
      {
        property: 'Start_Date',
        date: { on_or_before: to.toISOString() },
      },
    ],
  };
  const pages = await queryAllPages(dbId, filter, 'Start_Date');
  return pages.map(pageToWeeklySummary);
}

// ────────────────────────────────────────────────────────────────
// Comments DB
// ────────────────────────────────────────────────────────────────

function pageToComment(page: PageObjectResponse): CommentRow {
  const relations = readRelationIds(page, 'moment_ref');
  return {
    pageId: page.id,
    momentRefId: relations[0] ?? '',
    authorName: readRichText(page, 'author_name'),
    authorKakaoUserId: readRichText(page, 'author_kakao_id'),
    text: readRichText(page, 'text'),
    createdAt: readDate(page, 'created_at') ?? new Date(page.created_time),
  };
}

export async function createComment(input: CreateCommentInput): Promise<string> {
  const dbId = requireDbId('NOTION_DB_COMMENTS_ID');
  const commentId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const res = await getClient().pages.create({
    parent: { database_id: dbId },
    properties: {
      comment_id: titleText(commentId),
      moment_ref: { relation: [{ id: input.momentRefId }] },
      author_name: richText(input.authorName),
      author_kakao_id: richText(input.authorKakaoUserId),
      text: richText(input.text),
      created_at: dateProp(new Date()),
      ip_hash: richText(input.ipHash),
    } as never,
  });
  return res.id;
}

export async function deleteComment(pageId: string): Promise<void> {
  await getClient().pages.update({
    page_id: pageId,
    archived: true,
  });
}

export async function listCommentsForEntries(
  entryPageIds: string[],
): Promise<Map<string, CommentRow[]>> {
  if (entryPageIds.length === 0) return new Map();
  const dbId = requireDbId('NOTION_DB_COMMENTS_ID');
  const filter = {
    or: entryPageIds.map((id) => ({
      property: 'moment_ref',
      relation: { contains: id },
    })),
  };
  const pages = await queryAllPages(dbId, filter, 'created_at');
  const grouped = new Map<string, CommentRow[]>();
  for (const page of pages) {
    const row = pageToComment(page);
    if (!row.momentRefId) continue;
    const list = grouped.get(row.momentRefId) ?? [];
    list.push(row);
    grouped.set(row.momentRefId, list);
  }
  return grouped;
}

// ────────────────────────────────────────────────────────────────
// Users DB — list for comment author dropdown
// ────────────────────────────────────────────────────────────────

export async function listActiveUsers(): Promise<NotionUser[]> {
  const dbId = requireDbId('NOTION_DB_USERS_ID');
  const res = await getClient().databases.query({
    database_id: dbId,
    filter: {
      property: 'state',
      select: { equals: 'active' },
    },
    page_size: 100,
  });
  const users: NotionUser[] = [];
  for (const page of res.results) {
    if (!isFullPage(page)) continue;
    users.push({
      pageId: page.id,
      kakaoUserId: readTitle(page, 'kakao_user_id'),
      displayName: readRichText(page, 'display_name') || null,
      state: 'active',
      firstSeen: readDate(page, 'first_seen') ?? new Date(page.created_time),
    });
  }
  return users;
}
