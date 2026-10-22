import { Webhook } from "svix";
import { randomUUID } from "node:crypto";
import { all, exec, get } from "../db/sql.js";
import { matchRule } from "./rules.js";
import { forwardEmail, sendBounceNdr } from "./mail.js";
import { getSetting } from "./auth.js";
import { includeEmailContent, parseReceivedEmail } from "./resend.js";
import { describeError, redactDiagnostic } from "../utils/errors.js";

const retryLimit = 5;

const parseRecipientPrefix = (to: string) => {
  const mailbox = to.includes("<") ? to.split("<")[1]?.replace(/[<>]/g, "") ?? to : to;
  const local = mailbox.split("@")[0] ?? "";
  return local.trim();
};

const buildDestination = (url: string, extractedId: string) => {
  if (!url.includes("{ID}")) {
    return url;
  }

  return url.replaceAll("{ID}", encodeURIComponent(extractedId));
};

const postPayload = async (endpoint: string, payload: unknown, webhookKey: string) => {
  const apiKey = (await getSetting("resend_api_key")) ?? "";
  if (endpoint.startsWith("mailto:") && !apiKey) {
    throw new Error("Configure the Resend API key in Settings to forward email content");
  }
  const forwardedPayload = await includeEmailContent(payload, apiKey);
  if (endpoint.startsWith("mailto:")) {
    await forwardEmail(endpoint.slice(7), forwardedPayload, apiKey);
    return;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Jahosi-Webhook-Key": webhookKey,
    },
    body: JSON.stringify(forwardedPayload),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Endpoint rejected payload with status ${response.status}`);
  }
};

const audit = async (messageId: string, status: string, destination?: string | null, error?: string, attempt?: number) => {
  await exec("INSERT INTO message_audit (message_id, destination, status, error, attempt) VALUES (?, ?, ?, ?, ?)", [
    messageId,
    destination ?? null,
    status,
    error ?? null,
    attempt ?? null,
  ]);
};

export const verifyWebhookSignature = async ({
  rawBody,
  headers,
}: {
  rawBody: string;
  headers: Record<string, string | undefined>;
}) => {
  const secret = (await getSetting("webhook_signing_secret")) ?? "";
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signature = headers["svix-signature"];

  if (!secret || !id || !timestamp || !signature) {
    return false;
  }

  const webhook = new Webhook(secret);

  try {
    webhook.verify(rawBody, {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    });
    return true;
  } catch {
    return false;
  }
};

export const processInboundMessage = async (payload: unknown) => {
  const received = parseReceivedEmail(payload);
  if (!received.success) throw new Error("Invalid received email event");

  // Each recipient gets its own routing result and retry entry.
  const results = [];
  for (const recipient of new Set(received.data.data.to.map((address) => address.toLowerCase()))) {
    results.push(await processRecipient(payload, received.data.data.from, recipient));
  }
  return { results };
};

const processRecipient = async (payload: unknown, sender: string, toValue: string) => {
  const messageId = randomUUID();
  const recipientPrefix = parseRecipientPrefix(toValue);

  const matched = await matchRule(recipientPrefix);

  if (!matched) {
    if (sender) {
      await sendBounceNdr({
        sender,
        messageId,
        reason: "No matching routing rule was found for this recipient.",
      });
    }

    await audit(messageId, "BOUNCED", null);
    return { messageId, status: "BOUNCED" as const };
  }

  const destination = buildDestination(matched.rule.endpointUrl, matched.extractedId);

  try {
    await postPayload(destination, payload, matched.rule.webhookKey);
    await audit(messageId, "SUCCESS", destination, undefined, 1);
    return { messageId, status: "SUCCESS" as const, destination };
  } catch (error) {
    await exec(
      `INSERT INTO pending_message (id, payload, sender, recipient, destination, webhook_key, status, attempts, last_attempt, received_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
      [
        messageId,
        JSON.stringify(payload),
        sender,
        toValue,
        destination,
        matched.rule.webhookKey,
        describeError(error),
      ],
    );
    await audit(messageId, "PENDING", destination, describeError(error), 1);
    return { messageId, status: "PENDING" as const, destination };
  }
};

export const retryPendingMessages = async () => {
  const pending = await all<{
    id: string;
    payload: string;
    destination: string;
    webhook_key: string;
    attempts: number;
  }>(
    `SELECT id, payload, destination, webhook_key, attempts
     FROM pending_message
     WHERE status = 'PENDING'
       AND datetime(last_attempt) <= datetime('now', '-5 minutes')`,
  );

  for (const item of pending) {
    try {
      await postPayload(item.destination, JSON.parse(item.payload), item.webhook_key);
      await exec("DELETE FROM pending_message WHERE id = ?", [item.id]);
      await audit(item.id, "SUCCESS_RETRY", item.destination, undefined, item.attempts + 1);
    } catch (error) {
      const nextAttempts = item.attempts + 1;
      if (nextAttempts >= retryLimit) {
        await exec(
          "UPDATE pending_message SET status = 'FAILED', attempts = ?, last_attempt = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?",
          [nextAttempts, describeError(error), item.id],
        );
        await audit(item.id, "FAILED", item.destination, describeError(error), nextAttempts);
      } else {
        await exec(
          "UPDATE pending_message SET attempts = ?, last_attempt = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?",
          [nextAttempts, describeError(error), item.id],
        );
        await audit(item.id, "RETRY_FAILED", item.destination, describeError(error), nextAttempts);
      }
    }
  }
};

export const listAudit = async (page: number, pageSize: number, messageId?: string) => {
  const offset = (page - 1) * pageSize;
  const items = await all<{
    id: number;
    message_id: string;
    destination: string | null;
    status: string;
    event_time: string;
    error: string | null;
    attempt: number | null;
  }>(
    `SELECT a.id, a.message_id, a.destination, a.status, a.event_time,
       COALESCE(a.error, CASE WHEN a.status = p.status THEN p.last_error END) AS error,
       COALESCE(a.attempt, CASE WHEN a.status = p.status THEN p.attempts END) AS attempt
     FROM message_audit a
     LEFT JOIN pending_message p ON p.id = a.message_id
     ${messageId ? "WHERE a.message_id = ?" : ""}
     ORDER BY a.id DESC
     LIMIT ? OFFSET ?`,
    [...(messageId ? [messageId] : []), pageSize, offset],
  );

  const countRow = await get<{ total: number }>(
    `SELECT COUNT(*) as total FROM message_audit ${messageId ? "WHERE message_id = ?" : ""}`,
    messageId ? [messageId] : [],
  );

  return {
    total: countRow?.total ?? 0,
    items: items.map((item) => ({
      id: item.id,
      messageId: item.message_id,
      destination: item.destination,
      status: item.status,
      eventTime: item.event_time,
      error: item.error ? redactDiagnostic(item.error) : null,
      attempt: item.attempt,
    })),
  };
};

export const listPending = async () => {
  const items = await all<{
    id: string;
    status: string;
    attempts: number;
    destination: string | null;
    last_attempt: string;
    received_at: string;
    last_error: string | null;
  }>(
    `SELECT id, status, attempts, destination, last_attempt, received_at, last_error
     FROM pending_message
     ORDER BY received_at DESC`,
  );
  return items.map((item) => ({ ...item, last_error: item.last_error ? redactDiagnostic(item.last_error) : null }));
};

export const retrySingleMessage = async (id: string) => {
  const row = await get<{
    payload: string;
    destination: string;
    webhook_key: string;
    attempts: number;
  }>("SELECT payload, destination, webhook_key, attempts FROM pending_message WHERE id = ?", [id]);

  if (!row) {
    return false;
  }

  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    await postPayload(row.destination, payload, row.webhook_key);
    await exec("DELETE FROM pending_message WHERE id = ?", [id]);
    await audit(id, "SUCCESS_RETRY_MANUAL", row.destination, undefined, row.attempts + 1);
    return true;
  } catch (error) {
    const attempts = row.attempts + 1;
    await exec(
      "UPDATE pending_message SET attempts = ?, last_attempt = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?",
      [attempts, describeError(error), id],
    );
    await audit(id, "RETRY_FAILED_MANUAL", row.destination, describeError(error), attempts);
    return false;
  }
};

export const bounceMessage = async (id: string) => {
  const row = await get<{ sender: string }>("SELECT sender FROM pending_message WHERE id = ?", [id]);
  if (!row) {
    return false;
  }

  await sendBounceNdr({
    sender: row.sender,
    messageId: id,
    reason: "Message was manually bounced by administrator.",
  });

  await exec("UPDATE pending_message SET status = 'BOUNCED', last_attempt = CURRENT_TIMESTAMP WHERE id = ?", [id]);
  await audit(id, "BOUNCED", null);
  return true;
};
