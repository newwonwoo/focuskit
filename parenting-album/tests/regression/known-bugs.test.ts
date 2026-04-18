import { describe, it, expect } from 'vitest';
import { kakaoRequestSchema, extractPayload, simpleTextResponse } from '../../lib/kakao';
import { scorePhoto, EXCLUDE_CODES } from '../../lib/scoring';
import type { RawEntryRow } from '../../lib/notion';
import * as fs from 'node:fs/promises';

function mkEntry(overrides: Partial<RawEntryRow> = {}): RawEntryRow {
  return {
    pageId: 'p1', idempotencyKey: 'k', date: new Date('2026-04-12T10:00:00Z'),
    type: 'Image', rawContent: '', author: '아빠', authorKakaoUserId: 'dad',
    mediaUrl: 'https://res.cloudinary.com/t/image/upload/v1/a.jpg',
    mediaPrintUrl: 'https://res.cloudinary.com/t/image/upload/v1/a_p.jpg',
    status: 'Draft', ...overrides,
  };
}

describe('회귀 #1: Kakao null 필드 허용', () => {
  it('action 필드 전부 null이어도 파싱 성공', () => {
    const payload = {
      userRequest: { utterance: 'test', user: { id: 'u1' } },
      action: { params: null, detailParams: null, clientExtra: null },
    };
    expect(kakaoRequestSchema.safeParse(payload).success).toBe(true);
  });
  it('userRequest.block=null 허용', () => {
    const payload = { userRequest: { utterance: 'test', user: { id: 'u1' }, block: null } };
    expect(kakaoRequestSchema.safeParse(payload).success).toBe(true);
  });
});

describe('회귀 #2: 빈 SimpleText 방지 (2401)', () => {
  it('빈 → …', () => expect(simpleTextResponse('').template.outputs[0].simpleText.text).toBe('…'));
  it('공백 → …', () => expect(simpleTextResponse('   ').template.outputs[0].simpleText.text).toBe('…'));
  it('정상 유지', () => expect(simpleTextResponse('안녕').template.outputs[0].simpleText.text).toBe('안녕'));
});

describe('회귀 #3: 묶음 URL 다중 추출', () => {
  it('3개 URL 추출', () => {
    const p = kakaoRequestSchema.parse({ userRequest: { utterance: 'https://a.com/1.jpg https://a.com/2.jpg https://a.com/3.jpg', user: { id: 'u' } } });
    expect(extractPayload(p).mediaUrls).toHaveLength(3);
  });
  it('URL 제거 후 빈 utterance', () => {
    const p = kakaoRequestSchema.parse({ userRequest: { utterance: 'https://a.com/x.jpg', user: { id: 'u' } } });
    expect(extractPayload(p).utterance).toBe('');
  });
});

describe('회귀 #4: SMTP fallback', () => {
  it('|| 사용', async () => {
    const src = await fs.readFile('scripts/send-email.ts', 'utf-8');
    expect(src).toContain("|| 'smtp.naver.com'");
  });
});

describe('회귀 #5: Draft 포함', () => {
  it('Status 필터 없이 조회', async () => {
    const src = await fs.readFile('scripts/build-pdf.ts', 'utf-8');
    expect(src).toMatch(/queryRawEntriesByMonth\(\s*year\s*,\s*month\s*\)/);
  });
});

describe('회귀 #6: 업로드 URL 경로', () => {
  it('getUploadUrl 사용', async () => {
    const src = await fs.readFile('api/kakao/webhook.ts', 'utf-8');
    expect(src).toContain('getUploadUrl(');
  });
});

describe('회귀 #7: is_hidden 점수 0', () => {
  it('HIDDEN_BY_USER', () => {
    const r = scorePhoto(mkEntry({ isHidden: true, mediaWidth: 3000 }), { commentCount: 5, totalPhotosSameDay: 1, isFirstOfDay: true, isClusterTop: true });
    expect(r.qualityScore).toBe(0);
    expect(r.excludeCode).toBe(EXCLUDE_CODES.HIDDEN_BY_USER);
  });
});
