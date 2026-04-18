/**
 * Webhook E2E 테스트 — 카카오 메시지 → 봇 응답 + Notion 저장 전체 흐름.
 * Notion/Cloudinary를 mock하여 실제 API 호출 없이 로직만 검증.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as notionMock from '../mocks/notion-mock';

// Mock 모듈 교체
vi.mock('../../lib/notion.js', () => notionMock);
vi.mock('../../lib/cloudinary.js', () => ({
  uploadFromUrl: vi.fn().mockResolvedValue({
    kind: 'image',
    publicId: 'test-pub-id',
    originalUrl: 'https://res.cloudinary.com/test/image/upload/v1/test.jpg',
    printUrl: 'https://res.cloudinary.com/test/image/upload/v1/test_p.jpg',
    thumbUrl: 'https://res.cloudinary.com/test/image/upload/v1/test_t.jpg',
    width: 2000,
    height: 1500,
    takenAt: new Date('2026-04-12T05:30:00Z'),
  }),
  detectMediaKind: vi.fn().mockReturnValue('image'),
  parseExifDate: vi.fn(),
}));
vi.mock('@vercel/functions', () => ({
  waitUntil: (p: Promise<unknown>) => { p.catch(() => {}); },
}));

// 환경변수 설정
process.env.KAKAO_WEBHOOK_SECRET = 'test-secret';
process.env.NOTION_TOKEN = 'fake';
process.env.NOTION_DB_USERS_ID = 'fake-db';
process.env.NOTION_DB_RAW_ID = 'fake-db';
process.env.NOTION_DB_WEEKLY_ID = 'fake-db';
process.env.NOTION_DB_COMMENTS_ID = 'fake-db';

// webhook handler import
import handler from '../../api/kakao/webhook';

// Mock request/response
function mockReq(body: unknown, secret = 'test-secret') {
  return {
    method: 'POST',
    query: { secret },
    body,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as any;
}

function mockRes() {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    headersSent: false,
  };
  return res;
}

function kakaoPayload(utterance: string, userId = 'test-user-001') {
  return {
    userRequest: {
      utterance,
      user: { id: userId },
      timezone: 'Asia/Seoul',
    },
    action: { params: {}, detailParams: {} },
  };
}

describe('Webhook E2E', () => {
  beforeEach(() => {
    notionMock.resetAll();
  });

  // ── 인증 ──
  it('잘못된 secret → 401', async () => {
    const req = mockReq(kakaoPayload('안녕'), 'wrong-secret');
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('GET 요청 → 405', async () => {
    const req = { ...mockReq({}), method: 'GET' };
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  // ── 신규 사용자 플로우 ──
  it('신규 사용자 "안녕" → 환영 메시지 + Users DB에 row 생성', async () => {
    const req = mockReq(kakaoPayload('안녕'));
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.template.outputs[0].simpleText.text).toContain('원우와 어떤 관계이신가요');

    const users = notionMock._getUsers();
    expect(users).toHaveLength(1);
    expect(users[0].state).toBe('awaiting_name');
  });

  it('관계 답변 "아빠" → 등록 완료 + state=active', async () => {
    // 1단계: 첫 만남
    await handler(mockReq(kakaoPayload('안녕')), mockRes());
    // 2단계: 관계 답변
    const res = mockRes();
    await handler(mockReq(kakaoPayload('아빠')), res);

    const body = res.json.mock.calls[0][0];
    expect(body.template.outputs[0].simpleText.text).toContain('등록 완료');

    const users = notionMock._getUsers();
    expect(users[0].displayName).toBe('아빠');
    expect(users[0].state).toBe('active');
  });

  // ── 등록된 사용자 ──
  it('등록된 사용자 텍스트 메시지 → ACK 응답', async () => {
    notionMock._seedUser({
      pageId: 'u1', kakaoUserId: 'test-user-001', displayName: '아빠',
      state: 'active', firstSeen: new Date(),
    });

    const res = mockRes();
    await handler(mockReq(kakaoPayload('원우 포크질 성공!')), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const text = res.json.mock.calls[0][0].template.outputs[0].simpleText.text;
    expect(text).toContain('아빠');
  });

  // ── 봇 명령어 ──
  it('"앨범" 명령 → 앨범 링크 반환', async () => {
    notionMock._seedUser({
      pageId: 'u1', kakaoUserId: 'test-user-001', displayName: '아빠',
      state: 'active', firstSeen: new Date(),
    });
    process.env.VERCEL_URL = 'test.vercel.app';

    const res = mockRes();
    await handler(mockReq(kakaoPayload('앨범')), res);
    const text = res.json.mock.calls[0][0].template.outputs[0].simpleText.text;
    expect(text).toContain('앨범');
  });

  it('"사진" 명령 → 업로드 링크 반환', async () => {
    notionMock._seedUser({
      pageId: 'u1', kakaoUserId: 'test-user-001', displayName: '아빠',
      state: 'active', firstSeen: new Date(),
    });
    process.env.VERCEL_URL = 'test.vercel.app';

    const res = mockRes();
    await handler(mockReq(kakaoPayload('사진')), res);
    const text = res.json.mock.calls[0][0].template.outputs[0].simpleText.text;
    expect(text).toContain('upload');
  });

  it('"도움말" 명령 → 사용법 안내', async () => {
    notionMock._seedUser({
      pageId: 'u1', kakaoUserId: 'test-user-001', displayName: '아빠',
      state: 'active', firstSeen: new Date(),
    });

    const res = mockRes();
    await handler(mockReq(kakaoPayload('도움말')), res);
    const text = res.json.mock.calls[0][0].template.outputs[0].simpleText.text;
    expect(text).toContain('사용법');
  });

  it('"이름변경" → 상태 awaiting_name으로 리셋', async () => {
    notionMock._seedUser({
      pageId: 'u1', kakaoUserId: 'test-user-001', displayName: '아빠',
      state: 'active', firstSeen: new Date(),
    });

    const res = mockRes();
    await handler(mockReq(kakaoPayload('이름변경')), res);
    const text = res.json.mock.calls[0][0].template.outputs[0].simpleText.text;
    expect(text).toContain('바꿀게요');

    const users = notionMock._getUsers();
    expect(users[0].state).toBe('awaiting_name');
  });

  // ── 중복 관계어 ──
  it('등록된 사용자가 "아빠" 다시 입력 → "이미 등록" 안내 (텍스트 저장 안 됨)', async () => {
    notionMock._seedUser({
      pageId: 'u1', kakaoUserId: 'test-user-001', displayName: '아빠',
      state: 'active', firstSeen: new Date(),
    });

    const res = mockRes();
    await handler(mockReq(kakaoPayload('아빠')), res);
    const text = res.json.mock.calls[0][0].template.outputs[0].simpleText.text;
    expect(text).toContain('이미');
    // Raw_Entry에 저장 안 됨
    expect(notionMock._getEntries()).toHaveLength(0);
  });

  // ── awaiting_name에서 명령어 차단 ──
  it('awaiting_name 상태에서 "앨범" → 등록 먼저 안내 (이름으로 등록 안 됨)', async () => {
    notionMock._seedUser({
      pageId: 'u1', kakaoUserId: 'test-user-001', displayName: null,
      state: 'awaiting_name', firstSeen: new Date(),
    });

    const res = mockRes();
    await handler(mockReq(kakaoPayload('앨범')), res);
    const text = res.json.mock.calls[0][0].template.outputs[0].simpleText.text;
    expect(text).toContain('등록');

    // "앨범"이 이름으로 등록되지 않음
    const users = notionMock._getUsers();
    expect(users[0].displayName).toBeNull();
    expect(users[0].state).toBe('awaiting_name');
  });

  // ── 비활성 사용자 ──
  it('disabled 사용자 → 제한 안내', async () => {
    notionMock._seedUser({
      pageId: 'u1', kakaoUserId: 'test-user-001', displayName: '차단됨',
      state: 'disabled', firstSeen: new Date(),
    });

    const res = mockRes();
    await handler(mockReq(kakaoPayload('안녕')), res);
    const text = res.json.mock.calls[0][0].template.outputs[0].simpleText.text;
    expect(text).toContain('제한');
  });

  // ── OpenBuilder 테스트 페이로드 ──
  it('빈 body → 환영 메시지 (OpenBuilder 테스트 통과)', async () => {
    const res = mockRes();
    await handler(mockReq({}), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const text = res.json.mock.calls[0][0].template.outputs[0].simpleText.text;
    expect(text).toContain('원우');
  });

  // ── SimpleText 빈 문자열 방지 (2401 회귀) ──
  it('응답은 항상 비어있지 않은 SimpleText', async () => {
    const res = mockRes();
    await handler(mockReq(kakaoPayload('안녕')), res);
    const text = res.json.mock.calls[0][0].template.outputs[0].simpleText.text;
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
