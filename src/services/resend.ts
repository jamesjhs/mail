import { z } from "zod";
import type { SendMailOptions } from "nodemailer";
import { apiFailure } from "../utils/errors.js";

const receivedEmail = z.object({
  type: z.literal("email.received"),
  data: z.object({
    email_id: z.string().min(1),
    from: z.string().min(1),
    to: z.array(z.string().email()).min(1),
  }).passthrough(),
}).passthrough();

export const parseReceivedEmail = (payload: unknown) => receivedEmail.safeParse(payload);

// Preserve the webhook envelope and attachment metadata for downstream consumers.
export const includeEmailContent = async (payload: unknown, apiKey: string) => {
  const parsed = parseReceivedEmail(payload);
  if (!apiKey || !parsed.success) return payload;

  const response = await fetch(
    `https://api.resend.com/emails/receiving/${encodeURIComponent(parsed.data.data.email_id)}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw await apiFailure(response, "Resend content retrieval");
  const content = z.object({
    text: z.string().nullable(),
    html: z.string().nullable(),
    headers: z.record(z.string(), z.string()),
    reply_to: z.array(z.string()).optional(),
  }).parse(await response.json());
  return { ...parsed.data, data: { ...parsed.data.data, ...content } };
};

export const buildForwardedEmail = async (to: string, payload: unknown, apiKey: string, sendingAddress: string): Promise<SendMailOptions> => {
  const event = receivedEmail.parse(payload);
  const email = z.object({
    text: z.string().nullable(),
    html: z.string().nullable(),
    subject: z.string().default(""),
    headers: z.record(z.string(), z.string()),
    reply_to: z.array(z.string()).optional(),
    attachments: z.array(z.object({
      id: z.string(),
      filename: z.string().nullable(),
      content_type: z.string(),
      content_disposition: z.enum(["inline", "attachment"]).optional(),
      content_id: z.string().nullable().optional(),
    })).default([]),
  }).parse(event.data);
  const singleLine = (value: string) => value.replace(/[\r\n]+[ \t]*/g, " ").trim();
  const header = (name: string) => singleLine(Object.entries(email.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? "");
  const originalFrom = header("from") || singleLine(event.data.from);
  // Some SMTP providers reject a quoted display name containing another mailbox.
  // Keep the original full address in Reply-To and the forwarded-message block.
  const displayName = (originalFrom.includes("<") ? originalFrom.split("<")[0] : "")
    .replace(/[^\p{L}\p{N}\s._-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  const replyTo = header("reply-to") || email.reply_to?.map(singleLine).filter(Boolean).join(", ") || originalFrom;
  const metadata = [
    ["From", originalFrom],
    ["To", event.data.to.join(", ")],
    ["Date", header("date")],
    ["Subject", singleLine(email.subject)],
    ["Reply-To", replyTo],
  ].filter(([, value]) => value);
  const textHeader = ["---------- Forwarded message ----------", ...metadata.map(([name, value]) => `${name}: ${value}`)].join("\n");
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  const htmlHeader = `<div style="border-bottom:1px solid #ccc;padding:0 0 12px;margin:0 0 12px"><strong>Forwarded message</strong><br>${metadata.map(([name, value]) => `<strong>${name}:</strong> ${escapeHtml(value)}`).join("<br>")}</div>`;
  const html = email.html
    ? /<body\b[^>]*>/i.test(email.html)
      ? email.html.replace(/<body\b[^>]*>/i, (bodyTag) => bodyTag + htmlHeader)
      : htmlHeader + email.html
    : undefined;
  if (Object.keys(email.headers).some((header) => header.toLowerCase() === "x-jahosi-forwarded")) {
    throw new Error("Forwarding loop detected");
  }
  if (event.data.to.some((address) => address.toLowerCase() === to.toLowerCase())) {
    throw new Error("Cannot forward an email to its original recipient");
  }
  const attachments: NonNullable<SendMailOptions["attachments"]> = [];
  for (const attachment of email.attachments) {
    const response = await fetch(
      `https://api.resend.com/emails/receiving/${encodeURIComponent(event.data.email_id)}/attachments/${encodeURIComponent(attachment.id)}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw await apiFailure(response, "Resend attachment retrieval");
    const details = z.object({ download_url: z.string().url() }).parse(await response.json());
    if (new URL(details.download_url).protocol !== "https:") throw new Error("Invalid attachment download URL");
    const download = await fetch(details.download_url, { signal: AbortSignal.timeout(30_000) });
    if (!download.ok) throw new Error(`Attachment download failed with status ${download.status}`);
    attachments.push({
      filename: attachment.filename ?? "attachment",
      content: Buffer.from(await download.arrayBuffer()),
      contentType: attachment.content_type,
      contentDisposition: attachment.content_disposition ?? "attachment",
      cid: attachment.content_id ?? undefined,
    });
  }
  return {
    from: { name: displayName ? `${displayName} via Jahosi Mail` : "Jahosi Mail", address: sendingAddress },
    to,
    replyTo,
    subject: email.subject,
    text: email.text !== null || !email.html ? `${textHeader}\n\n${email.text ?? ""}` : undefined,
    html,
    attachments,
    headers: { "X-Jahosi-Forwarded": event.data.email_id },
    disableFileAccess: true,
    disableUrlAccess: true,
  };
};
