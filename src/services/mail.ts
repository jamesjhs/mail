import nodemailer from "nodemailer";
import { env } from "../config/env.js";

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  auth: {
    user: env.SMTP_USER,
    pass: env.SMTP_PASSWORD,
  },
});

export const sendMail = async ({
  to,
  subject,
  text,
  html,
}: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}) => {
  await transporter.sendMail({
    from: env.SMTP_FROM_ADDRESS,
    to,
    subject,
    text,
    html,
  });
};

export const sendBounceNdr = async ({
  sender,
  messageId,
  reason,
}: {
  sender: string;
  messageId: string;
  reason: string;
}) => {
  const report = [
    "Reporting-MTA: dns; mail.jahosi.co.uk",
    `Arrival-Date: ${new Date().toUTCString()}`,
    "",
    "Final-Recipient: rfc822; original-sender",
    "Action: failed",
    "Status: 5.0.0",
    `Diagnostic-Code: smtp; ${reason}`,
  ].join("\n");

  await sendMail({
    to: sender,
    subject: `Delivery Status Notification (Failure) [${messageId}]`,
    text: `Your message (${messageId}) could not be delivered.\n\n${report}`,
  });
};
