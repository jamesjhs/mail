# Installation & Troubleshooting

Version: v0.0.1

## Installation (Debian 13)
1. Clone/pull repository:
   - `git pull`
2. Install dependencies:
   - `npm install`
   - `npm ci`
3. Copy environment template:
   - `cp .env.example .env`
4. Build application:
   - `npm run build`
5. Start with PM2:
   - `pm2 start dist/server.js --name jahosi-mail`

## Required environment values
- `PORT=4010` (configurable via `.env`, never hard-coded)
- `PUBLIC_BASE_URL=https://mail.jahosi.co.uk`
- `TRUST_PROXY=1`
- SMTP credentials (`SMTP_*`)
- Turnstile keys (`TURNSTILE_*`)
- SQLCipher config (`SQLCIPHER_DB_PATH`, `SQLCIPHER_KEY`)
- `WEBHOOK_SIGNING_SECRET`

## Nginx + Cloudflare Tunnel notes
- Keep app bound behind local HTTP reverse proxy.
- Ensure upstream preserves headers required by webhook verification.
- Use HTTPS externally via Cloudflare + tunnel.

## Admin password reset CLI
Run:
- `npm run reset-admin -- --email=<admin-email>`

Behavior:
- Opens SQLCipher DB using `.env`
- Generates one-time reset token
- Sends reset link by SMTP to admin email

## Troubleshooting
### Login failures
- Confirm Turnstile secret/site keys are valid
- Verify SMTP can send OTP/magic emails
- Check admin email/password values in `.env`

### Webhook rejected
- Confirm `svix-*` headers are present
- Confirm webhook signing secret matches Resend configuration

### Queue not draining
- Check downstream endpoint health and response codes
- Inspect Pending tab for retries and manual controls
- Verify server process remains running for setInterval retry loop

### Health check
- `curl http://127.0.0.1:<PORT>/readyz`
