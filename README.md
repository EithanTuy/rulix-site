# Rulix ECCN

Rulix ECCN is a Phase 2 MVP for reviewing ECCN classification memos against a versioned official-source corpus. It ingests memo text, runs a backend AI council when `ANTHROPIC_API_KEY` is configured, falls back to deterministic local rules when the provider is unavailable, highlights memo evidence, maps findings to citations, and requires human export-control signoff before any result is treated as final.

## Run

```bash
npm install
npm run dev:server
npm run dev
```

The Vite app runs on `http://127.0.0.1:5173` by default and proxies `/api` to the backend at `http://127.0.0.1:8787`.

Set the Anthropic key only in your shell or deployment secret store:

```bash
ANTHROPIC_API_KEY=... npm run dev:server
```

Useful checks:

```bash
npm test
npm run build
npm run test:ai
npm run download:corpus
```

Reviewer workflow guide: `docs/reviewer-guide.md`.
Security and storage guide: `docs/security-auth-storage.md`.

`npm run test:ai` requires `ANTHROPIC_API_KEY` and verifies that the backend returns a live Anthropic result. Do not commit `.env` files or API keys.

`npm run download:corpus` downloads official source pages into `corpus/raw/` and writes `corpus/manifest.generated.json`. Those generated files are ignored by Git so a tenant can refresh snapshots without polluting source control.

## What Is Implemented

- React/Vite dashboard based on the generated concept in `design/eccn-dashboard-concept.png`.
- Express backend with `/api/health`, `/api/corpus`, `/api/reviews`, `/api/reviews/:id/analyze`, `/api/ai/review`, and reviewer decision endpoints.
- Authenticated account workspace with server-stored memos, decisions, analysis results, memo chat history, and audit events.
- Review queue, upload/paste intake, highlighted memo viewer, editable memo text, memo chat-assisted edits, AI council panel, source citations, decision notes, and report export.
- Backend Anthropic Sonnet council adapter with deterministic citation/range validation and safe local fallback.
- Local review engine that recommends candidate ECCNs/EAR99 review paths, labels evidence as strong/weak/missing/conflict, verifies citations against the official corpus, and preserves human signoff as a hard gate.
- Seed official corpus metadata for EAR/ITAR/BIS/ITA sources, with a downloader for full raw snapshots.
- AWS/GovCloud architecture notes in `docs/aws-govcloud-architecture.md`.
- API contract in `api/openapi.yaml`.
- Terraform starter in `infra/terraform/` for single-tenant AWS or GovCloud-ready storage, audit, KMS, and worker permissions.

## Product Boundary

The app produces AI-generated classification recommendations and evidence review. It is not legal advice, does not create an attorney-client relationship, is not BIS/DDTC/CCATS/CJ, and does not replace qualified export-control personnel or counsel.

Commercial AWS pilots should use public, sample, or authorized/redacted material unless counsel/customer compliance approves processing real controlled technical data outside GovCloud. The architecture is intentionally single-tenant and partition-aware so it can move to AWS GovCloud.
