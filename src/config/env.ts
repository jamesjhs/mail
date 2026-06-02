import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(4010),
  PUBLIC_BASE_URL: z.string().url(),
  TRUST_PROXY: z.string().default("1"),
  JWT_SECRET: z.string().min(32),
  SESSION_COOKIE_NAME: z.string().default("mail_admin_session"),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(10),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.string().default("false"),
  SMTP_USER: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
  SMTP_FROM_ADDRESS: z.string().email(),
  TURNSTILE_SECRET_KEY: z.string().min(1),
  TURNSTILE_SITE_KEY: z.string().min(1),
  CF_ACCESS_CLIENT_ID: z.string().optional(),
  CF_ACCESS_CLIENT_SECRET: z.string().optional(),
  WEBHOOK_SIGNING_SECRET: z.string().min(1),
  SQLCIPHER_DB_PATH: z.string().default("./data/mail.db"),
  SQLCIPHER_KEY: z.string().min(1),
});

const parsed = envSchema.parse(process.env);

export const env = {
  ...parsed,
  SMTP_SECURE: parsed.SMTP_SECURE === "true",
  TRUST_PROXY: parsed.TRUST_PROXY === "1" || parsed.TRUST_PROXY.toLowerCase() === "true",
} as const;
