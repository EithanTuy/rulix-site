# Security, Authentication, and Storage

Rulix requires sign-in before any memo review state is visible. Onboarding is invite-only: admins create invites, invitees set their initial password from a one-time link, and public self-registration returns `410 Gone`.

## Current Auth Baseline

- Passwords are salted and hashed server-side with PBKDF2-SHA256.
- Passwords must be at least 12 characters and include 3 of 4 character classes.
- Login errors are generic, and 6 failed attempts lock the account for 10 minutes.
- Sessions use random server-side tokens stored only as SHA-256 hashes.
- Session cookies are httpOnly, sameSite=strict, and secure in production.
- Mutating API calls require the CSRF token returned by `/api/auth/me`, login, invite acceptance, or password reset completion.
- Password reset links are one-time tokens. Completing a reset revokes existing sessions and starts a fresh session.

## Production Store

Production uses DynamoDB when both environment variables are present:

- `RULIX_AUTH_TABLE`
- `RULIX_ACCOUNT_TABLE`

The auth table stores users, invites, sessions, failed-login counters, lockouts, and password reset tokens under tenant-scoped partition keys. Raw invite, reset, and session tokens are never stored; only token hashes are persisted.

The account table stores review memos, decisions, analysis results, chat history, and audit events per tenant/user key. The Terraform module creates both tables with KMS encryption and point-in-time recovery. The auth table enables TTL on `expiresAtEpoch` for sessions, invites, reset tokens, and lockouts.

## Local Development

If the DynamoDB env vars are absent, the server uses `LocalAccountStore` for tests and local development. By default it writes to git-ignored `data/rulix-store.json`, or to `RULIX_STORE_PATH` when configured. Treat this store as non-durable development data only.

## Email Delivery

Invites and password resets are delivered through SESv2 when `AUTH_EMAIL_FROM` is set to a verified SES sender. If the sender is missing, the API still creates the token and returns delivery status showing email is not configured.

Relevant environment variables:

- `AUTH_EMAIL_FROM`
- `APP_BASE_URL`
- `AUTH_INVITE_TTL_HOURS` (default `72`)
- `AUTH_RESET_TTL_MINUTES` (default `30`)
- `AUTH_SESSION_TTL_HOURS` (default `8`)
- `AUTH_BOOTSTRAP_SECRET` for the optional bootstrap invite endpoint

## Production Hardening Still Ahead

1. Add tenant SSO/OIDC or Cognito when customers require managed identity and MFA.
2. Add WAF/rate limiting at the edge for login, invite, and reset endpoints.
3. Move raw memo files, extracted text, attachments, evidence bundles, and exports into S3 with tenant-scoped KMS keys, versioning, and object lock where retention requires it.
4. Keep immutable audit trails for upload, extraction, AI prompt/version, model output, reviewer edits, decisions, overrides, exports, and signer identity.
5. For real ITAR/CUI/export-controlled technical data, deploy the tenant environment in AWS GovCloud unless counsel and customer compliance approve another boundary.

## Memo Chat and Edits

Memo chat messages are account-scoped and memo-scoped. When Rulix drafts a memo edit from reviewer-provided context, the user must explicitly apply the proposed update. Applying a chat suggestion clears stale analysis/decision state and writes an audit event so the memo must be re-analyzed before signoff.
