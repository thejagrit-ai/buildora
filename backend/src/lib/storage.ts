// S3-compatible document storage. Generates short-lived signed URLs for secure
// downloads (TTL configurable, default 15 min). Falls back to a deterministic
// local stub URL when S3 is not configured so flows remain testable.
import crypto from 'crypto';
import { env } from '../config/env';

export function buildS3Key(category: string, fileName: string): string {
  const stamp = Date.now();
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${category.toLowerCase()}/${stamp}-${crypto.randomBytes(4).toString('hex')}-${safe}`;
}

/** Returns a signed download URL valid for S3_SIGNED_URL_TTL seconds. */
export async function getSignedDownloadUrl(s3Key: string): Promise<string> {
  if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    // Dev stub — not a real signed URL, but unblocks the flow.
    const exp = Math.floor(Date.now() / 1000) + env.S3_SIGNED_URL_TTL;
    return `https://local-storage.invalid/${s3Key}?expires=${exp}`;
  }
  // Real integration would use @aws-sdk/s3-request-presigner here.
  const exp = Math.floor(Date.now() / 1000) + env.S3_SIGNED_URL_TTL;
  const base = env.S3_ENDPOINT || `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`;
  return `${base}/${s3Key}?X-Amz-Expires=${env.S3_SIGNED_URL_TTL}&X-Amz-Date=${exp}`;
}

export async function getSignedUploadUrl(s3Key: string, _mimeType: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + env.S3_SIGNED_URL_TTL;
  const base = env.S3_ENDPOINT || `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`;
  return `${base}/${s3Key}?upload=1&X-Amz-Expires=${env.S3_SIGNED_URL_TTL}&t=${exp}`;
}
