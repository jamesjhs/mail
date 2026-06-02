import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { env } from "./config/env.js";
import { initializeDatabase } from "./db/sql.js";
import { requireAdmin } from "./middleware/auth.js";
import { csrfProtection, issueCsrfToken } from "./middleware/csrf.js";
import { isPrivateHostname } from "./utils/net.js";
import {
  consumePasswordReset,
  createChallenge,
  createPasswordReset,
  createSessionToken,
  ensureAdmin,
  getAdminEmail,
  getSettings,
  pruneExpiredChallenges,
  purgeExpiredFailedMessages,
  setSetting,
  verifyMagicToken,
  verifyOtp,
  verifyPassword,
} from "./services/auth.js";
import { createRule, deleteRule, listRules, updateRule } from "./services/rules.js";
import { verifyTurnstile } from "./services/turnstile.js";
import {
  bounceMessage,
  listAudit,
  listPending,
  processInboundMessage,
  retryPendingMessages,
  retrySingleMessage,
  verifyWebhookSignature,
} from "./services/webhook.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, "../client/dist");
const appVersion = "v0.0.1";

const app = express();

if (env.TRUST_PROXY) {
  app.set("trust proxy", 1);
}

app.use(helmet());
app.use(cookieParser());
app.use((req, res, next) => {
  if (req.path === "/hook") {
    next();
    return;
  }
  express.json({ limit: "2mb" })(req, res, next);
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

const staticLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

const maxRegexPatternLength = 200;

app.use("/api", apiLimiter);

app.get("/readyz", async (_req, res) => {
  res.json({
    status: "ok",
    app: "jahosi-mail",
    version: appVersion,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/public/config", (_req, res) => {
  res.json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY, version: appVersion });
});

app.post("/api/auth/request", authLimiter, async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
    turnstileToken: z.string().min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const turnstileOk = await verifyTurnstile(parsed.data.turnstileToken, req.ip);
  if (!turnstileOk) {
    res.status(403).json({ error: "Turnstile verification failed" });
    return;
  }

  const passwordOk = await verifyPassword(parsed.data.email, parsed.data.password);
  if (!passwordOk) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const challengeId = await createChallenge();
  res.json({ challengeId, message: "OTP and magic link were sent" });
});

app.post("/api/auth/verify-otp", authLimiter, async (req, res) => {
  const schema = z.object({ challengeId: z.string().uuid(), otp: z.string().length(6) });
  const parsed = schema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const ok = await verifyOtp(parsed.data.challengeId, parsed.data.otp);
  if (!ok) {
    res.status(401).json({ error: "Invalid or expired OTP" });
    return;
  }

  const token = createSessionToken();
  res.cookie(env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV !== "development",
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
  });

  res.json({ success: true });
});

app.get("/api/auth/magic", authLimiter, async (req, res) => {
  const token = String(req.query.token ?? "");
  if (!token) {
    res.status(400).json({ error: "Missing token" });
    return;
  }

  const ok = await verifyMagicToken(token);
  if (!ok) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  const session = createSessionToken();
  res.cookie(env.SESSION_COOKIE_NAME, session, {
    httpOnly: true,
    secure: env.NODE_ENV !== "development",
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
  });

  res.redirect("/");
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie(env.SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: env.NODE_ENV !== "development",
    sameSite: "lax",
  });
  res.json({ success: true });
});

app.post("/api/auth/reset-password", authLimiter, async (req, res) => {
  const schema = z.object({ token: z.string().uuid(), password: z.string().min(10) });
  const parsed = schema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const ok = await consumePasswordReset(parsed.data.token, parsed.data.password);
  if (!ok) {
    res.status(400).json({ error: "Invalid or expired reset token" });
    return;
  }

  res.json({ success: true });
});

app.get("/api/admin/me", requireAdmin, async (_req, res) => {
  res.json({ email: await getAdminEmail(), version: appVersion });
});

app.get("/api/admin/csrf-token", requireAdmin, (req, res) => {
  const token = issueCsrfToken(res);
  res.json({ csrfToken: token });
});

app.get("/api/admin/rules", requireAdmin, async (_req, res) => {
  res.json(await listRules());
});

app.post("/api/admin/rules", requireAdmin, csrfProtection, async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    pattern: z.string().min(1).max(maxRegexPatternLength),
    patternType: z.enum(["wildcard", "regex"]),
    endpointUrl: z.string().url().refine((u) => !isPrivateHostname(u), {
      message: "Endpoint URL must not point to a private or loopback address",
    }),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  await createRule(parsed.data);
  res.status(201).json({ success: true });
});

app.put("/api/admin/rules/:id", requireAdmin, csrfProtection, async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    pattern: z.string().min(1).max(maxRegexPatternLength),
    patternType: z.enum(["wildcard", "regex"]),
    endpointUrl: z.string().url().refine((u) => !isPrivateHostname(u), {
      message: "Endpoint URL must not point to a private or loopback address",
    }),
    enabled: z.coerce.number().min(0).max(1),
  });
  const parsed = schema.safeParse(req.body);
  const id = Number(req.params.id);

  if (!parsed.success || Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  await updateRule(id, parsed.data);
  res.json({ success: true });
});

app.delete("/api/admin/rules/:id", requireAdmin, csrfProtection, async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  await deleteRule(id);
  res.json({ success: true });
});

app.get("/api/admin/messages", requireAdmin, async (req, res) => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize ?? 20)));
  res.json(await listAudit(page, pageSize));
});

app.get("/api/admin/pending", requireAdmin, async (_req, res) => {
  res.json(await listPending());
});

app.post("/api/admin/pending/:id/retry", requireAdmin, csrfProtection, async (req, res) => {
  const pendingId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const ok = await retrySingleMessage(pendingId);
  if (!ok) {
    res.status(400).json({ error: "Retry failed" });
    return;
  }
  res.json({ success: true });
});

app.post("/api/admin/pending/:id/bounce", requireAdmin, csrfProtection, async (req, res) => {
  const pendingId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const ok = await bounceMessage(pendingId);
  if (!ok) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  res.json({ success: true });
});

app.get("/api/admin/settings", requireAdmin, async (_req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

app.put("/api/admin/settings/webhook-signing-secret", requireAdmin, csrfProtection, async (req, res) => {
  const schema = z.object({ value: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  await setSetting("webhook_signing_secret", parsed.data.value);
  res.json({ success: true });
});

app.get("/api/admin/help", requireAdmin, async (_req, res) => {
  const helpPath = path.resolve(__dirname, "../docs/dashboard-help.html");
  const html = await fs.readFile(helpPath, "utf8");
  res.type("html").send(html.replaceAll("{{VERSION}}", appVersion));
});

app.post("/hook", webhookLimiter, express.raw({ type: "application/json" }), async (req, res) => {
  const rawBody = req.body instanceof Buffer ? req.body.toString("utf8") : JSON.stringify(req.body);

  const signatureValid = await verifyWebhookSignature({
    rawBody,
    headers: {
      "svix-id": req.header("svix-id"),
      "svix-timestamp": req.header("svix-timestamp"),
      "svix-signature": req.header("svix-signature"),
    },
  });

  if (!signatureValid) {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }

  const payload = JSON.parse(rawBody) as unknown;
  const result = await processInboundMessage(payload);
  res.status(202).json(result);
});

if (await fs.stat(clientDist).then(() => true).catch(() => false)) {
  app.use(staticLimiter, express.static(clientDist));
  app.get("/{*splat}", staticLimiter, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const start = async () => {
  await initializeDatabase();
  await ensureAdmin();

  setInterval(async () => {
    await retryPendingMessages();
    await pruneExpiredChallenges();
    await purgeExpiredFailedMessages();
  }, 60_000);

  app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`jahosi-mail listening on ${env.PORT}`);
  });
};

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});

export { app };
