/**
 * 월간 아카이빙 스크립트 (제안 F — 1년 후 용량 절약용).
 *
 * 사용:
 *   npm run archive -- --month=2026-04
 *
 * 동작:
 *   1. Notion에서 해당 월의 Status='Summarized' 엔트리 조회
 *   2. 각 엔트리의 Cloudinary 원본을 로컬 경로(ARCHIVE_LOCAL_PATH)로 다운로드
 *   3. 다운로드 성공 확인 후 Cloudinary에서 원본만 삭제 (썸네일·인쇄본은 유지)
 *   4. Notion Status를 'Printed'로 전환
 *
 * 썸네일·인쇄본은 Cloudinary에 남겨두기 때문에 디지털 앨범은 계속 조회 가능.
 *
 * NOTE: 현재 구현은 "로컬 저장만" 하고 Cloudinary 삭제 + Notion 업데이트는 --confirm 플래그를
 *       줬을 때만 수행한다. 기본은 dry-run에 가까운 안전 모드.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { v2 as cloudinary } from 'cloudinary';
import { config as loadDotenv } from 'dotenv';

import {
  queryRawEntriesByMonth,
  updateEntriesStatus,
  type RawEntryRow,
} from '../lib/notion.js';

loadDotenv({ path: '.env.local' });
loadDotenv({ path: '.env' });

interface CliOptions {
  month: string;
  confirm: boolean;
  archivePath: string;
}

function parseCli(argv: string[]): CliOptions {
  const now = new Date();
  let month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  let confirm = false;
  let archivePath = process.env.ARCHIVE_LOCAL_PATH ?? './archive';

  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--month=')) month = arg.slice('--month='.length);
    else if (arg === '--confirm') confirm = true;
    else if (arg.startsWith('--path=')) archivePath = arg.slice('--path='.length);
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`--month=${month} 은 올바르지 않습니다.`);
  }
  return { month, confirm, archivePath };
}

function ensureCloudinary(): void {
  const name = process.env.CLOUDINARY_CLOUD_NAME;
  const key = process.env.CLOUDINARY_API_KEY;
  const secret = process.env.CLOUDINARY_API_SECRET;
  if (!name || !key || !secret) {
    throw new Error('Cloudinary 환경변수(CLOUDINARY_CLOUD_NAME/KEY/SECRET)가 설정되지 않았습니다.');
  }
  cloudinary.config({ cloud_name: name, api_key: key, api_secret: secret, secure: true });
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`다운로드 실패 ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
}

async function archiveEntry(
  entry: RawEntryRow,
  monthDir: string,
  confirm: boolean,
): Promise<{ archived: boolean; skipped: boolean; reason?: string }> {
  if (!entry.mediaUrl) {
    return { archived: false, skipped: true, reason: '원본 URL 없음 (text-only?)' };
  }

  const ext = entry.type === 'Video' ? '.mp4' : '.jpg';
  const filename = `${entry.idempotencyKey || entry.pageId}${ext}`;
  const destPath = path.join(monthDir, filename);

  try {
    await fs.access(destPath);
    console.log(`  - 이미 아카이빙됨: ${filename}`);
  } catch {
    console.log(`  - 다운로드 중: ${filename}`);
    await downloadToFile(entry.mediaUrl, destPath);
  }

  if (!confirm) {
    return { archived: true, skipped: false, reason: 'local only (--confirm 없음)' };
  }

  // Cloudinary에서 원본만 삭제 (썸네일·인쇄용은 별도 derived asset으로 유지됨)
  // public_id는 Media_URL에서 추출해야 하지만, 현재 구조상 Raw_Entry 컬럼에 따로 저장 안 함.
  // URL에서 public_id 파싱 (단순한 정규식).
  const publicIdMatch = /\/upload\/(?:v\d+\/)?(.+?)\.[a-z0-9]+(?:\?|$)/i.exec(
    entry.mediaUrl,
  );
  if (publicIdMatch) {
    const publicId = publicIdMatch[1]!;
    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: entry.type === 'Video' ? 'video' : 'image',
        invalidate: false,
      });
      console.log(`  - Cloudinary 원본 삭제: ${publicId}`);
    } catch (e) {
      console.warn(`  ! Cloudinary 삭제 실패: ${publicId} — ${(e as Error).message}`);
    }
  }

  return { archived: true, skipped: false };
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  const [yearStr, monthStr] = opts.month.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);

  const monthDir = path.resolve(opts.archivePath, opts.month);
  await fs.mkdir(monthDir, { recursive: true });

  console.log(
    `[archive] ${opts.month} → ${monthDir} (${opts.confirm ? 'CONFIRM mode' : 'dry mode'})`,
  );

  ensureCloudinary();

  const entries = await queryRawEntriesByMonth(year, month, 'Summarized');
  console.log(`[archive] found ${entries.length} entries`);

  let archived = 0;
  let skipped = 0;
  const successPageIds: string[] = [];
  for (const entry of entries) {
    try {
      const result = await archiveEntry(entry, monthDir, opts.confirm);
      if (result.archived) {
        archived += 1;
        if (opts.confirm) successPageIds.push(entry.pageId);
      } else {
        skipped += 1;
      }
    } catch (err) {
      console.error(`  ✗ ${entry.pageId}: ${(err as Error).message}`);
      skipped += 1;
    }
  }

  if (opts.confirm && successPageIds.length > 0) {
    console.log(`[archive] updating ${successPageIds.length} entries to Printed`);
    await updateEntriesStatus(successPageIds, 'Printed');
  }

  console.log(`[archive] done. archived=${archived} skipped=${skipped}`);
  if (!opts.confirm) {
    console.log(
      '[archive] NOTE: --confirm 없이 실행돼 원본은 로컬에만 복사됨. Cloudinary 삭제 + Notion 업데이트를 원하면 --confirm 추가.',
    );
  }
}

main().catch((err) => {
  console.error('[archive] fatal', err);
  process.exit(1);
});
