# Security, Authentication, and Storage

Rulix now requires sign-in before any memo review state is visible. New accounts start with an empty workspace; no demo memos are seeded into the app or backend.

## Implemented Local/Single-Node Baseline

- Passwords are salted and hashed server-side with PBKDF2-SHA256.
- Sessions use random server-side tokens stored only as hashes, with httpOnly, sameSite=strict cookies.
- Mutating API calls require a CSRF token returned by the authenticated session endpoint.
- Review memos, decisions, analysis results, memo chat history, and audit events are stored per account in the backend account store.
- Runtime account data is written to a git-ignored `data/rulix-store.json` file by default for local/single-node pilots, or to `RULIX_STORE_PATH` when configured.
- Lambda deployments can block direct Function URL bypass by setting `RULIX_EDGE_SHARED_SECRET`; Terraform wires this automatically for the CloudFront custom-domain path.

This local store is appropriate for development, demos, and tightly controlled single-node pilots. It is not the final storage layer for regulated customer production.

## Production Hardening Target

For the most secure production version, use managed identity and managed storage instead of custom passwords:

1. Put API Gateway or an equivalent edge auth layer in front of Lambda.
2. Use tenant SSO/OIDC or Amazon Cognito with MFA, short session lifetimes, and JWT authorizers.
3. Store memo metadata, decisions, chat messages, and audit indexes in DynamoDB or Postgres keyed by tenant and authenticated subject.
4. Store raw memo files, extracted text, attachments, evidence bundles, and exports in S3 with tenant-scoped KMS keys, versioning, and object lock where retention requires it.
5. Keep immutable audit trails for upload, extraction, AI prompt/version, model output, reviewer edits, decisions, overrides, exports, and signer identity.
6. Add least-privilege IAM, CloudTrail, CloudWatch log encryption, rate limiting, WAF rules, malware/type checks, and data-classification gates.
7. For real ITAR/CUI/export-controlled technical data, deploy the tenant environment in AWS GovCloud unless counsel and customer compliance approve another boundary.

## Memo Chat and Edits

Memo chat messages are account-scoped and memo-scoped. When Rulix drafts a memo edit from reviewer-provided context, the user must explicitly apply the proposed update. Applying a chat suggestion clears stale analysis/decision state and writes an audit event so the memo must be re-analyzed before signoff.
