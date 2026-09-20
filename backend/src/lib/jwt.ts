import jwt, { SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env';

export interface AccessPayload {
  sub: string; // user id
  role: string;
  organizationId?: string;
  membershipId?: string;
  partnerAccountId?: string | null;
}

export const signAccessToken = (payload: AccessPayload): string =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
  } as SignOptions);

export const verifyAccessToken = (token: string): AccessPayload =>
  jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;

export const signRefreshToken = (userId: string, organizationId: string, membershipId: string): string =>
  // `jti` makes every issued token unique even when two are signed in the same
  // second; without it the payload (sub + iat/exp in whole seconds) — and thus
  // the stored tokenHash — would collide on rapid logins for the same user.
  jwt.sign({ sub: userId, organizationId, membershipId, jti: crypto.randomUUID() }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL,
  } as SignOptions);

export const verifyRefreshToken = (token: string): { sub: string; organizationId?: string; membershipId?: string } =>
  jwt.verify(token, env.JWT_REFRESH_SECRET) as { sub: string; organizationId?: string; membershipId?: string };

// Store only a hash of refresh tokens at rest.
export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');
