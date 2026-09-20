import crypto from 'node:crypto';
import { env } from '../config/env';

const key = crypto.createHash('sha256').update(env.JWT_ACCESS_SECRET).digest();

export function encryptConfigSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptConfigSecret(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('enc:v1:')) return value;
  const [, , ivRaw, tagRaw, dataRaw] = value.split(':');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataRaw, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function isSensitiveConfigKey(keyName: string) {
  return /(^|\.)(password|apiKey|secret|token)$/i.test(keyName);
}
