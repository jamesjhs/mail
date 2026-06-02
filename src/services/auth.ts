import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomInt, randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { all, exec, get } from "../db/sql.js";
import { sendMail } from "./mail.js";

const challengeExpiryMinutes = 10;
const resetExpiryMinutes = 30;
const maxOtpAttempts = 5;

export const ensureAdmin = async () => {
  const existing = await get<{ email: string }>("SELECT email FROM admin_user WHERE id = 1");
  if (!existing) {
    const passwordHash = await bcrypt.hash(env.ADMIN_PASSWORD, 12);
    await exec("INSERT INTO admin_user (id, email, password_hash) VALUES (1, ?, ?)", [
      env.ADMIN_EMAIL,
      passwordHash,
    ]);
  }

  const webhook = await get<{ value: string }>("SELECT value FROM app_setting WHERE key = 'webhook_signing_secret'");
  if (!webhook) {
    await exec(
      "INSERT INTO app_setting (key, value) VALUES ('webhook_signing_secret', ?)",
      [env.WEBHOOK_SIGNING_SECRET],
    );
  }
};

export const verifyPassword = async (email: string, password: string) => {
  const user = await get<{ email: string; password_hash: string | null }>(
    "SELECT email, password_hash FROM admin_user WHERE id = 1",
  );

  if (!user || user.email !== email || !user.password_hash) {
    return false;
  }

  return bcrypt.compare(password, user.password_hash);
};

export const createChallenge = async () => {
  const challengeId = randomUUID();
  const otp = randomInt(100000, 1000000).toString();
  const magicToken = randomUUID();
  const otpHash = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + challengeExpiryMinutes * 60_000).toISOString();

  await exec(
    "INSERT INTO auth_challenge (id, otp_hash, magic_token, expires_at) VALUES (?, ?, ?, ?)",
    [challengeId, otpHash, magicToken, expiresAt],
  );

  const magicLink = `${env.PUBLIC_BASE_URL}/api/auth/magic?token=${magicToken}`;
  await sendMail({
    to: env.ADMIN_EMAIL,
    subject: "Jahosi Mail Admin Login Verification",
    text: `Your OTP is ${otp}. It expires in ${challengeExpiryMinutes} minutes.\nOr use magic link: ${magicLink}`,
    html: `<p>Your OTP is <strong>${otp}</strong> (expires in ${challengeExpiryMinutes} minutes).</p><p><a href="${magicLink}">Use one-time magic link</a></p>`,
  });

  return challengeId;
};

export const verifyOtp = async (challengeId: string, otp: string) => {
  const challenge = await get<{
    otp_hash: string;
    expires_at: string;
    used: number;
    failed_attempts: number;
  }>("SELECT otp_hash, expires_at, used, failed_attempts FROM auth_challenge WHERE id = ?", [challengeId]);

  if (
    !challenge ||
    challenge.used === 1 ||
    challenge.failed_attempts >= maxOtpAttempts ||
    new Date(challenge.expires_at).getTime() < Date.now()
  ) {
    return false;
  }

  const matches = await bcrypt.compare(otp, challenge.otp_hash);
  if (!matches) {
    await exec("UPDATE auth_challenge SET failed_attempts = failed_attempts + 1 WHERE id = ?", [challengeId]);
    return false;
  }

  await exec("UPDATE auth_challenge SET used = 1 WHERE id = ?", [challengeId]);
  return true;
};

export const verifyMagicToken = async (token: string) => {
  const challenge = await get<{ id: string; expires_at: string; used: number }>(
    "SELECT id, expires_at, used FROM auth_challenge WHERE magic_token = ?",
    [token],
  );

  if (!challenge || challenge.used === 1 || new Date(challenge.expires_at).getTime() < Date.now()) {
    return false;
  }

  await exec("UPDATE auth_challenge SET used = 1 WHERE id = ?", [challenge.id]);
  return true;
};

export const createSessionToken = () =>
  jwt.sign({ role: "admin" }, env.JWT_SECRET, {
    expiresIn: "8h",
    issuer: "jahosi-mail",
    audience: "jahosi-mail-admin",
  });

export const verifySessionToken = (token: string) => {
  try {
    jwt.verify(token, env.JWT_SECRET, {
      issuer: "jahosi-mail",
      audience: "jahosi-mail-admin",
    });
    return true;
  } catch {
    return false;
  }
};

export const createPasswordReset = async (targetEmail?: string) => {
  const user = await get<{ email: string }>("SELECT email FROM admin_user WHERE id = 1");
  if (!user) {
    throw new Error("Admin account is not initialized");
  }

  if (targetEmail && targetEmail !== user.email) {
    throw new Error("Provided email does not match the configured admin account");
  }

  const resetToken = randomUUID();
  const expiresAt = new Date(Date.now() + resetExpiryMinutes * 60_000).toISOString();
  await exec("UPDATE admin_user SET reset_token = ?, reset_token_expires = ? WHERE id = 1", [
    resetToken,
    expiresAt,
  ]);

  const resetUrl = `${env.PUBLIC_BASE_URL}/reset-password?token=${resetToken}`;

  await sendMail({
    to: user.email,
    subject: "Jahosi Mail Admin Password Reset",
    text: `Reset your admin password with this one-time link: ${resetUrl}`,
    html: `<p>Reset your admin password using this one-time link:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in ${resetExpiryMinutes} minutes.</p>`,
  });

  return { email: user.email, resetUrl };
};

export const consumePasswordReset = async (token: string, newPassword: string) => {
  const entry = await get<{ reset_token_expires: string }>(
    "SELECT reset_token_expires FROM admin_user WHERE id = 1 AND reset_token = ?",
    [token],
  );

  if (!entry || new Date(entry.reset_token_expires).getTime() < Date.now()) {
    return false;
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await exec(
    "UPDATE admin_user SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = 1",
    [hash],
  );

  // Intentional global invalidation: any outstanding OTP/magic-link challenge must be revoked after a password reset.
  await exec("DELETE FROM auth_challenge");
  return true;
};

export const pruneExpiredChallenges = async () => {
  await exec("DELETE FROM auth_challenge WHERE expires_at < CURRENT_TIMESTAMP");
};

export const getAdminEmail = async () => {
  const row = await get<{ email: string }>("SELECT email FROM admin_user WHERE id = 1");
  return row?.email ?? env.ADMIN_EMAIL;
};

export const updateAdminCredentials = async ({
  email,
  currentPassword,
  newPassword,
}: {
  email?: string;
  currentPassword: string;
  newPassword?: string;
}) => {
  const user = await get<{ email: string; password_hash: string | null }>(
    "SELECT email, password_hash FROM admin_user WHERE id = 1",
  );

  if (!user || !user.password_hash) {
    return { success: false };
  }

  const passwordValid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!passwordValid) {
    return { success: false };
  }

  const nextEmail = email?.trim() ? email.trim() : user.email;
  const nextPasswordHash = newPassword ? await bcrypt.hash(newPassword, 12) : user.password_hash;

  await exec("UPDATE admin_user SET email = ?, password_hash = ? WHERE id = 1", [nextEmail, nextPasswordHash]);

  if (newPassword) {
    await exec("DELETE FROM auth_challenge");
  }

  return { success: true, email: nextEmail };
};

export const purgeExpiredFailedMessages = async () => {
  await exec(
    "DELETE FROM pending_message WHERE status IN ('FAILED', 'BOUNCED') AND datetime(last_attempt) < datetime('now', '-24 hours')",
  );
};

export const getSettings = async () =>
  all<{ key: string; value: string }>("SELECT key, value FROM app_setting ORDER BY key");

export const setSetting = async (key: string, value: string) => {
  await exec(
    `INSERT INTO app_setting (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key, value],
  );
};

export const getSetting = async (key: string) => {
  const row = await get<{ value: string }>("SELECT value FROM app_setting WHERE key = ?", [key]);
  return row?.value;
};
