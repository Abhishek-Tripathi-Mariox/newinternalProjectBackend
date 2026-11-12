import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * Typed, validated configuration. The process exits on boot if anything required is missing,
 * so misconfiguration fails fast instead of surfacing as odd runtime errors.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  TEST_DATABASE_URL: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),
  UPLOAD_DIR: z.string().default('uploads'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(10),
  APP_TZ: z.string().default('Asia/Kolkata'),
  // ---- File storage: 's3' (AWS S3 or any S3-compatible store) or 'local' (disk; tests / quick local runs)
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('s3'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_ENDPOINT: z.string().url().optional(), // set for MinIO / other S3-compatible stores; omit for AWS
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  S3_ACCESS_KEY_ID: z.string().optional(), // omit on AWS to use the default credential chain (IAM role, env, profile)
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PREFIX: z.string().default(''), // optional key prefix, e.g. "portal/"
  S3_SSE: z.enum(['AES256', 'aws:kms', 'none']).default('AES256'), // server-side encryption at rest
  S3_KMS_KEY_ID: z.string().optional(),
  S3_DOWNLOAD_MODE: z.enum(['proxy', 'redirect']).default('proxy'), // stream through the API, or 302 to a presigned URL
  S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  S3_CREATE_BUCKET: z.enum(['true', 'false']).default('false'), // dev convenience (MinIO): create the bucket on boot
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // ---- Email (SMTP). Invites / password resets are emailed when SMTP_USER + SMTP_PASS are set.
  SMTP_HOST: z.string().default('smtp.gmail.com'), // Google Workspace; use your provider's host otherwise
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).optional(), // default: true on port 465 (TLS), else STARTTLS
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  FROM_EMAIL: z.string().email().optional(), // defaults to SMTP_USER
  FROM_NAME: z.string().default('Mariox Software'),
  APP_URL: z.string().url().optional(), // frontend base URL used in email links; defaults to the first CORS origin
});

// Blank values (`KEY=`) count as unset, so optional settings can be left empty in .env.
const parsed = schema.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')));
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const i of parsed.error.issues) console.error(`  - ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}
const env = parsed.data;

// Tests use local disk storage unless TEST_STORAGE=s3 (the S3 driver has its own test against MinIO).
const storageDriver = env.NODE_ENV === 'test' && process.env.TEST_STORAGE !== 's3' ? 'local' : env.STORAGE_DRIVER;
if (storageDriver === 's3' && !env.S3_BUCKET) {
  console.error('Invalid environment configuration:\n  - S3_BUCKET is required when STORAGE_DRIVER=s3 (or set STORAGE_DRIVER=local)');
  process.exit(1);
}
if (storageDriver === 's3' && !!env.S3_ACCESS_KEY_ID !== !!env.S3_SECRET_ACCESS_KEY) {
  console.error('Invalid environment configuration:\n  - set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither (IAM role)');
  process.exit(1);
}

// One business time zone for the whole server: "today", week/month periods, late-after-10:30 and
// timesheet days all use APP_TZ, whatever zone the host runs in. Node applies TZ changes at runtime.
try {
  new Intl.DateTimeFormat('en-US', { timeZone: env.APP_TZ });
} catch {
  console.error(`Invalid APP_TZ "${env.APP_TZ}" — use an IANA name like Asia/Kolkata`);
  process.exit(1);
}
process.env.TZ = env.APP_TZ;

export const config = Object.freeze({
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  db: {
    url: env.NODE_ENV === 'test' && env.TEST_DATABASE_URL ? env.TEST_DATABASE_URL : env.DATABASE_URL,
    poolMax: env.DB_POOL_MAX,
  },
  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtlDays: env.JWT_REFRESH_TTL_DAYS,
  },
  bcryptRounds: env.BCRYPT_ROUNDS,
  timeZone: env.APP_TZ,
  // Tests write uploads to a temp folder so they never touch real files.
  uploads: { dir: env.NODE_ENV === 'test' ? path.join(os.tmpdir(), 'mariox-portal-test-uploads') : env.UPLOAD_DIR, maxBytes: Math.round(env.MAX_UPLOAD_MB * 1024 * 1024) },
  storage: {
    driver: storageDriver,
    s3: {
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      credentials: env.S3_ACCESS_KEY_ID ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } : undefined,
      prefix: env.S3_PREFIX.replace(/^\/+/, ''),
      sse: env.S3_SSE === 'none' ? null : env.S3_SSE,
      kmsKeyId: env.S3_KMS_KEY_ID,
      downloadMode: env.S3_DOWNLOAD_MODE,
      presignTtl: env.S3_PRESIGN_TTL_SECONDS,
      createBucket: env.S3_CREATE_BUCKET === 'true',
    },
  },
  mail: {
    // Tests never send real mail (they can switch on an in-memory transport, see core/mailer.js).
    enabled: env.NODE_ENV !== 'test' && !!(env.SMTP_USER && env.SMTP_PASS),
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : env.SMTP_PORT === 465,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: { name: env.FROM_NAME, address: env.FROM_EMAIL || env.SMTP_USER || 'no-reply@localhost' },
  },
  appUrl: (env.APP_URL || env.CORS_ORIGINS.split(',')[0].trim()).replace(/\/+$/, ''),
  logLevel: env.NODE_ENV === 'test' ? (process.env.TEST_LOG_LEVEL || 'silent') : env.LOG_LEVEL,
});
