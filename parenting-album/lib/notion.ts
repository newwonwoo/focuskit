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

export interface CreateRawEntryInput {
  idempotencyKey: string;
  timestamp: Date;
  mediaKind: RawEntryMediaKind;
  rawContent: string;
  author: string;
  authorKakaoUserId: string;
  media?: UploadResult;
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

function requireDbId(envName: 'NOTION_DB_USERS_ID' | 'NOTION_DB_RAW_ID'): string {
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
