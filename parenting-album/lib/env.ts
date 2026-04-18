/**
 * 환경변수 안전 접근 유틸.
 *
 * 목적:
 * - `process.env.XXX ?? 'default'` 대신 이 함수를 써서
 *   빈 문자열('')도 fallback으로 처리
 * - 필수 변수 누락 시 즉시 에러 (깨진 상태로 한참 돌다 실패하는 대신)
 * - 패턴 검증 (예: Cloudinary cloud_name이 'Root' 같은 placeholder인지)
 */

/**
 * 필수 환경변수. 없거나 빈 문자열이면 에러.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`[env] ${name} is required but not set or empty`);
  }
  return value.trim();
}

/**
 * 선택 환경변수. 없거나 빈 문자열이면 fallback.
 * `??` 대신 이걸 쓰면 빈 문자열도 fallback으로 처리됨.
 */
export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') return fallback;
  return value.trim();
}

/**
 * Cloudinary cloud_name 검증.
 * 'Root', 'your-cloud-name' 같은 placeholder 차단.
 */
export function validateCloudinaryCloudName(name: string): void {
  const placeholders = ['root', 'your-cloud-name', 'your_cloud_name', 'cloud-name', 'cloud_name', 'example'];
  if (placeholders.includes(name.toLowerCase())) {
    throw new Error(
      `[env] CLOUDINARY_CLOUD_NAME is set to placeholder value '${name}'. ` +
      `Cloudinary 대시보드에서 실제 Cloud Name을 확인하세요.`,
    );
  }
}

/**
 * SMTP host 검증. 빈 문자열이면 naver fallback.
 */
export function getSmtpHost(): string {
  return optionalEnv('EMAIL_SMTP_HOST', 'smtp.naver.com');
}

/**
 * SMTP port 검증.
 */
export function getSmtpPort(): number {
  return Number(optionalEnv('EMAIL_SMTP_PORT', '465'));
}
