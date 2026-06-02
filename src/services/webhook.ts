import { Webhook } from "svix";
import { randomUUID } from "node:crypto";
import { all, exec, get } from "../db/sql.js";
import { matchRule } from "./rules.js";
import { sendBounceNdr } from "./mail.js";
import { getSetting } from "./auth.js";

const retryLimit = 5;

const extractMailAddress = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }

  return "";
};

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
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Jahosi-Webhook-Key": webhookKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Endpoint rejected payload with status ${response.status}`);
  }
};

const audit = async (messageId: string, status: string, destination?: string | null) => {
  await exec("INSERT INTO message_audit (message_id, destination, status) VALUES (?, ?, ?)", [
    messageId,
    destination ?? null,
    status,
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
  const messageId = randomUUID();

  const sender = extractMailAddress((payload as Record<string, unknown>).from ?? (payload as Record<string, unknown>).sender);
  const toValue = extractMailAddress((payload as Record<string, unknown>).to ?? (payload as Record<string, unknown>).recipient);
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
    await audit(messageId, "SUCCESS", destination);
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
        error instanceof Error ? error.message : "Unknown error",
      ],
    );
    await audit(messageId, "PENDING", destination);
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
      await audit(item.id, "SUCCESS_RETRY", item.destination);
    } catch (error) {
      const nextAttempts = item.attempts + 1;
      if (nextAttempts >= retryLimit) {
        await exec(
          "UPDATE pending_message SET status = 'FAILED', attempts = ?, last_attempt = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?",
          [nextAttempts, error instanceof Error ? error.message : "Unknown error", item.id],
        );
        await audit(item.id, "FAILED", item.destination);
      } else {
        await exec(
          "UPDATE pending_message SET attempts = ?, last_attempt = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?",
          [nextAttempts, error instanceof Error ? error.message : "Unknown error", item.id],
        );
      }
    }
  }
};

export const listAudit = async (page: number, pageSize: number) => {
  const offset = (page - 1) * pageSize;
  const items = await all<{
    message_id: string;
    destination: string | null;
    status: string;
    event_time: string;
  }>(
    `SELECT message_id, destination, status, event_time
     FROM message_audit
     ORDER BY id DESC
     LIMIT ? OFFSET ?`,
    [pageSize, offset],
  );

  const countRow = await get<{ total: number }>("SELECT COUNT(*) as total FROM message_audit");

  return {
    total: countRow?.total ?? 0,
    items: items.map((item) => ({
      messageId: item.message_id,
      destination: item.destination,
      status: item.status,
      eventTime: item.event_time,
    })),
  };
};

export const listPending = () =>
  all<{
    id: string;
    status: string;
    attempts: number;
    destination: string | null;
    last_attempt: string;
    received_at: string;
  }>(
    `SELECT id, status, attempts, destination, last_attempt, received_at
     FROM pending_message
     ORDER BY received_at DESC`,
  );

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
    await audit(id, "SUCCESS_RETRY_MANUAL", row.destination);
    return true;
  } catch (error) {
    const attempts = row.attempts + 1;
    await exec(
      "UPDATE pending_message SET attempts = ?, last_attempt = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?",
      [attempts, error instanceof Error ? error.message : "Unknown error", id],
    );
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
