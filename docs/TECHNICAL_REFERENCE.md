# Jahosi Mail Technical Reference

Version: v0.0.1

## Runtime stack
- Backend: TypeScript + Express
- Frontend: React + Vite
- Database: SQLCipher via `@journeyapps/sqlcipher`
- Mail transport: Nodemailer SMTP

## Core endpoints
- `POST /hook` - receives signed inbound payloads from Resend
- `GET /readyz` - readiness endpoint
- `POST /api/auth/request` - admin credential + Turnstile verification, sends OTP/magic link
- `POST /api/auth/verify-otp` - completes OTP login
- `GET /api/auth/magic` - completes magic-link login
- `POST /api/auth/reset-password` - set password from reset token
- `PUT /api/admin/settings/account` - update admin email and/or password
- `GET /api/admin/*` - protected admin operations

## Security controls
- Cloudflare Turnstile validation on login requests
- Signed webhook verification using Svix header validation
- HttpOnly signed session cookie
- SQLCipher encrypted local database
- Restricted message visibility in admin audit data

## Message lifecycle
1. Receive inbound payload at `/hook`
2. Match local-prefix recipient against regex/wildcard rules
3. Route each distinct recipient in the Resend `email.received` event's `data.to` array
   - Email destinations are stored as `mailto:address@example.com` in `endpoint_url`, requiring no database migration
   - Retrieve content and attachments from Resend and forward through configured SMTP; preserve subject and bodies, set Reply-To to original sender, and include a loop-detection header
   - HTTP destinations receive the original envelope and per-rule `X-Jahosi-Webhook-Key`; with a Resend API key configured, `data` additionally includes `text`, `html`, and `headers`
4. On failure, store in `pending_message` as `PENDING`
5. Retry every 5 minutes up to 5 attempts
6. Mark as `FAILED` when retry limit is reached
7. Admin can manually Retry or Bounce
8. Failed/Bounced messages auto-purge after 24h

## Admin data model (high level)
- `admin_user` - single admin account
- `auth_challenge` - OTP and magic-link challenges
- `routing_rule` - forwarding rule definitions
- `pending_message` - failed/pending queue items
- `message_audit` - UUID-level audit trail
- `app_setting` - mutable admin settings (including webhook secret)

## Resend configuration
- The console Server log uses authenticated `GET /api/admin/messages?page=1&pageSize=20&messageId=<optional-uuid>`. Results include audit ID, UTC time, status, attempt, destination, and error. Pagination inputs are validated and the UUID filter is parameterized.
- The startup migration adds nullable `error` and `attempt` columns to `message_audit`. Every new delivery failure, including automatic and manual retries, records a diagnostic. Historic FAILED/PENDING entries can display the latest error from the retained pending row; past attempt details cannot be reconstructed after deletion.
- `GET /api/admin/pending` includes `last_error`. Diagnostics redact API keys, bearer tokens, URL credentials, and signed URL query strings, and exclude email bodies and attachment content.
- `PUT /api/admin/settings/resend-api-key` accepts `{ "value": "re_..." }`, or an empty value to remove the key. Requires admin authentication and CSRF token.
- The API key is stored in encrypted persistence as `resend_api_key`. Settings responses replace it with `configured` (or an empty string).
- `/hook` verifies the raw Svix signature, ignores unrelated events, and returns 400 for malformed received-email events.
- Resend API, attachment download, SMTP, or endpoint failures use the existing pending queue and automatic/manual retries. Download URLs are retrieved afresh on each attempt.
