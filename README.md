# Jahosi Mail

Version: v0.0.1

Jahosi Mail is a TypeScript gateway that receives inbound email payloads from Resend webhooks and routes them to downstream APIs based on configurable local-prefix rules.

## Key features
- Inbound webhook endpoint: `https://mail.jahosi.co.uk/hook`
- Console-managed forwarding to email addresses or application webhooks
- Regex/wildcard routing with `{ID}` substitution in destination endpoints
- Retry queue for failed deliveries (5 attempts, 5-minute intervals)
- Bounce support and RFC-style DSN notification emails
- Admin dashboard (React PWA) with Turnstile + OTP/magic-link login
- SQLCipher encrypted persistence
- CLI admin password reset with SMTP notification

## Main docs
- `docs/TECHNICAL_REFERENCE.md`
- `docs/INSTALLATION_AND_TROUBLESHOOTING.md`

## Forward received mail to an inbox

With your Resend `email.received` webhook already pointing to `/hook`:

1. Open the mail console's Settings tab and save a Resend API key with access to received emails and attachments. The saved key is never returned to the browser.
2. In Rules, enter a name, pattern `apps`, and type Wildcard to match `apps@jahosi.co.uk`.
3. Choose Email address, enter the destination inbox, and click Add rule. Keep the rule enabled.
4. Send a test email and check Overview for SUCCESS, or Pending for queued delivery. Once a key or SMTP problem is corrected, use Retry.

To diagnose FAILED messages, read Last error in Pending or click View log for that message. Server log lists delivery attempts and failure reasons with refresh and pagination. Existing failures show their last stored reason when the queue row is still retained. New retry failures remain in the audit log even after a later successful retry.

Forwarding uses the configured SMTP sender address with a simplified original sender name (“via Jahosi Mail”), or “Jahosi Mail” when no display name was provided. Reply-To preserves the original Reply-To header or API reply_to value, falling back to the original sender. A forwarded-message block preserves sender, recipient, date, subject, and reply address in the body. Text, HTML, and attachments are included. The first enabled matching rule is used. Do not forward back to a receiving address that routes to the same inbox.

Run `npm test` (Node.js 22.3+ with module mocking support), `npm run build`, and `npm run lint` to verify changes. SQLCipher runtime requires Linux or macOS; on Windows, install backend dependencies for build/test only using `npm ci --force --ignore-scripts`. Tests mock SMTP, Resend, and the database and do not send real mail.
