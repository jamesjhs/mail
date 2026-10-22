import assert from "node:assert/strict";
import { test, mock, beforeEach } from "node:test";

const settings = new Map();
const statements = [];
const sent = [];
let pending = [];
let smtpError;
let auditRows = [];
let manualRow;
const rule = { endpointUrl: "mailto:owner@example.net", webhookKey: "key", pattern: "apps", patternType: "wildcard" };
await mock.module("../dist/db/sql.js", { namedExports: {
  all: async (sql) => sql.includes("routing_rule") ? [rule] : sql.includes("FROM message_audit") ? auditRows : pending,
  get: async (sql) => sql.includes("COUNT(*)") ? { total: auditRows.length } : manualRow,
  exec: async (...args) => { statements.push(args); },
} });
await mock.module("../dist/services/auth.js", { namedExports: {
  getSetting: async (key) => settings.get(key),
} });
await mock.module("../dist/config/env.js", { namedExports: { env: {
  SMTP_HOST: "smtp.example.net", SMTP_PORT: 587, SMTP_SECURE: false,
  SMTP_USER: "user", SMTP_PASSWORD: "password", SMTP_FROM_ADDRESS: "gateway@example.net",
} } });
await mock.module("nodemailer", { defaultExport: {
  createTransport: () => ({ sendMail: async (message) => { if (smtpError) throw smtpError; sent.push(message); } }),
} });
const { processInboundMessage, retryPendingMessages, retrySingleMessage, listAudit, listPending, verifyWebhookSignature } = await import("../dist/services/webhook.js");
const { describeError, redactDiagnostic } = await import("../dist/utils/errors.js");
const { parseReceivedEmail, buildForwardedEmail } = await import("../dist/services/resend.js");
const { destinationSchema } = await import("../dist/services/destination.js");
const { Webhook } = await import("svix");

const event = () => ({ type: "email.received", data: {
  email_id: "email-1", from: "Sender <sender@example.org>", to: ["apps@jahosi.co.uk"],
  subject: "A test message", attachments: [],
} });
const content = () => ({ text: "Hello", html: "<p>Hello</p>", headers: {} });
beforeEach(() => {
  mock.restoreAll();
  statements.length = 0;
  sent.length = 0;
  pending = [];
  smtpError = undefined;
  auditRows = [];
  manualRow = undefined;
  settings.clear();
  settings.set("resend_api_key", "re_test");
  rule.endpointUrl = "mailto:owner@example.net";
  mock.method(globalThis, "fetch", async () => Response.json(content()));
});

test("Resend envelope routes apps to SMTP with body and original reply address", async () => {
  const result = await processInboundMessage(event());
  assert.equal(result.results[0].status, "SUCCESS");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "owner@example.net");
  assert.equal(sent[0].from, "gateway@example.net");
  assert.equal(sent[0].replyTo, "Sender <sender@example.org>");
  assert.equal(sent[0].text, "Hello");
  assert.equal(sent[0].html, "<p>Hello</p>");
  assert.equal(sent[0].subject, "A test message");
  assert.equal(sent[0].headers["X-Jahosi-Forwarded"], "email-1");
  assert.equal(fetch.mock.calls[0].arguments[1].headers.Authorization, "Bearer re_test");
});

test("retrieves attachment bytes without forwarding API credentials to download host", async () => {
  const message = event();
  message.data.attachments = [{ id: "file-1", filename: "image.png", content_type: "image/png", content_id: "img1", content_disposition: "inline" }];
  fetch.mock.mockImplementation(async (url) => {
    if (url.endsWith("/attachments/file-1")) return Response.json({ download_url: "https://download.example.net/file" });
    if (url === "https://download.example.net/file") return new Response("image bytes");
    return Response.json(content());
  });
  await processInboundMessage(message);
  const attachment = sent[0].attachments[0];
  assert.equal(attachment.content.toString(), "image bytes");
  assert.equal(attachment.cid, "img1");
  assert.equal(attachment.contentDisposition, "inline");
  assert.equal(fetch.mock.calls[2].arguments[1].headers, undefined);
});

test("missing API key queues original event for retry rather than sending an empty email", async () => {
  settings.clear();
  const result = await processInboundMessage(event());
  assert.equal(result.results[0].status, "PENDING");
  assert.equal(sent.length, 0);
  const insert = statements.find(([sql]) => sql.includes("INSERT INTO pending_message"));
  assert.deepEqual(JSON.parse(insert[1][1]), event());
});

test("Resend API failure queues the message", async () => {
  fetch.mock.mockImplementation(async () => new Response("", { status: 429 }));
  assert.equal((await processInboundMessage(event())).results[0].status, "PENDING");
  assert.equal(sent.length, 0);
});

test("SMTP failure queues the message for the email destination", async () => {
  smtpError = new Error("SMTP unavailable");
  assert.equal((await processInboundMessage(event())).results[0].status, "PENDING");
  const insert = statements.find(([sql]) => sql.includes("INSERT INTO pending_message"));
  assert.equal(insert[1][4], "mailto:owner@example.net");
  assert.equal(insert[1][6], "SMTP forwarding failed: SMTP unavailable");
});

test("an attachment retrieval failure queues the message without sending a partial email", async () => {
  const message = event();
  message.data.attachments = [{ id: "file-1", filename: "file.txt", content_type: "text/plain" }];
  fetch.mock.mockImplementation(async (url) => url.includes("/attachments/") ? new Response("", { status: 500 }) : Response.json(content()));
  assert.equal((await processInboundMessage(message)).results[0].status, "PENDING");
  assert.equal(sent.length, 0);
});

test("duplicate recipient addresses are only processed once", async () => {
  const message = event();
  message.data.to.push("APPS@jahosi.co.uk");
  assert.equal((await processInboundMessage(message)).results.length, 1);
  assert.equal(sent.length, 1);
});

test("retry uses saved mail destination and retrieves fresh content", async () => {
  pending = [{ id: "queued-1", payload: JSON.stringify(event()), destination: rule.endpointUrl, webhook_key: "key", attempts: 1 }];
  await retryPendingMessages();
  assert.equal(sent.length, 1);
  assert.ok(statements.some(([sql, params]) => sql.startsWith("DELETE FROM pending_message") && params[0] === "queued-1"));
});

test("forwarding loops and direct self forwarding do not send messages", async () => {
  const message = { ...event().data, ...content(), headers: { "x-jahosi-forwarded": "previous" } };
  await assert.rejects(buildForwardedEmail("owner@example.net", { ...event(), data: message }, "re_test"), /loop/);
  await assert.rejects(buildForwardedEmail("apps@jahosi.co.uk", { ...event(), data: { ...message, headers: {} } }, "re_test"), /original recipient/);
  assert.equal(sent.length, 0);
});

test("existing HTTP rules still forward signed payloads without an API key", async () => {
  rule.endpointUrl = "https://api.example.net/hook";
  settings.clear();
  assert.equal((await processInboundMessage(event())).results[0].status, "SUCCESS");
  const [, options] = fetch.mock.calls[0].arguments;
  assert.equal(options.headers["X-Jahosi-Webhook-Key"], "key");
  assert.deepEqual(JSON.parse(options.body), event());
  assert.equal(sent.length, 0);
});

test("validates email and public web destinations", () => {
  for (const value of ["mailto:owner@example.net", "https://api.example.net/hook"]) assert.ok(destinationSchema.safeParse(value).success);
  for (const value of ["mailto:bad", "mailto:one@example.net,two@example.net", "mailto:one@example.net?bcc=two@example.net", "http://127.0.0.1", "file:///tmp/file"]) assert.ok(!destinationSchema.safeParse(value).success);
});

test("rejects malformed Resend data and unrelated event types", () => {
  for (const value of [null, {}, { from: "sender@example.net", to: "apps@jahosi.co.uk" }, { ...event(), type: "email.sent" }]) assert.ok(!parseReceivedEmail(value).success);
});

test("verifies the raw Resend webhook signature", async () => {
  const secret = `whsec_${Buffer.from("test signing secret").toString("base64")}`;
  settings.set("webhook_signing_secret", secret);
  const body = JSON.stringify(event());
  const now = new Date();
  const headers = { "svix-id": "event-1", "svix-timestamp": String(Math.floor(now.getTime() / 1000)), "svix-signature": new Webhook(secret).sign("event-1", now, body) };
  assert.equal(await verifyWebhookSignature({ rawBody: body, headers }), true);
  assert.equal(await verifyWebhookSignature({ rawBody: body + " ", headers }), false);
});

test("delivery log records the stage and Resend rejection reason without credentials", async () => {
  fetch.mock.mockImplementation(async () => Response.json({ message: "API key re_secret123 cannot read receiving emails" }, { status: 403 }));
  await processInboundMessage(event());
  const log = statements.find(([sql]) => sql.includes("INSERT INTO message_audit"));
  assert.equal(log[1][2], "PENDING");
  assert.equal(log[1][4], 1);
  assert.match(log[1][3], /Resend content retrieval failed with status 403/);
  assert.match(log[1][3], /cannot read receiving emails/);
  assert.ok(!log[1][3].includes("re_secret123"));
});

test("automatic failed attempts each produce a diagnostic log including final FAILED", async () => {
  pending = [{ id: "queued-1", payload: JSON.stringify(event()), destination: rule.endpointUrl, webhook_key: "key", attempts: 1 }];
  smtpError = Object.assign(new Error("Connection refused"), { code: "ECONNECTION", responseCode: 421 });
  await retryPendingMessages();
  let logs = statements.filter(([sql]) => sql.includes("INSERT INTO message_audit"));
  assert.equal(logs[0][1][2], "RETRY_FAILED");
  assert.equal(logs[0][1][4], 2);
  assert.match(logs[0][1][3], /ECONNECTION, 421/);
  pending[0].attempts = 4;
  await retryPendingMessages();
  logs = statements.filter(([sql]) => sql.includes("INSERT INTO message_audit"));
  assert.equal(logs[1][1][2], "FAILED");
  assert.equal(logs[1][1][4], 5);
});

test("manual retry failure persists the updated error and logs the attempt", async () => {
  manualRow = { payload: JSON.stringify(event()), destination: rule.endpointUrl, webhook_key: "key", attempts: 5 };
  settings.clear();
  assert.equal(await retrySingleMessage("failed-1"), false);
  const log = statements.find(([sql]) => sql.includes("INSERT INTO message_audit"));
  assert.equal(log[1][2], "RETRY_FAILED_MANUAL");
  assert.equal(log[1][4], 6);
  assert.match(log[1][3], /Configure the Resend API key/);
});

test("log and pending API results expose diagnostic details with secrets redacted", async () => {
  auditRows = [{ id: 1, message_id: "failed-1", status: "FAILED", event_time: "2026-10-22 10:00:00", attempt: 5, error: "Denied re_secret123", destination: rule.endpointUrl }];
  const log = await listAudit(1, 20);
  assert.equal(log.total, 1);
  assert.equal(log.items[0].attempt, 5);
  assert.equal(log.items[0].error, "Denied [redacted]");
  pending = [{ id: "failed-1", last_error: "Bad secret whsec_abc123" }];
  assert.equal((await listPending())[0].last_error, "Bad secret [redacted]");
});

test("network codes remain useful and signed URLs and bearer tokens are redacted", () => {
  assert.match(describeError(new Error("fetch failed", { cause: { code: "ENOTFOUND" } })), /ENOTFOUND/);
  const detail = redactDiagnostic("Bearer secret-value https://download.example.net/file?Signature=private https://user:password@example.net");
  assert.ok(!detail.includes("secret-value"));
  assert.ok(!detail.includes("Signature=private"));
  assert.ok(!detail.includes("password"));
});
