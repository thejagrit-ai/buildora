// Centralised, validated environment configuration. Fail fast on boot.
// Load .env (if present) before reading process.env. dotenv never overrides
// variables already set in the environment (e.g. Docker/CI), and silently does
// nothing when no .env file exists.
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().default('buildora-docs'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_SIGNED_URL_TTL: z.coerce.number().default(900),

  SENDGRID_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default('no-reply@buildora.example'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),

  DEFAULT_HOLD_HOURS: z.coerce.number().default(48),
  GST_RATE_UNDER_CONSTRUCTION: z.coerce.number().default(5),
  COMPANY_NAME: z.string().default('Buildora'),

  // Shared secret for the server-to-server partner intake API (broker portal).
  PARTNER_API_KEY: z.string().optional(),
  // Tenant identity for server-to-server partner intake. The API key is never
  // allowed to select a tenant from request data.
  PARTNER_ORGANIZATION_ID: z.string().uuid().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim());
