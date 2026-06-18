before anything tell me how to give you the access key to my iam user account safely so you can execute the plan

# Migration Plan: Anthropic API → Amazon Bedrock

**Repo:** `rulix-eccn` (B:\rulix)
**Goal:** Move the backend AI council, memo chat, and public-draft features off the direct Anthropic API (`@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`) and onto **Amazon Bedrock** (`@anthropic-ai/bedrock-sdk`, AWS credentials).
**Audience:** A coding agent (e.g. ChatGPT). Follow the steps in order. Do not skip the ⚠️ items.

---

## 0. Context you need before editing

- All Anthropic calls live in **one file**: `server/anthropicCouncil.ts`. It exports three async functions + a runtime helper:
  - `runCouncilAnalysis()` — the 7-agent council review (tool-use, structured output).
  - `runMemoChatWithHaiku()` — memo chat assistant (tool-use, structured output).
  - `draftMemoFromPublicWeb()` — drafts a memo using the **`web_search` server-side tool**.
  - `getAnthropicRuntime()` — reports `{ configured, model }` for the health endpoint and startup log.
- Callers: `server/index.ts` (startup log), `server/app.ts` (health endpoint + 3 feature handlers), `server/test-live-ai.ts`, `server/test-live-council.ts`.
- Config today is gated purely on `process.env.ANTHROPIC_API_KEY`. When absent, everything falls back to the deterministic local rules engine (`src/lib/eccnReview.ts`). **Preserve this fallback behavior.**
- Provider source is a discriminated union: `AnalysisSource = "anthropic" | "local-rules" | "fallback"` in `src/types.ts`, also referenced in `src/App.tsx`, `src/components/PublicDraftPanel.tsx`, and `src/styles.css`.

### ⚠️ Critical constraint: Bedrock does NOT support server-side tools

Amazon Bedrock does **not** support Anthropic server-side tools — including **`web_search`**. The current `draftMemoFromPublicWeb()` uses `web_search_20250305` and **will fail on Bedrock**. See Step 5 for the required rework. Everything else the app uses (Messages API, client-side tool use, structured outputs, prompt caching, extended thinking) **is** supported on Bedrock.

---

## 1. Dependencies (`package.json`)

- Remove `"@anthropic-ai/sdk"` from `dependencies` and add `"@anthropic-ai/bedrock-sdk": "^0.x"` (use the latest published version).
  - Note: `@anthropic-ai/bedrock-sdk` depends on `@anthropic-ai/sdk` transitively, so message/content-block **types still resolve**.
- Run `npm install` to refresh `package-lock.json`.
- Update the `test:ai` / `test:ai:deep` script comments/docs if they mention the Anthropic key (the runner scripts themselves — `scripts/run-live-test.cmd` / `.ps1` — need **no change**; they just bundle and run, inheriting env from the shell).

---

## 2. Client + auth (`server/anthropicCouncil.ts`)

- Change the import:
  ```ts
  // before
  import Anthropic from "@anthropic-ai/sdk";
  // after
  import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
  ```
- Replace every `new Anthropic({ apiKey })` (3 sites) with `new AnthropicBedrock()`.
  - `AnthropicBedrock()` resolves AWS credentials from the **default provider chain** (`~/.aws/credentials`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`, IAM role, or `AWS_BEARER_TOKEN_BEDROCK`) and reads `AWS_REGION` (defaults to `us-east-1`).
  - Do **not** pass `apiKey`. Remove `apiKey` from `CouncilOptions` and `MemoChatOptions` and from the `options.apiKey ?? process.env.ANTHROPIC_API_KEY` lines.
- `messages.create({...})` call shape is **unchanged** — same params (`model`, `max_tokens`, `system`, `tools`, `tool_choice`, `messages`) and same response handling (`response.content`, `block.type === "tool_use"`, etc.).

---

## 3. Model IDs

Bedrock model IDs carry an `anthropic.` provider prefix **and** a routing prefix:
- `global.` = cross-region routing, no pricing premium (recommended).
- `us.` / `eu.` / `apac.` / `jp.` = regional (data residency), **+10% premium**.

Make the change:
- Rename the default constant and give it a Bedrock ID:
  ```ts
  // before
  export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";
  export const LEGACY_HAIKU_35_MODEL = "claude-3-5-haiku-20241022"; // DELETE — retired
  // after
  export const DEFAULT_BEDROCK_MODEL = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
  ```
- Resolve the model from `process.env.BEDROCK_MODEL` (fall back to `DEFAULT_BEDROCK_MODEL`). Keep accepting `ANTHROPIC_MODEL` as a backward-compat fallback if you want a soft migration.
- ⚠️ Keep the substring "haiku" in the default ID — `providerLabel()` and the deep live test (`test-live-council.ts`) assert on `/haiku/i` and reject `/sonnet/i`. The Bedrock Haiku ID satisfies this.
- `LEGACY_HAIKU_35_MODEL` is unused elsewhere (verify with grep) — delete it; `claude-3-5-haiku` is retired.

---

## 4. Config gate (`getAnthropicRuntime` → `getBedrockRuntime`)

Replace the `ANTHROPIC_API_KEY` presence check with an **explicit `BEDROCK_ENABLED` flag**.

> Rationale: AWS credentials often come from a role/profile that can't be reliably detected from env vars. An explicit flag is also **test-safe** — `server/app.test.ts` only deletes `ANTHROPIC_API_KEY` and asserts `provider.configured === false`; gating on env-detected AWS creds could flip true on a dev machine that has AWS creds exported and break that test. `BEDROCK_ENABLED` is never set in the test, so the health test stays green.

```ts
export function getBedrockRuntime() {
  return {
    configured: process.env.BEDROCK_ENABLED?.trim().toLowerCase() === "true",
    model: process.env.BEDROCK_MODEL?.trim() || DEFAULT_BEDROCK_MODEL,
  };
}
```

- In `runCouncilAnalysis()` and `runMemoChatWithHaiku()` and `draftMemoFromPublicWeb()`, replace the `if (!apiKey?.trim())` early-return guard with `if (!getBedrockRuntime().configured)` (keep the exact same local/offline fallback bodies and messages, just reworded — see Step 6).
- Update **both callers** of the renamed function: `server/index.ts:7` and `server/app.ts:60`.

---

## 5. ⚠️ Rework `draftMemoFromPublicWeb()` (web_search not on Bedrock)

The `web_search_20250305` tool block (and its `as never` cast) **must be removed** — Bedrock rejects server-side tools.

Choose one approach (recommended: **A**):

- **A — Draft from model knowledge, clearly caveated.** Drop the `tools` array entirely. Update `PUBLIC_MEMO_DRAFT_PROMPT` to remove "Use web search before drafting" and instead instruct the model to draft a cautious memo from general knowledge, explicitly listing what must be independently verified. Return `sources: []`. Set the provider message to something like *"Drafted on Bedrock from model knowledge; public web search is unavailable on Bedrock, so all facts must be verified against manufacturer/official sources."* Keep the existing JSON-from-text parsing (`parseJsonPayload`).
- **B — Disable the feature.** Always return `buildOfflinePublicDraft(item)` with a message that public-source drafting requires web search, which Bedrock does not support.

Keep the existing `try/catch` → offline-template fallback so a failure still degrades gracefully.

---

## 6. Rename provider source + user-facing text `"anthropic"` → `"bedrock"`

For an honest migration, rename the discriminant and reword messages. Touch these:

- `src/types.ts:103` — `AnalysisSource = "anthropic" | ...` → `"bedrock" | ...`.
- `server/anthropicCouncil.ts` — every `source: "anthropic"` (in `withProvider` calls + `MemoChatAiResult`) → `source: "bedrock"`; reword messages ("Live Anthropic analysis failed" → "Live Bedrock analysis failed", "No Anthropic key is configured" → "Bedrock is not enabled"); `safeError(error, apiKey)` → `safeError(error)` (no key to redact).
- `src/App.tsx:505` — `result.provider.source !== "anthropic"` → `"bedrock"`.
- `src/components/PublicDraftPanel.tsx:60` — className `"provider-box anthropic compact"` → `"provider-box bedrock compact"`.
- `src/styles.css:2296,2300` — `.provider-box.anthropic` → `.provider-box.bedrock`.
- `providerLabel()` returns "Claude Haiku council" etc. — fine to keep, or append "(via Bedrock)".

**Optional but cleaner:** `git mv server/anthropicCouncil.ts server/bedrockCouncil.ts` and update the 4 import sites (`index.ts`, `app.ts`, `test-live-ai.ts`, `test-live-council.ts`). Do all content edits **before** the `git mv` to avoid a needless re-read.

---

## 7. Live test files

`server/test-live-ai.ts` and `server/test-live-council.ts`:
- Replace the `if (!process.env.ANTHROPIC_API_KEY?.trim()) throw ...` guards with a `BEDROCK_ENABLED` check (and mention AWS creds + region in the error message).
- Update `result.provider.source !== "anthropic"` → `"bedrock"` and the "expected a live Anthropic result" wording → "Bedrock".
- The Haiku/Sonnet model assertions in `test-live-council.ts` still pass with the Bedrock Haiku ID (it contains "haiku", not "sonnet").

---

## 8. Unit test (`server/app.test.ts`)

- It deletes `ANTHROPIC_API_KEY` and asserts `provider.configured === false`. With the `BEDROCK_ENABLED` gate this **passes unchanged** (flag never set in tests).
- Optional: update the `originalKey`/cleanup boilerplate and the test title ("...whether the Anthropic backend is configured" → "...whether the Bedrock backend is configured") for clarity. Not required for green.

---

## 9. Docs + README

Update references to `ANTHROPIC_API_KEY` and "Anthropic" in:
- `README.md` (run instructions, `npm run test:ai` note, "What Is Implemented" bullet about the Sonnet/Anthropic adapter).
- `docs/architecture.md`, `docs/reviewer-guide.md`, `docs/deployment-notes.md`, `docs/aws-deploy.md`, `docs/ai-council-testing.md`.
- `infra/terraform/variables.tf` and `infra/terraform/hosting.tf` (any `ANTHROPIC_API_KEY` var/secret → AWS region + IAM `bedrock:InvokeModel` permission instead).
- `api/openapi.yaml` (health `provider.source` enum / examples).

New env vars to document:
| Var | Purpose | Example |
|---|---|---|
| `BEDROCK_ENABLED` | Master switch; `true` enables live Bedrock calls | `true` |
| `BEDROCK_MODEL` | Override the Bedrock model ID | `global.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `AWS_REGION` | Region for Bedrock requests | `us-east-1` |
| AWS creds | `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`(+`AWS_SESSION_TOKEN`), or `AWS_PROFILE`, or IAM role, or `AWS_BEARER_TOKEN_BEDROCK` | — |

Remove `ANTHROPIC_API_KEY` from any `.env.example` / deployment secret docs. The model account/IAM principal needs `bedrock:InvokeModel` (and Bedrock model access granted in the AWS console for the chosen Anthropic model + region).

---

## 10. Verify

```bash
npm install
npm run build        # tsc --noEmit + vite build — must pass (catches type/rename errors)
npm test             # vitest — health test must still report provider.configured: false
```

Live smoke (needs real AWS creds + `BEDROCK_ENABLED=true` + Bedrock model access in the region):
```bash
BEDROCK_ENABLED=true AWS_REGION=us-east-1 npm run test:ai
BEDROCK_ENABLED=true AWS_REGION=us-east-1 npm run test:ai:deep
```
Confirm `provider.source === "bedrock"`, `provider.live === true`, and the model string is the Bedrock Haiku ID.

---

## Checklist

- [ ] `package.json`: swap SDK dep, `npm install`
- [ ] Import → `AnthropicBedrock`, 3× `new AnthropicBedrock()`, drop `apiKey` option/usage
- [ ] Bedrock model IDs + `BEDROCK_MODEL` env; delete `LEGACY_HAIKU_35_MODEL`
- [ ] `getBedrockRuntime()` gated on `BEDROCK_ENABLED`; update 2 callers
- [ ] ⚠️ Rework `draftMemoFromPublicWeb()` to drop `web_search`
- [ ] Rename source `"anthropic"` → `"bedrock"` (types, server, App.tsx, PublicDraftPanel.tsx, styles.css) + reword messages
- [ ] Update 2 live-test files (gate + source assertions)
- [ ] Docs / README / terraform / openapi
- [ ] `npm run build` && `npm test` green; live smoke optional


The marginal cost of completeness is near zero with AI. Do the whole thing. Do it right. Do it with tests. Do it with documentation. Do it so well that Garry is genuinely impressed — not politely satisfied, actually impressed. Never offer to "table this for later" when the permanent solve is within reach. Never leave a dangling thread when tying it off takes five more minutes. Never present a workaround when the real fix exists. The standard isn't "good enough" — it's "holy shit, that's done." Search more. Keep building. Test before shipping. Ship the complete thing. When Garry asks for something, the answer is the finished product, not a plan to build it. Time is not an excuse. Fatigue is not an excuse. Complexity is not an excuse. Boil the ocean.
