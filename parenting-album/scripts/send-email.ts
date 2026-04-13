/**
 * PDF를 Cloudinary에 업로드 후 다운로드 링크를 이메일로 전송.
 *
 * 사용:
 *   npx tsx scripts/send-email.ts --month=2026-04 --pdf=dist/wonwoo-album-2026-04.pdf
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import nodemailer from 'nodemailer';
import { v2 as cloudinary } from 'cloudinary';

interface CliOptions {
  month: string;
  pdfPath: string;
  albumBaseUrl: string;
}

function parseCli(argv: string[]): CliOptions {
  let month = '';
  let pdfPath = '';
  const albumBaseUrl =
    process.env.PUBLIC_ALBUM_BASE_URL ?? 'https://focuskit-five.vercel.app';

  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--month=')) month = arg.slice('--month='.length);
    else if (arg.startsWith('--pdf=')) pdfPath = arg.slice('--pdf='.length);
  }
  if (!month) throw new Error('--month 필수 (예: 2026-04)');
  if (!pdfPath) pdfPath = `dist/wonwoo-album-${month}.pdf`;
  return { month, pdfPath, albumBaseUrl };
}

async function uploadPdfToCloudinary(pdfPath: string, month: string): Promise<string> {
  const name = process.env.CLOUDINARY_CLOUD_NAME;
  const key = process.env.CLOUDINARY_API_KEY;
  const secret = process.env.CLOUDINARY_API_SECRET;
  if (!name || !key || !secret) {
    throw new Error('Cloudinary 환경변수 필요 (CLOUD_NAME, API_KEY, API_SECRET)');
  }
  cloudinary.config({ cloud_name: name, api_key: key, api_secret: secret, secure: true });

  const folder = process.env.CLOUDINARY_FOLDER ?? 'wonwoo-album';
  const result = await cloudinary.uploader.upload(pdfPath, {
    resource_type: 'raw',
    folder: `${folder}/pdf`,
    public_id: `wonwoo-album-${month}`,
    overwrite: true,
  });
  return result.secure_url;
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv);

  const sender = process.env.EMAIL_SENDER;
  const appPassword = process.env.EMAIL_APP_PASSWORD;
  const recipients = process.env.EMAIL_RECIPIENTS;

  if (!sender || !appPassword || !recipients) {
    throw new Error('EMAIL_SENDER, EMAIL_APP_PASSWORD, EMAIL_RECIPIENTS 필요');
  }

  const pdfFullPath = path.resolve(opts.pdfPath);
  try {
    await fs.access(pdfFullPath);
  } catch {
    throw new Error(`PDF 파일 없음: ${pdfFullPath}`);
  }

  const stat = await fs.stat(pdfFullPath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
  console.log(`[email] PDF: ${pdfFullPath} (${sizeMB}MB)`);

  // Cloudinary에 PDF 업로드
  console.log('[email] uploading PDF to Cloudinary...');
  const pdfUrl = await uploadPdfToCloudinary(pdfFullPath, opts.month);
  console.log(`[email] ✓ uploaded: ${pdfUrl}`);

  const albumUrl = `${opts.albumBaseUrl}/album/${opts.month}`;

  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_SMTP_HOST || 'smtp.naver.com',
    port: Number(process.env.EMAIL_SMTP_PORT || '465'),
    secure: true,
    auth: {
      user: sender,
      pass: appPassword,
    },
  });

  const mailOptions = {
    from: `원우 앨범봇 <${sender}>`,
    to: recipients,
    subject: `📖 원우 앨범 ${opts.month} — PDF 완성!`,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h1 style="font-size: 24px; color: #2a2720;">📖 원우의 ${opts.month} 앨범</h1>
        <p style="color: #5c4e35; line-height: 1.8;">
          이번 달 앨범 PDF가 완성되었어요! 🌷
        </p>
        <a href="${pdfUrl}"
           style="display: inline-block; background: #2a2720; color: #fff; padding: 14px 28px;
                  border-radius: 10px; text-decoration: none; font-weight: 600; margin: 16px 0;">
          📥 PDF 다운로드 (${sizeMB}MB)
        </a>
        <div style="background: #faf8f3; border-radius: 12px; padding: 16px 20px; margin: 20px 0;">
          <p style="margin: 0; font-size: 13px; color: #786f60;">
            🖨 인쇄: 다운로드 후 <a href="https://www.snaps.com" style="color: #c86a3f;">스냅스</a>에 업로드 → A5 하드커버 주문
          </p>
        </div>
        <a href="${albumUrl}"
           style="display: inline-block; background: #c86a3f; color: #fff; padding: 12px 24px;
                  border-radius: 10px; text-decoration: none; font-weight: 600; margin: 12px 0;">
          디지털 앨범으로 보기 ❤️
        </a>
        <p style="font-size: 12px; color: #999; margin-top: 24px;">
          이 메일은 매월 1일 자동으로 발송됩니다.
        </p>
      </div>
    `,
  };

  console.log(`[email] sending to: ${recipients}`);
  const result = await transporter.sendMail(mailOptions);
  console.log(`[email] ✓ sent! messageId: ${result.messageId}`);
}

main().catch((err) => {
  console.error('[email] fatal', (err as Error).message);
  process.exit(1);
});
