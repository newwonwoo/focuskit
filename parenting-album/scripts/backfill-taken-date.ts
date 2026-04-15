/**
 * 기존 사진의 Taken_Date + 해상도 백필.
 *
 * 사용:
 *   npm run backfill -- --month=2026-04
 *   npm run backfill -- --all         (전체)
 *   npm run backfill -- --month=2026-04 --dry-run
 *
 * Cloudinary resources API로 각 사진의 메타데이터 재조회.
 * EXIF가 있으면 Taken_Date 업데이트, 해상도(width/height) 업데이트.
 */

import { config as loadDotenv } from 'dotenv';
import { v2 as cloudinary } from 'cloudinary';

import {
  queryRawEntriesByMonth,
  queryRawEntriesInRange,
  updateTakenDate,
  updateMediaDimensions,
  type RawEntryRow,
} from '../lib/notion.js';
import { parseExifDate } from '../lib/cloudinary.js';
import type { UploadApiResponse } from 'cloudinary';

loadDotenv({ path: '.env.local' });
loadDotenv({ path: '.env' });

function ensureCloudinary(): void {
  const name = process.env.CLOUDINARY_CLOUD_NAME;
  const key = process.env.CLOUDINARY_API_KEY;
  const secret = process.env.CLOUDINARY_API_SECRET;
  if (!name || !key || !secret) {
    throw new Error('Cloudinary 환경변수 필요 (CLOUD_NAME, API_KEY, API_SECRET)');
  }
  cloudinary.config({ cloud_name: name, api_key: key, api_secret: secret, secure: true });
}

interface CliOptions {
  month?: string;
  all: boolean;
  dryRun: boolean;
}

function parseCli(argv: string[]): CliOptions {
  let month: string | undefined;
  let all = false;
  let dryRun = false;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--month=')) month = arg.slice('--month='.length);
    else if (arg === '--all') all = true;
    else if (arg === '--dry-run') dryRun = true;
  }
  if (!all && !month) throw new Error('--month 또는 --all 필요');
  return { month, all, dryRun };
}

/**
 * Cloudinary URL에서 public_id 추출.
 * https://res.cloudinary.com/<cloud>/image/upload/v123/wonwoo-album/2026-04/abc.jpg
 * → wonwoo-album/2026-04/abc
 */
function extractPublicId(url: string): string | null {
  const match = /\/upload\/(?:v\d+\/)?(.+?)\.[a-z0-9]+(?:\?|$)/i.exec(url);
  return match ? match[1]! : null;
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  ensureCloudinary();

  let entries: RawEntryRow[];
  if (opts.all) {
    // 전체 조회: 과거 3년치 기준
    const from = new Date(Date.UTC(2024, 0, 1));
    const to = new Date();
    console.log(`[backfill] fetching all entries from ${from.toISOString()} to ${to.toISOString()}`);
    entries = await queryRawEntriesInRange({ fromDate: from, toDate: to });
  } else {
    const [y, m] = opts.month!.split('-').map(Number);
    entries = await queryRawEntriesByMonth(y!, m!);
    console.log(`[backfill] fetching ${y}-${m}: ${entries.length} entries`);
  }

  const imageEntries = entries.filter(
    (e) => (e.type === 'Image' || e.type === 'Mixed') && e.mediaUrl,
  );
  console.log(`[backfill] processing ${imageEntries.length} photos`);

  let takenDateUpdated = 0;
  let dimensionsUpdated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < imageEntries.length; i += 1) {
    const entry = imageEntries[i]!;
    const pubId = extractPublicId(entry.mediaUrl!);
    if (!pubId) {
      console.warn(`[backfill] ${i + 1}/${imageEntries.length} public_id 추출 실패: ${entry.mediaUrl}`);
      skipped += 1;
      continue;
    }

    try {
      // Cloudinary resources API: 이미지 메타데이터 재조회
      const res = (await cloudinary.api.resource(pubId, {
        image_metadata: true,
      })) as UploadApiResponse;

      const takenAt = parseExifDate(res);
      const width = typeof res.width === 'number' ? res.width : undefined;
      const height = typeof res.height === 'number' ? res.height : undefined;

      const label = `${i + 1}/${imageEntries.length} ${pubId.slice(-20)}`;

      if (takenAt && !entry.takenDate) {
        if (opts.dryRun) {
          console.log(`[dry] ${label} takenAt=${takenAt.toISOString()}`);
        } else {
          await updateTakenDate(entry.pageId, takenAt);
          takenDateUpdated += 1;
        }
      }

      if (typeof width === 'number' && typeof height === 'number'
          && (entry.mediaWidth !== width || entry.mediaHeight !== height)) {
        if (opts.dryRun) {
          console.log(`[dry] ${label} ${width}x${height}`);
        } else {
          await updateMediaDimensions(entry.pageId, width, height);
          dimensionsUpdated += 1;
        }
      }

      if (!opts.dryRun) {
        // Notion rate limit 회피
        await new Promise((r) => setTimeout(r, 350));
      }
    } catch (err) {
      console.warn(`[backfill] ${i + 1} failed: ${(err as Error).message}`);
      failed += 1;
    }
  }

  console.log(
    `[backfill] done. takenDate=${takenDateUpdated}, dimensions=${dimensionsUpdated}, skipped=${skipped}, failed=${failed}`,
  );
}

main().catch((err) => {
  console.error('[backfill] fatal', err);
  process.exit(1);
});
