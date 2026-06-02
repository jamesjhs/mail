# Jahosi Mail

Version: v0.0.1

Jahosi Mail is a TypeScript gateway that receives inbound email payloads from Resend webhooks and routes them to downstream APIs based on configurable local-prefix rules.

## Key features
- Inbound webhook endpoint: `https://mail.jahosi.co.uk/hook`
- Regex/wildcard routing with `{ID}` substitution in destination endpoints
- Retry queue for failed deliveries (5 attempts, 5-minute intervals)
- Bounce support and RFC-style DSN notification emails
- Admin dashboard (React PWA) with Turnstile + OTP/magic-link login
- SQLCipher encrypted persistence
- CLI admin password reset with SMTP notification

## Main docs
- `docs/TECHNICAL_REFERENCE.md`
- `docs/INSTALLATION_AND_TROUBLESHOOTING.md`
