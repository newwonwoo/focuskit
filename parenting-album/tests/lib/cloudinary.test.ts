import { describe, it, expect } from 'vitest';
import { parseExifDate, detectMediaKind } from '../../lib/cloudinary';

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

  it('잘못된 형식 → undefined', () => {
    expect(parseExifDate({ image_metadata: { DateTimeOriginal: 'invalid' } } as any)).toBeUndefined();
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
});

describe('detectMediaKind', () => {
  it('Content-Type: image/jpeg → image', () => {
    expect(detectMediaKind('https://x/a', 'image/jpeg')).toBe('image');
  });

  it('Content-Type: video/mp4 → video', () => {
    expect(detectMediaKind('https://x/a', 'video/mp4')).toBe('video');
  });

  it('Content-Type: video/quicktime → video', () => {
    expect(detectMediaKind('https://x/a', 'video/quicktime')).toBe('video');
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

  it('확장자·CT 없음 → image 기본값', () => {
    expect(detectMediaKind('https://x/abc')).toBe('image');
  });

  it('Content-Type이 확장자보다 우선', () => {
    expect(detectMediaKind('https://x/f.jpg', 'video/mp4')).toBe('video');
  });
});
