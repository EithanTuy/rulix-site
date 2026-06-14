# Product Safety and Review Policy

## Hard Rules

- The AI may recommend an ECCN, EAR99 path, or jurisdiction escalation, but only a named human reviewer can finalize the record.
- Do not label a result approved, compliant, license-not-required, or legally final without human signoff.
- Separate classification from transaction/license analysis. ECCN alone does not answer end-use, end-user, destination, sanctions, or red-flag questions.
- Resolve ITAR/USML risk before relying on an EAR/CCL classification.
- Unsupported model claims are findings, not facts. If a citation is not in the downloaded corpus, block or flag the claim.

## Evidence Labels

- `strong`: memo text maps directly to a technical control parameter or recognized classification process.
- `weak`: memo text may be useful but does not yet explain its relevance to the proposed ECCN.
- `missing`: required technical, jurisdictional, software, technology, or source evidence is absent.
- `conflict`: memo reasoning contradicts export-classification workflow or relies on use context instead of item characteristics.

## Intended Users

Export-control officers, research compliance teams, technology-transfer offices, in-house counsel-supported reviewers, lab program managers, and FFRDC/national-lab compliance staff.

The app should not be sold as unsupervised self-service classification for untrained researchers.

