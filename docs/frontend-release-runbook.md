# Frontend release and rollback runbook

## Release gates

From a clean checkout of the release commit:

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run build:lambda
npm run test:bundle
npm run test:e2e
git diff --check
```

The initial shared shell must stay at or below 150 KiB gzip and each lazy product route at or below 120 KiB gzip. Browser QA must cover the built assets at 390, 768, and 1440 pixels with no uncaught console errors, failed same-origin requests, or unhandled promises.

## Capture the rollback artifact

Record before deployment:

- release commit and previous production commit;
- Lambda function code SHA-256;
- `dist/` asset names and SHA-256 values;
- Lambda bundle/zip SHA-256;
- `/api/health` response;
- app/dashboard desktop and mobile screenshots.

Keep the previous Lambda package and asset manifest until post-deploy monitoring is complete.

## Deploy and verify

1. Merge through the protected branch; do not bypass required review.
2. Let the repository OIDC deployment publish the Lambda and built assets.
3. Invalidate CloudFront paths for the HTML shell and changed immutable assets.
4. Verify `https://app.rulix.cloud/api/health`, served asset hashes, and the deployed commit.
5. Smoke test login, Home, migrated/current review loading, AI approval/run, comments, decision/signoff/export, Operations access, and Growth Lead Review with authorized role fixtures.
6. Monitor Lambda/CloudFront 4xx/5xx, client errors, auth failures, approval failures, and export failures through the observation window.

## Rollback criteria and action

Roll back immediately for auth regression, review-load regression, approval/signoff/export failure, dashboard access loss, elevated 5xx/client-error rate, or a broken product shell.

Redeploy the captured previous Lambda package and asset set, invalidate CloudFront, then repeat health, served-asset, login, migrated-review, signoff/export, and dashboard smoke checks. Record the failed commit, rollback artifact hash, timestamps, symptoms, and follow-up owner; never “fix forward” while a critical production workflow is unavailable.
