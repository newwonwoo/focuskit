/**
 * RGB PDF → CMYK PDF 변환 (Ghostscript 래퍼).
 *
 * 사용:
 *   npm run build:pdf:cmyk -- --month=2026-04
 *
 * 전제: 로컬에 Ghostscript(`gs`)가 설치되어 있어야 함.
 *   macOS:   brew install ghostscript
 *   Ubuntu:  sudo apt install ghostscript
 *   Windows: https://ghostscript.com/releases/gsdnld.html
 *
 * build-pdf.ts 가 먼저 `dist/wonwoo-album-YYYY-MM.pdf`(RGB)를 생성했다고 가정한다.
 * 본 스크립트는 그 파일을 `-cmyk.pdf`로 변환한다.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

function parseCli(argv: string[]): { month: string; outputDir: string } {
  const now = new Date();
  let month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  let outputDir = process.env.PDF_OUTPUT_DIR ?? './dist';
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--month=')) month = arg.slice('--month='.length);
    else if (arg.startsWith('--output=')) outputDir = arg.slice('--output='.length);
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`--month=${month} 은 올바르지 않습니다.`);
  }
  return { month, outputDir };
}

function runGhostscript(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-dSAFER',
      '-dBATCH',
      '-dNOPAUSE',
      '-sDEVICE=pdfwrite',
      '-sColorConversionStrategy=CMYK',
      '-sProcessColorModel=DeviceCMYK',
      '-dCompatibilityLevel=1.4',
      '-dPDFSETTINGS=/prepress',
      '-dEmbedAllFonts=true',
      '-dSubsetFonts=true',
      `-sOutputFile=${output}`,
      input,
    ];
    const child = spawn('gs', args, { stdio: 'inherit' });
    child.on('error', (err) => {
      reject(
        new Error(
          `Ghostscript 실행 실패: ${err.message}\n` +
            `Ghostscript가 설치되어 있는지 확인하세요. (brew install ghostscript / apt install ghostscript)`,
        ),
      );
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Ghostscript가 exit code ${code}로 종료되었습니다.`));
    });
  });
}

async function main(): Promise<void> {
  const { month, outputDir } = parseCli(process.argv);
  const dir = path.resolve(outputDir);
  const input = path.join(dir, `wonwoo-album-${month}.pdf`);
  const output = path.join(dir, `wonwoo-album-${month}-cmyk.pdf`);

  try {
    await fs.access(input);
  } catch {
    throw new Error(
      `입력 파일 없음: ${input}\n먼저 'npm run build:pdf -- --month=${month}' 를 실행해주세요.`,
    );
  }

  console.log(`[cmyk] converting ${input} → ${output}`);
  await runGhostscript(input, output);
  console.log(`[cmyk] ✓ saved ${output}`);
}

main().catch((err) => {
  console.error('[cmyk] fatal', (err as Error).message);
  process.exit(1);
});
