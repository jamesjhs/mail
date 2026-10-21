import { z } from "zod";
import type { SendMailOptions } from "nodemailer";

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
  if (!response.ok) throw new Error(`Resend content retrieval failed with status ${response.status}`);
  const content = z.object({
    text: z.string().nullable(),
    html: z.string().nullable(),
    headers: z.record(z.string(), z.string()),
  }).parse(await response.json());
  return { ...parsed.data, data: { ...parsed.data.data, ...content } };
};

export const buildForwardedEmail = async (to: string, payload: unknown, apiKey: string): Promise<SendMailOptions> => {
  const event = receivedEmail.parse(payload);
  const email = z.object({
    text: z.string().nullable(),
    html: z.string().nullable(),
    subject: z.string().default(""),
    headers: z.record(z.string(), z.string()),
    attachments: z.array(z.object({
      id: z.string(),
      filename: z.string().nullable(),
      content_type: z.string(),
      content_disposition: z.enum(["inline", "attachment"]).optional(),
      content_id: z.string().nullable().optional(),
    })).default([]),
  }).parse(event.data);
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
    if (!response.ok) throw new Error(`Resend attachment retrieval failed with status ${response.status}`);
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
    to,
    replyTo: event.data.from,
    subject: email.subject,
    text: email.text ?? undefined,
    html: email.html ?? undefined,
    attachments,
    headers: { "X-Jahosi-Forwarded": event.data.email_id },
    disableFileAccess: true,
    disableUrlAccess: true,
  };
};
