# Classification evaluation

This directory intentionally contains no invented gold cases and no claimed accuracy. A case becomes `gold` only after qualified export-control adjudication of the exact evidence, scope items, analysis date, jurisdiction, classification, and rule elements.

Keep entire product families in one split. Near-duplicate models, revisions, configurations, and document variants must not cross train, validation, and test. Predictions must bind one corpus checksum so a regulatory snapshot change cannot be mistaken for a model-only regression.

Run:

```powershell
npm run evaluation:classification -- --gold <gold.json> --predictions <predictions.json> [--baseline <baseline-metrics.json>]
```

The runner reports exact classification accuracy, top-k candidate recall, EAR99 false-positive rate, jurisdiction accuracy, element precision/recall, numeric-boundary accuracy, citation-integrity failures, abstention rate, accuracy among answered cases, scope leakage, and evidence-completeness errors. Store dataset manifests, immutable hashes, adjudicator identities, disagreement records, and corpus snapshot IDs outside the public repository according to the controlled-data policy.

Do not use exploratory fixtures, vendor marketing tables, model output, or historical Rulix recommendations as gold labels. A passing metric suite is not legal validation and does not activate a corpus or rule set.
