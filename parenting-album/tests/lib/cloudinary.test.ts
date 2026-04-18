import { describe, it, expect } from 'vitest';
import { parseExifDate, detectMediaKind } from '../../lib/cloudinary';

// ────────────────────────────────────────────────────────────────
// parseExifDate
// ────────────────────────────────────────────────────────────────

describe('parseExifDate', () => {
  it('DateTimeOriginal → Date 파싱', () => {
    const d = parseExifDate({ image_metadata: { DateTimeOriginal: '2026:04:12 14:30:00' } } as any);
    expect(d).toBeInstanceOf(Date);
    expect(d!.toISOString()).toBe('2026-04-12T05:30:00.000Z'); // KST→UTC
  });

  it('DateTime fallback', () => {
    const d = parseExifDate({ image_metadata: { DateTime: '2026:03:01 09:00:00' } } as any);
    expect(d).toBeInstanceOf(Date);
  });

  it('DateTimeDigitized fallback', () => {
    const d = parseExifDate({ image_metadata: { DateTimeDigitized: '2026:01:15 12:00:00' } } as any);
    expect(d).toBeInstanceOf(Date);
  });

  it('DateTimeOriginal 우선 (DateTime보다)', () => {
    const d = parseExifDate({
      image_metadata: { DateTimeOriginal: '2026:04:01 10:00:00', DateTime: '2026:04:02 10:00:00' },
    } as any);
    expect(d!.toISOString()).toContain('2026-04-01');
  });

  it('DateTimeOriginal 없고 DateTime있으면 DateTime 반환', () => {
    const d = parseExifDate({
      image_metadata: { DateTime: '2026:04:02 10:00:00', DateTimeDigitized: '2026:04:03 10:00:00' },
    } as any);
    expect(d!.toISOString()).toContain('2026-04-02');
  });

  it('KST 변환: 2026:04:12 14:30:00 → UTC 05:30:00', () => {
    const d = parseExifDate({ image_metadata: { DateTimeOriginal: '2026:04:12 14:30:00' } } as any);
    expect(d!.toISOString()).toBe('2026-04-12T05:30:00.000Z');
  });

  it('KST 자정(00:00:00) → UTC 전날 15:00', () => {
    const d = parseExifDate({ image_metadata: { DateTimeOriginal: '2026:04:12 00:00:00' } } as any);
    expect(d!.toISOString()).toBe('2026-04-11T15:00:00.000Z');
  });

  it('잘못된 형식 → undefined', () => {
    expect(parseExifDate({ image_metadata: { DateTimeOriginal: 'invalid' } } as any)).toBeUndefined();
  });

  it('부분 일치 → undefined (연도만)', () => {
    expect(parseExifDate({ image_metadata: { DateTimeOriginal: '2026' } } as any)).toBeUndefined();
  });

  it('빈 image_metadata → undefined', () => {
    expect(parseExifDate({ image_metadata: {} } as any)).toBeUndefined();
  });

  it('image_metadata 없음 → undefined', () => {
    expect(parseExifDate({} as any)).toBeUndefined();
  });

  it('null image_metadata → undefined', () => {
    expect(parseExifDate({ image_metadata: null } as any)).toBeUndefined();
  });

  it('빈 문자열 DateTimeOriginal → undefined', () => {
    expect(parseExifDate({ image_metadata: { DateTimeOriginal: '' } } as any)).toBeUndefined();
  });

  it('공백만 DateTimeOriginal → undefined', () => {
    expect(parseExifDate({ image_metadata: { DateTimeOriginal: '   ' } } as any)).toBeUndefined();
  });

  it('반환된 Date 객체의 타임존 오프셋이 UTC임', () => {
    const d = parseExifDate({ image_metadata: { DateTimeOriginal: '2026:06:15 12:00:00' } } as any);
    expect(d).toBeInstanceOf(Date);
    // UTC 03:00 (12:00 KST - 9h)
    expect(d!.getUTCHours()).toBe(3);
    expect(d!.getUTCMinutes()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// detectMediaKind
// ────────────────────────────────────────────────────────────────

describe('detectMediaKind', () => {
  it('Content-Type: image/jpeg → image', () => {
    expect(detectMediaKind('https://x/a', 'image/jpeg')).toBe('image');
  });

  it('Content-Type: image/png → image', () => {
    expect(detectMediaKind('https://x/a', 'image/png')).toBe('image');
  });

  it('Content-Type: image/heic → image', () => {
    expect(detectMediaKind('https://x/a', 'image/heic')).toBe('image');
  });

  it('Content-Type: video/mp4 → video', () => {
    expect(detectMediaKind('https://x/a', 'video/mp4')).toBe('video');
  });

  it('Content-Type: video/quicktime → video', () => {
    expect(detectMediaKind('https://x/a', 'video/quicktime')).toBe('video');
  });

  it('Content-Type 대소문자 구분 없음 (Video/Mp4)', () => {
    expect(detectMediaKind('https://x/a', 'Video/Mp4')).toBe('video');
  });

  it('.mp4 확장자 (CT 없음) → video', () => {
    expect(detectMediaKind('https://x/f.mp4')).toBe('video');
  });

  it('.mov 확장자 → video', () => {
    expect(detectMediaKind('https://x/f.mov')).toBe('video');
  });

  it('.avi 확장자 → video', () => {
    expect(detectMediaKind('https://x/f.avi')).toBe('video');
  });

  it('.mkv 확장자 → video', () => {
    expect(detectMediaKind('https://x/f.mkv')).toBe('video');
  });

  it('.mts 확장자 → video', () => {
    expect(detectMediaKind('https://x/f.mts')).toBe('video');
  });

  it('.jpg 확장자 → image', () => {
    expect(detectMediaKind('https://x/f.jpg')).toBe('image');
  });

  it('.heic 확장자 → image (fallback)', () => {
    expect(detectMediaKind('https://x/f.heic')).toBe('image');
  });

  it('.avif 확장자 → image', () => {
    expect(detectMediaKind('https://x/f.avif')).toBe('image');
  });

  it('.webp 확장자 → image', () => {
    expect(detectMediaKind('https://x/f.webp')).toBe('image');
  });

  it('확장자·CT 없음 → image 기본값', () => {
    expect(detectMediaKind('https://x/abc')).toBe('image');
  });

  it('Content-Type이 확장자보다 우선 (jpg URL + video/mp4 CT → video)', () => {
    expect(detectMediaKind('https://x/f.jpg', 'video/mp4')).toBe('video');
  });

  it('Content-Type이 확장자보다 우선 (mp4 URL + image/jpeg CT → image)', () => {
    expect(detectMediaKind('https://x/f.mp4', 'image/jpeg')).toBe('image');
  });

  it('쿼리파라미터가 붙은 URL의 확장자 판정', () => {
    expect(detectMediaKind('https://x/f.mp4?token=abc&size=large')).toBe('video');
  });

  it('URL에 해시가 붙어도 확장자 판정 동작', () => {
    expect(detectMediaKind('https://x/f.avi#fragment')).toBe('video');
  });
});
