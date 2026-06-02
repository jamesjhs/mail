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
3. Forward unmodified payload to destination endpoint
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
