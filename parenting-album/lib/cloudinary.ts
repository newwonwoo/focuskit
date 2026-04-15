import { v2 as cloudinary, type UploadApiOptions, type UploadApiResponse } from 'cloudinary';

export type MediaKind = 'image' | 'video';

export interface UploadResult {
  kind: MediaKind;
  publicId: string;
  /** 원본 (이미지) 또는 잘린 원본 (영상) */
  originalUrl: string;
  /** 이미지: 3000px JPG, 영상: 대표 프레임 3000px JPG */
  printUrl: string;
  /** 목록용 썸네일 400px JPG */
  thumbUrl: string;
  /** 영상 전용: 웹 재생용 720p MP4 */
  webVideoUrl?: string;
  /** 영상 길이 (초). Cloudinary가 반환한 duration. */
  durationSeconds?: number;
  /** 원본 이미지 가로 픽셀 (이미지 전용) */
  width?: number;
  /** 원본 이미지 세로 픽셀 (이미지 전용) */
  height?: number;
  /** 인쇄에 쓰기엔 해상도가 부족한지 (< 1500px 기준) */
  isLowResolutionForPrint?: boolean;
  /** EXIF DateTimeOriginal (촬영 시각). 없으면 undefined — 업로드 시각으로 fallback 필요. */
  takenAt?: Date;
  /** 선명도 추정치 (0~100). Cloudinary가 제공하는 경우. */
  blurScore?: number;
}

/** A5 2-up 기준으로 권장되는 최소 가로 픽셀 */
const MIN_PRINT_WIDTH_PX = 1500;

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('[cloudinary] CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET must be set');
  }
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
  configured = true;
}

/**
 * URL 확장자 / Content-Type 기반으로 이미지/영상 판정.
 *
 * 우선순위:
 *   1) HTTP Content-Type 헤더 (가장 신뢰도 높음)
 *   2) URL 확장자 — 영상 목록에 일치하면 video, 아니면 image 기본값
 *
 * 카카오가 `Content-Type: video/quicktime`, `image/heic` 등을 주면 확장자 없어도 정확히 분류된다.
 */
export function detectMediaKind(url: string, contentType?: string): MediaKind {
  const ct = contentType?.toLowerCase() ?? '';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('image/')) return 'image';
  const lower = url.toLowerCase();
  if (/\.(mp4|mov|m4v|webm|3gp|avi|mkv|mts|m2ts|wmv|flv|hevc)(\?|$|#)/.test(lower)) {
    return 'video';
  }
  // 이미지 확장자 매치 확인 (명시적). 매치 안 되면 기본값으로 image
  // (카카오는 이미지를 훨씬 더 자주 보냄)
  return 'image';
}

// 이미지 eager 변환:
//   [0] 인쇄용: 3000px 상한 + quality 100 (재인코딩 손실 제거). A5 300DPI 인쇄에 충분.
//   [1] 웹 썸네일: 400px + auto quality (대역폭 최적화)
const IMAGE_EAGER: ReadonlyArray<Record<string, unknown>> = [
  { width: 3000, crop: 'limit', quality: '100', format: 'jpg' },
  { width: 400, crop: 'limit', quality: 'auto', format: 'jpg' },
];

// 영상 eager 변환:
// 1) 웹 재생용 720p MP4 (60초 캡)
// 2) 대표 프레임 3000px JPG (자동 베스트 프레임)
// 3) 썸네일 400px JPG (자동 베스트 프레임)
const VIDEO_EAGER: ReadonlyArray<Record<string, unknown>> = [
  {
    width: 1280,
    crop: 'limit',
    quality: 'auto',
    video_codec: 'auto',
    format: 'mp4',
    end_offset: '60',
  },
  { width: 3000, crop: 'limit', start_offset: 'auto', format: 'jpg' },
  { width: 400, crop: 'limit', start_offset: 'auto', format: 'jpg' },
];

async function fetchBuffer(url: string): Promise<{ buffer: Buffer; contentType?: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[cloudinary] fetch failed ${res.status} ${res.statusText} for ${url}`);
  }
  const contentType = res.headers.get('content-type') ?? undefined;
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType };
}

export interface UploadOptionsInput {
  sourceUrl: string;
  folder: string;
  publicId: string;
  /** 기본 60초. 영상만 적용. 저장 원본 자체를 이 길이로 트림한다. */
  maxVideoSeconds?: number;
}

/**
 * Kakao 임시 URL에서 Buffer를 받아 Cloudinary에 업로드 후,
 * eager 변환 결과(3가지)를 한 번에 받아 UploadResult로 정규화한다.
 */
export async function uploadFromUrl(opts: UploadOptionsInput): Promise<UploadResult> {
  ensureConfigured();
  const { sourceUrl, folder, publicId, maxVideoSeconds = 60 } = opts;

  const { buffer, contentType } = await fetchBuffer(sourceUrl);
  const kind = detectMediaKind(sourceUrl, contentType);

  // 영상은 upload transformation으로 원본 저장 자체를 60초로 제한 (용량 절약)
  const trimTransformation =
    kind === 'video' && maxVideoSeconds > 0
      ? [{ start_offset: '0', end_offset: String(maxVideoSeconds) }]
      : undefined;

  const uploadOptions: UploadApiOptions = {
    folder,
    public_id: publicId,
    resource_type: kind,
    overwrite: false,
    eager: (kind === 'image' ? IMAGE_EAGER : VIDEO_EAGER) as UploadApiOptions['eager'],
    eager_async: false,
    // EXIF 메타데이터 추출 활성화 — DateTimeOriginal 가져옴
    image_metadata: kind === 'image',
    ...(trimTransformation ? { transformation: trimTransformation } : {}),
  };

  const result = await new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(uploadOptions, (err, res) => {
      if (err || !res) {
        reject(err ?? new Error('[cloudinary] unknown upload error'));
        return;
      }
      resolve(res);
    });
    stream.end(buffer);
  });

  const eager = result.eager ?? [];
  const secureUrl = (idx: number): string | undefined =>
    eager[idx]?.secure_url ?? (eager[idx] as { url?: string } | undefined)?.url;

  if (kind === 'image') {
    const width = typeof result.width === 'number' ? result.width : undefined;
    const height = typeof result.height === 'number' ? result.height : undefined;
    const isLowResolutionForPrint =
      typeof width === 'number' && width < MIN_PRINT_WIDTH_PX;

    if (isLowResolutionForPrint) {
      console.warn(
        `[cloudinary] ⚠️ low resolution for print: ${publicId} width=${width}px < ${MIN_PRINT_WIDTH_PX}px. ` +
          `2-up A5 인쇄에서 소프트하게 보일 수 있음.`,
      );
    }

    // EXIF DateTimeOriginal 파싱
    const takenAt = parseExifDate(result);

    return {
      kind: 'image',
      publicId: result.public_id,
      originalUrl: result.secure_url,
      printUrl: secureUrl(0) ?? result.secure_url,
      thumbUrl: secureUrl(1) ?? result.secure_url,
      width,
      height,
      isLowResolutionForPrint,
      takenAt,
    };
  }

  return {
    kind: 'video',
    publicId: result.public_id,
    originalUrl: result.secure_url,
    webVideoUrl: secureUrl(0),
    printUrl: secureUrl(1) ?? result.secure_url,
    thumbUrl: secureUrl(2) ?? result.secure_url,
    durationSeconds: typeof result.duration === 'number' ? result.duration : undefined,
  };
}

// ────────────────────────────────────────────────────────────────
// EXIF 파싱 — Cloudinary image_metadata에서 촬영 시각 추출
// ────────────────────────────────────────────────────────────────

/**
 * EXIF DateTimeOriginal 등을 Date로 파싱.
 * EXIF 형식: "YYYY:MM:DD HH:MM:SS" (콜론 구분)
 * - DateTimeOriginal 우선 (촬영 시각)
 * - DateTime fallback (수정/생성 시각)
 * - DateTimeDigitized fallback (디지털화 시각)
 * 파싱 실패 시 undefined.
 */
export function parseExifDate(result: UploadApiResponse): Date | undefined {
  // Cloudinary는 image_metadata: true 설정 시 result.image_metadata 필드에 EXIF를 넣어줌
  const meta = (result as unknown as { image_metadata?: Record<string, string> }).image_metadata;
  if (!meta || typeof meta !== 'object') return undefined;

  const candidates = [
    meta.DateTimeOriginal,
    meta.DateTime,
    meta.DateTimeDigitized,
  ];

  for (const raw of candidates) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    // EXIF "YYYY:MM:DD HH:MM:SS" → ISO "YYYY-MM-DDTHH:MM:SS"
    const match = /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
    if (!match) continue;
    const [, y, mo, d, h, mi, s] = match;
    // Asia/Seoul로 가정 (카카오톡은 한국 사용자 기준, 카메라 로컬 시각)
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}
