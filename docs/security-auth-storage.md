# Security, Authentication, and Storage

Rulix requires sign-in before any memo review state is visible. Onboarding is invite-only: admins create invites, invitees set their initial password from a one-time link, and public self-registration returns `410 Gone`.

## Current Auth Baseline

- Passwords are salted and hashed server-side with PBKDF2-SHA256.
- Passwords must be at least 12 characters and include 3 of 4 character classes.
- Login errors are generic, and 6 failed attempts lock the account for 10 minutes.
- Sessions use random server-side tokens stored only as SHA-256 hashes.
- Session cookies are httpOnly, sameSite=strict, and secure in production.
- Mutating API calls require the CSRF token returned by `/api/auth/me`, login, invite acceptance, or password reset completion.
- Password reset links are one-time tokens. Completing a reset advances the account's credential generation, invalidates every older-generation session, and starts a fresh session.

## Production Store

Production uses DynamoDB when both environment variables are present:

- `RULIX_AUTH_TABLE`
- `RULIX_ACCOUNT_TABLE`

The auth table stores users, invites, sessions, failed-login counters, lockouts, and password reset tokens under tenant-scoped partition keys. Raw invite, reset, and session tokens are never stored; only token hashes are persisted.

### Credential and session state transitions

`UserRecord.authGeneration` is the authoritative credential generation, and
every new session copies that value. New accounts start at generation `0`;
legacy records with no field are interpreted as generation `0` only for
migration compatibility. Password-reset completion changes the password and
increments `authGeneration` in the same DynamoDB transaction that consumes the
reset token. The existing session query/delete pass remains useful cleanup, but
generation equality is the authorization control.

Production login uses a strongly consistent user read and bounded
compare-and-swap retries. Failed-login and successful-login bookkeeping updates
only the fields it owns and is conditioned on the observed `authGeneration`,
password hash, and failed-attempt count. It never writes a retained full user
snapshot. This provides two invariants under concurrent Lambda invocations:

- a stale login cannot restore credentials replaced by password reset; and
- every rejected credential advances the lockout counter exactly once until the
  six-attempt lock is installed.

Session issuance uses one transaction: it checks that the user's generation and
password hash still match the authenticated snapshot, then creates a previously
absent session key. Session validation uses a strongly consistent user read and
a transaction that checks the same generation while updating `lastSeenAt` only
if the session still exists. If logout deletes the session first, refresh fails
instead of recreating it. If reset advances the generation first, an older
session is rejected even if a cleanup delete was delayed or missed.

The account table stores review memos, decisions, analysis results, chat history, and audit events per tenant/user key. The Terraform module creates both tables with KMS encryption and point-in-time recovery. The auth table enables TTL on `expiresAtEpoch` for sessions, invites, reset tokens, and lockouts.

## Local Development

If the DynamoDB env vars are absent, the server uses `LocalAccountStore` for tests and local development. By default it writes to git-ignored `data/rulix-store.json`, or to `RULIX_STORE_PATH` when configured. Treat this store as non-durable development data only.

The local store persists the same auth-generation and AI-admission record
shapes. Its state transitions are synchronous within one server process; it is
not a distributed substitute for DynamoDB's conditional-write guarantees.

## AI Egress Authorization

`server/aiEgressGateway.ts` is the sole credential-bearing provider boundary.
Every council, memo chat, memo builder, document extraction, public draft, lead
search, outreach-writing, personalization, fallback, and retry attempt passes
through it. The gateway checks the exact current provider, client region, and
(for controlled data) model identity, verifies the server-owned data class,
acquires account admission, and only then creates a provider client. A missing admission hook returns
`ai_admission_unconfigured` (`503`) with zero provider calls.

The deployment variables are:

| Variable | Default | Allowed values / meaning |
|---|---|---|
| `RULIX_AI_DATA_CLASS` | `proprietary` | Minimum class assigned to AI-bound content: `public`, `proprietary`, `export-controlled`, `itar-risk`, or `cui` |
| `RULIX_APPROVED_PROVIDER` | `amazon-bedrock` | Exact lane: `amazon-bedrock` or `anthropic-direct` |
| `RULIX_APPROVED_REGION` | Bedrock: configured AWS region; direct: none | Exact regional Bedrock identity, or `global` for direct Anthropic |
| `RULIX_APPROVED_MODEL_IDS` | unset | Non-empty JSON array of exact in-Region Bedrock IDs/ARNs, required for controlled data |
| `RULIX_CONTROLLED_DATA_MODE` | unset | Controlled dispatch requires exact value `approved` |

Stored reviews use the more sensitive of their exact persisted class and the
deployment floor. Missing or unrecognized stored classifications are rejected.
Ad hoc review, uploaded-document extraction, Memo Builder, outreach, and public
drafting ignore caller classification labels and use the deployment floor. An
invalid `RULIX_AI_DATA_CLASS` returns `ai_data_class_invalid` (`503`); content
below the floor, provider/region drift, or an unapproved controlled lane is
rejected before admission and before client construction.

Controlled classes (`export-controlled`, `itar-risk`, and `cui`) additionally
require explicit `RULIX_APPROVED_PROVIDER`, explicit `RULIX_APPROVED_REGION`, a
valid non-empty `RULIX_APPROVED_MODEL_IDS`, `RULIX_CONTROLLED_DATA_MODE=approved`,
and an Amazon Bedrock lane with a regional identity. A model must exactly match
the allowlist. Unprefixed regional model IDs and region-bound Bedrock model ARNs
in the approved client Region can be approved; global/geographic cross-Region
IDs and opaque inference-profile ARNs are rejected even when listed. Direct Anthropic is intentionally rejected
for controlled content.
For public or proprietary content, omitted provider defaults to Bedrock and an
omitted approved region resolves to `AWS_REGION`/`AWS_DEFAULT_REGION`; direct
Anthropic has no implicit region approval.

## Exact AI Approval Requests

Reviewer and counsel AI actions do not accept browser-asserted approval
bindings. The browser queues only a UUID, purpose, current optimistic review
bindings, and purpose-specific input. The server reloads the authoritative
review, latest bounded chat history or saved Memo Builder session, applies the
current deployment classification floor and provider policy, builds the exact
canonical provider body, and stores its hashes in an immutable request.

The Controls view is available to requesters and export-control officers.
Requesters can inspect status and cancel their own requests. Officers can
inspect the exact pending content and canonical provider JSON, approve or
reject it, and revoke an issued approval. Memo-chat pending text is encrypted
with the configured preview keyring, omitted from requester/list/decision
records, revealed only by the officer-detail API, and deleted after decision or
expiry. Queue creation is bounded to 25 requests per account per day and 1,000
per tenant per day.

Approval creates a target-account authorization for one exact dispatch. The
provider gateway rechecks subject, payload, provider-body hash,
classification, policy, revocation, and dispatch fencing immediately before
provider use. A changed review, chat history, builder session, deployment
floor, lane, or model requires a new request. Browser retry UUIDs are retained
in an opaque, bounded local cache so a lost response or page reload does not
duplicate a logical request; the cache contains no memo or prompt text and is
cleared on account change and sign-out.

Memo chat accepts 1 to 8,000 Unicode code points after trimming. The queue,
encrypted preview, direct dispatch, client validation, and OpenAPI contract use
the same bound. Exact chat routes have a 48 KiB raw JSON ceiling so 8,000
four-byte Unicode characters remain usable without widening unrelated routes.

## AI Workload Admission

The application installs one admission hook at the credential-bearing AI
gateway. Egress authorization and admission both finish before a provider client
is constructed. Each account has one versioned admission record containing
recent request timestamps, UTC-day token/spend totals, and active leases. The
local record is persisted in the JSON store. Production stores it under a
hashed `AI_ADMISSION#...` sort key in the tenant-scoped auth table and updates it
with a strongly consistent read plus a version-conditioned write. Conditional
conflicts retry at most 16 times; exhaustion or storage failure returns `503`
before any provider call.

Admission reserves a conservative upper bound. Ordinary text uses one token per
UTF-8 request byte plus maximum output tokens. Document and image requests do
not miscount base64 transport expansion as model input; instead they reserve
the full 200,000-token policy context (including maximum output) until actual
usage settles. Raw request bytes remain independently bounded at WAF, Express,
and document-intake layers. Reservations are priced at the model family's
highest token rate. The control atomically enforces concurrency,
requests per minute, tokens per UTC day, spend per UTC day, tokens per call, and
cost per call. Limit denial returns `429`, and the provider receives zero calls.

On successful provider completion, Anthropic input, output, cache-read, and
cache-creation usage reconciles the reservation to actual tokens and price. A
known pre-provider configuration failure releases the reservation. An unknown
provider outcome retains its conservative token/spend reservation, and its
concurrency lease remains active until expiry. Settlement-storage failure also
retains the reservation but does not replace a completed provider response with
a retryable error. Expiring leases ensure an interrupted worker cannot consume
concurrency permanently.

AI admission environment variables:

| Variable | Default | Accepted range | Meaning |
|---|---:|---:|---|
| `RULIX_AI_MAX_CONCURRENT` | `4` | integer `1`-`1000` | Active provider leases per account |
| `RULIX_AI_REQUESTS_PER_MINUTE` | `60` | integer `1`-`100000` | Admitted calls in the rolling 60-second window |
| `RULIX_AI_TOKENS_PER_DAY` | `5000000` | integer `1`-`1000000000` | Reserved/settled tokens per UTC day |
| `RULIX_AI_SPEND_USD_PER_DAY` | `50` | `0.01`-`100000` | Reserved/settled model cost per UTC day |
| `RULIX_AI_MAX_TOKENS_PER_CALL` | `200000` | integer `1`-`10000000` | Worst-case token reservation allowed for one call |
| `RULIX_AI_MAX_COST_USD_PER_CALL` | `5` | `0.01`-`10000` | Worst-case cost reservation allowed for one call |
| `RULIX_AI_LEASE_SECONDS` | `240` | integer `1`-`3600` | Concurrency lease lifetime |

Missing variables use the listed defaults. A present value that is nonnumeric,
fractional where an integer is required, zero/negative, or outside its accepted
range fails configuration closed with `ai_admission_configuration_invalid`
(`503`). Changing limits does not discard existing same-day reservations; the
new limits apply to the next admission decision.

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

Memo chat messages are account-scoped and memo-scoped. Non-officers retain the
exact draft while an approval request is pending. When Rulix drafts a memo edit
from reviewer-provided context, the user must explicitly apply the proposed
update. Applying a chat suggestion clears stale analysis/decision state and
writes an audit event so the memo must be re-analyzed before signoff.
