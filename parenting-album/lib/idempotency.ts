import { createHash } from 'node:crypto';

/**
 * 결정론적 중복 방지 키 생성.
 * 같은 사용자가 같은 시각에 같은 메시지를 보내면 같은 키가 나와 Notion 중복 Insert를 방지한다.
 */
export function generateIdempotencyKey(
  userId: string,
  timestamp: number,
  utterance: string,
  mediaSignature: string = '',
): string {
  const material = `${userId}:${timestamp}:${utterance}:${mediaSignature}`;
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}
