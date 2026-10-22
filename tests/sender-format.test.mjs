import assert from "node:assert/strict";
import { test } from "node:test";
import nodemailer from "nodemailer";
import addressparser from "nodemailer/lib/addressparser/index.js";
import { buildForwardedEmail } from "../dist/services/resend.js";

const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });

for (const [originalFrom, expectedDisplay] of [
  ["Sender <sender@example.org>", "Sender via Jahosi Mail"],
  ['"Jane Example" <jane@example.org>', "Jane Example via Jahosi Mail"],
  ['"Example, Jane" <jane@example.org>', "Example Jane via Jahosi Mail"],
  ["sender@example.org", "Jahosi Mail"],
  ["<sender@example.org>", "Jahosi Mail"],
]) {
  test(`serialized SMTP From is one simple mailbox for ${originalFrom}`, async () => {
    const message = await buildForwardedEmail("owner@example.net", {
      type: "email.received",
      data: {
        email_id: "email-1", from: originalFrom, to: ["apps@jahosi.co.uk"],
        subject: "Test", text: "Hello", html: null, headers: { from: originalFrom }, attachments: [],
      },
    }, "re_test", "noreply-mail@jahosi.co.uk");
    const result = await transport.sendMail(message);
    const raw = result.message.toString();
    const headers = raw.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ");
    const from = headers.match(/^From: (.+)$/m)?.[1].trim();
    assert.equal(from, `${expectedDisplay} <noreply-mail@jahosi.co.uk>`);
    assert.deepEqual(addressparser(from), [{ address: "noreply-mail@jahosi.co.uk", name: expectedDisplay }]);
    assert.equal((from.match(/</g) ?? []).length, 1);
    assert.equal((from.match(/>/g) ?? []).length, 1);
    const replyTo = headers.match(/^Reply-To: (.+)$/m)?.[1].trim();
    assert.equal(addressparser(replyTo)[0].address, addressparser(originalFrom)[0].address);
    assert.equal(result.envelope.from, "noreply-mail@jahosi.co.uk");
    assert.equal(message.replyTo, originalFrom);
    assert.ok(message.text.includes(`From: ${originalFrom}`));
  });
}
