import { describe, it, expect } from 'vitest';
import { generateIdempotencyKey } from '../../lib/idempotency';

describe('generateIdempotencyKey', () => {
  it('같은 입력 → 같은 키', () => {
    const k1 = generateIdempotencyKey('u1', 1000, '안녕', 'img');
    const k2 = generateIdempotencyKey('u1', 1000, '안녕', 'img');
    expect(k1).toBe(k2);
  });

  it('다른 userId → 다른 키', () => {
    const k1 = generateIdempotencyKey('u1', 1000, '안녕');
    const k2 = generateIdempotencyKey('u2', 1000, '안녕');
    expect(k1).not.toBe(k2);
  });

  it('다른 timestamp → 다른 키', () => {
    const k1 = generateIdempotencyKey('u1', 1000, '안녕');
    const k2 = generateIdempotencyKey('u1', 1001, '안녕');
    expect(k1).not.toBe(k2);
  });

  it('다른 utterance → 다른 키', () => {
    const k1 = generateIdempotencyKey('u1', 1000, '안녕');
    const k2 = generateIdempotencyKey('u1', 1000, '반가워');
    expect(k1).not.toBe(k2);
  });

  it('다른 mediaSignature → 다른 키', () => {
    const k1 = generateIdempotencyKey('u1', 1000, '', 'img1');
    const k2 = generateIdempotencyKey('u1', 1000, '', 'img2');
    expect(k1).not.toBe(k2);
  });

  it('키 길이 16자', () => {
    const k = generateIdempotencyKey('u1', 1000, 'test');
    expect(k).toHaveLength(16);
  });

  it('키는 hex 문자열', () => {
    const k = generateIdempotencyKey('u1', 1000, 'test');
    expect(k).toMatch(/^[0-9a-f]{16}$/);
  });
});
