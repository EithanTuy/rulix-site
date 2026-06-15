# AI Council Testing

Rulix uses a seven-agent AI council for live memo analysis:

- memo-parser
- jurisdiction-gate
- eccn-candidate
- evidence-mapper
- citation-verifier
- risk-reviewer
- report-writer

The backend owns provider model selection. The browser sends only the requested analysis depth:

- `standard`: full council triage, evidence mapping, and citation validation.
- `deep`: full council review plus a blocker/friction pass for missing next actions, overblocking ready memos, underblocking risky memos, and unsupported confidence.

## Live Provider Scripts

Both scripts require `ANTHROPIC_API_KEY` in the process environment. Never commit keys.

```powershell
npm run test:ai
npm run test:ai:deep
```

`npm run test:ai` is the quick live smoke test. It verifies a live Anthropic result, valid citations, and the complete seven-role council.

`npm run test:ai:deep` runs every fixture memo through the deep council and fails if results are likely to frustrate reviewers:

- wrong broad ECCN family
- missing council roles
- invalid source chunk IDs
- Sonnet used unexpectedly
- risky memos without blockers
- ready EAR99-style memo overblocked
- overconfident legal/export language

## Model Notes

The supported default is `claude-haiku-4-5`. The older first-party Claude API model ID `claude-3-5-haiku-20241022` is retained only as a legacy server-side override for accounts that still have provider access. On ordinary Claude API keys it is expected to fall back because Anthropic retired that model.
