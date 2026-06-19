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

Both scripts require `BEDROCK_ENABLED=true`, AWS credentials from the default provider chain, Bedrock model access, and `AWS_REGION` in the process environment. Never commit AWS access keys or `.env` files.

```powershell
npm run test:ai
npm run test:ai:deep
```

`npm run test:ai` is the quick live smoke test. It verifies a live Bedrock result, valid citations, and the complete seven-role council.

`npm run test:ai:deep` runs every fixture memo through the deep council and fails if results are likely to frustrate reviewers:

- wrong broad ECCN family
- missing council roles
- invalid source chunk IDs
- deep review did not use Sonnet
- risky memos without blockers
- ready EAR99-style memo overblocked
- overconfident legal/export language

## Model Notes

The supported standard default is
`global.anthropic.claude-haiku-4-5-20251001-v1:0`. Deep reviews default to
`global.anthropic.claude-sonnet-4-6`. Override them independently with
`BEDROCK_MODEL` and `BEDROCK_DEEP_MODEL`.
