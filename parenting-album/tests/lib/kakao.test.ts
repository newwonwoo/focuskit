import { describe, it, expect } from 'vitest';
import { kakaoRequestSchema, extractPayload, simpleTextResponse } from '../../lib/kakao';

// ────────────────────────────────────────────────────────────────
// kakaoRequestSchema
// ────────────────────────────────────────────────────────────────

describe('kakaoRequestSchema', () => {
  it('정상 payload 파싱', () => {
    const req = {
      userRequest: { utterance: 'hello', user: { id: 'u1' } },
      action: { params: {} },
    };
    expect(kakaoRequestSchema.safeParse(req).success).toBe(true);
  });

  it('null 필드 허용 (nullish)', () => {
    const req = {
      userRequest: { utterance: null, user: { id: null }, lang: null, timezone: null },
      action: { params: null, detailParams: null, clientExtra: null },
    };
    expect(kakaoRequestSchema.safeParse(req).success).toBe(true);
  });

  it('userRequest 없어도 파싱 성공 (nullish)', () => {
    expect(kakaoRequestSchema.safeParse({}).success).toBe(true);
  });

  it('빈 body 파싱 성공', () => {
    expect(kakaoRequestSchema.safeParse({}).success).toBe(true);
  });

  it('완전한 payload 파싱 (intent, bot, contexts 포함)', () => {
    const req = {
      intent: { id: 'i1', name: '이미지전송' },
      userRequest: {
        utterance: 'hello',
        user: { id: 'u1', type: 'botUserKey' },
        block: { id: 'b1', name: '기본 블록' },
        timezone: 'Asia/Seoul',
        lang: 'ko',
      },
      action: {
        name: 'action1',
        id: 'a1',
        params: { k: 'v' },
        detailParams: { k: { origin: 'v', value: 'v', groupType: '' } },
        clientExtra: {},
      },
      bot: { id: 'bot1', name: '앨범봇' },
      contexts: [],
    };
    const result = kakaoRequestSchema.safeParse(req);
    expect(result.success).toBe(true);
  });

  it('추가 필드가 있어도 파싱 성공 (passthrough)', () => {
    const req = {
      userRequest: { utterance: 'hi', user: { id: 'u1' }, extraField: 'extra' },
      unknownTopLevel: 'value',
    };
    expect(kakaoRequestSchema.safeParse(req).success).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// extractPayload
// ────────────────────────────────────────────────────────────────

describe('extractPayload', () => {
  function parse(req: unknown) {
    return extractPayload(kakaoRequestSchema.parse(req));
  }

  it('userId 추출', () => {
    const p = parse({ userRequest: { user: { id: 'dad' }, utterance: '' } });
    expect(p.userId).toBe('dad');
  });

  it('userId 없으면 빈 문자열', () => {
    const p = parse({});
    expect(p.userId).toBe('');
  });

  it('utterance 추출', () => {
    const p = parse({ userRequest: { user: { id: 'u' }, utterance: '안녕' } });
    expect(p.utterance).toBe('안녕');
  });

  it('utterance가 null이면 빈 문자열', () => {
    const p = parse({ userRequest: { user: { id: 'u' }, utterance: null } });
    expect(p.utterance).toBe('');
  });

  it('utterance에서 단일 이미지 URL 추출', () => {
    const p = parse({
      userRequest: { user: { id: 'u' }, utterance: 'https://cdn.ex.com/photo.jpg' },
    });
    expect(p.mediaUrls).toHaveLength(1);
    expect(p.utterance).toBe('');
  });

  it('utterance에서 여러 URL 추출 (공백 구분)', () => {
    const p = parse({
      userRequest: {
        user: { id: 'u' },
        utterance: 'https://a.com/1.jpg https://b.com/2.png https://c.com/3.mp4',
      },
    });
    expect(p.mediaUrls).toHaveLength(3);
    expect(p.utterance).toBe('');
  });

  it('action.params에서 URL 추출', () => {
    const p = parse({
      userRequest: { user: { id: 'u' }, utterance: '' },
      action: { params: { media: 'https://cdn.ex.com/img.jpg' } },
    });
    expect(p.mediaUrls).toHaveLength(1);
  });

  it('action.detailParams에서 URL 추출 (중첩 객체)', () => {
    const p = parse({
      userRequest: { user: { id: 'u' }, utterance: '' },
      action: { detailParams: { img: { value: 'https://cdn.ex.com/pic.jpeg' } } },
    });
    expect(p.mediaUrls).toHaveLength(1);
  });

  it('utterance에서 URL 제거 후 순수 텍스트 남김', () => {
    const p = parse({
      userRequest: {
        user: { id: 'u' },
        utterance: '원우 사진 https://cdn.ex.com/p.jpg 예쁘다',
      },
    });
    expect(p.mediaUrls).toHaveLength(1);
    expect(p.utterance).toContain('원우 사진');
    expect(p.utterance).toContain('예쁘다');
    expect(p.utterance).not.toContain('https://');
  });

  it('비미디어 URL 필터 (html)', () => {
    const p = parse({
      userRequest: { user: { id: 'u' }, utterance: 'https://example.com/page.html' },
    });
    expect(p.mediaUrls).toHaveLength(0);
  });

  it('비미디어 URL 필터 (pdf)', () => {
    const p = parse({
      userRequest: { user: { id: 'u' }, utterance: 'https://example.com/doc.pdf' },
    });
    expect(p.mediaUrls).toHaveLength(0);
  });

  it('노이즈 params에서 false positive 없음', () => {
    const p = parse({
      userRequest: { user: { id: 'u' }, utterance: 'hi' },
      action: { params: { random: 'not-a-url', num: 123 } },
    });
    expect(p.mediaUrls).toHaveLength(0);
  });

  it('카카오 CDN URL 인식 (/secureimage/ 경로)', () => {
    const p = parse({
      userRequest: {
        user: { id: 'u' },
        utterance: 'https://talk.kakaocdn.net/dna/abc/secureimage/xyz.jpg?cred=x',
      },
    });
    expect(p.mediaUrls).toHaveLength(1);
  });

  it('.avif 확장자 인식', () => {
    const p = parse({
      userRequest: { user: { id: 'u' }, utterance: 'https://cdn.ex.com/a.avif' },
    });
    expect(p.mediaUrls).toHaveLength(1);
  });

  it('.bmp 확장자 인식', () => {
    const p = parse({
      userRequest: { user: { id: 'u' }, utterance: 'https://cdn.ex.com/b.bmp' },
    });
    expect(p.mediaUrls).toHaveLength(1);
  });

  it('.avi 확장자 인식', () => {
    const p = parse({
      userRequest: { user: { id: 'u' }, utterance: 'https://cdn.ex.com/c.avi' },
    });
    expect(p.mediaUrls).toHaveLength(1);
  });

  it('문장 끝 구두점 제거', () => {
    const p = parse({
      userRequest: { user: { id: 'u' }, utterance: 'https://cdn.ex.com/photo.jpg.' },
    });
    expect(p.mediaUrls).toHaveLength(1);
    expect(p.mediaUrls[0]).toBe('https://cdn.ex.com/photo.jpg');
  });

  it('timestamp는 Date 인스턴스', () => {
    const p = parse({ userRequest: { user: { id: 'u' }, utterance: '' } });
    expect(p.timestamp).toBeInstanceOf(Date);
  });

  it('messageBlockId는 block.id에서 추출', () => {
    const p = parse({
      userRequest: {
        user: { id: 'u' },
        utterance: '',
        block: { id: 'block-xyz', name: '블록' },
      },
    });
    expect(p.messageBlockId).toBe('block-xyz');
  });
});

// ────────────────────────────────────────────────────────────────
// simpleTextResponse
// ────────────────────────────────────────────────────────────────

describe('simpleTextResponse', () => {
  it('정상 텍스트', () => {
    const r = simpleTextResponse('hello');
    expect(r.template.outputs[0]!.simpleText.text).toBe('hello');
  });

  it('version은 "2.0"', () => {
    const r = simpleTextResponse('hi');
    expect(r.version).toBe('2.0');
  });

  it('outputs 배열에 simpleText 포함', () => {
    const r = simpleTextResponse('안녕');
    expect(r.template.outputs).toHaveLength(1);
    expect(r.template.outputs[0]).toHaveProperty('simpleText');
    expect(r.template.outputs[0]!.simpleText).toHaveProperty('text');
  });

  it('빈 문자열 → "…"', () => {
    expect(simpleTextResponse('').template.outputs[0]!.simpleText.text).toBe('…');
  });

  it('공백만 → "…"', () => {
    expect(simpleTextResponse('   ').template.outputs[0]!.simpleText.text).toBe('…');
  });

  it('한국어 텍스트 그대로 반환', () => {
    const text = '원우 앨범에 사진이 저장되었어요!';
    expect(simpleTextResponse(text).template.outputs[0]!.simpleText.text).toBe(text);
  });
});
