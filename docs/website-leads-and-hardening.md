# Rulix Website Leads and Hosted-App Hardening

This repo owns `app.rulix.cloud` and `dashboard.rulix.cloud`. The public
marketing site at `rulix.cloud` is a separate Netlify surface, so deploy these
website changes from the marketing-site project or Netlify dashboard.

## Live Findings on 2026-06-22

| Surface | Finding | Why it matters |
|---|---|---|
| `rulix.cloud` | Good title and meta description already describe AI-assisted export-control memo review. | The basic positioning is credible and specific. |
| `rulix.cloud/robots.txt` | 404 | Search engines lack crawl guidance. |
| `rulix.cloud/sitemap.xml` | 404 | New pages and future case-study content will be discovered more slowly. |
| `dashboard.rulix.cloud/robots.txt` | Served the app shell before this hardening pass. | Private app surfaces should be explicitly noindexed. |
| `dashboard.rulix.cloud/api/health` | Exposed concrete model IDs before this hardening pass. | Health checks should reveal only capability status, not provider internals. |
| `dashboard.rulix.cloud` | No CSP, HSTS, X-Frame-Options, X-Robots-Tag, or WAF before this hardening pass. | The app edge needed basic production security headers and automated abuse controls. |

## Highest-Value Website Changes

1. Replace the hero CTA with a specific buyer action:
   - Primary: "Book a 20-minute memo audit"
   - Secondary: "See sample audit output"
   - Avoid generic "Request a demo" as the only above-fold action.

2. Add a lead magnet that proves the product in one click:
   - "Upload a redacted memo sample" form for approved prospects.
   - "Download a sample audit pack" with readiness score, evidence gaps,
     reviewer questions, and export-control caveats.
   - Require work email, company, role, and expected review volume.

3. Add three buyer-specific sections:
   - Export-control officers: audit trail, evidence gaps, human signoff.
   - Manufacturers and labs: reduce back-and-forth on product specs.
   - Universities and research ops: triage public or sanitized memos before
     counsel or empowered officials spend time.

4. Make the compliance boundary explicit without scaring buyers away:
   - "Decision support only. Human reviewers decide."
   - "Public, sample, sanitized, or approved data only in this hosted
     commercial environment."
   - "GovCloud or customer-controlled deployment available for controlled
     technical data discussions."

5. Add proof blocks that are concrete but not overclaimed:
   - "Finds missing technical thresholds."
   - "Separates ECCN classification facts from transaction/end-use review."
   - "Produces reviewer-ready questions and an audit trail."
   - Avoid "automates export compliance" or "guarantees classification."

6. Add SEO pages that match buyer searches:
   - `/export-control-memo-review`
   - `/eccn-classification-assistant`
   - `/ai-export-compliance-review`
   - `/university-export-control-review`
   - `/manufacturer-eccn-review`

7. Ship basic crawl assets:
   - `/robots.txt`
   - `/sitemap.xml`
   - canonical URL tags
   - Open Graph image that shows the product UI or a sample audit report, not
     an abstract gradient.

## Suggested Above-Fold Copy

Headline:

```text
Defensible export-control memo review
```

Subcopy:

```text
Rulix checks classification memos for missing thresholds, weak evidence, and
reviewer questions before your export-control team signs off. Human reviewers
decide. Rulix keeps the audit trail organized.
```

Primary CTA:

```text
Book a 20-minute memo audit
```

Trust line:

```text
Use public, sanitized, or approved data in the hosted workspace. Controlled
technical data requires an approved deployment boundary.
```

## Suggested `robots.txt`

```text
User-agent: *
Allow: /

Sitemap: https://rulix.cloud/sitemap.xml
```

## Suggested `sitemap.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://rulix.cloud/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://rulix.cloud/export-control-memo-review</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://rulix.cloud/eccn-classification-assistant</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>
```

## Hosted-App Hardening Shipped in This Repo

- Removed model IDs from `/api/health`.
- Restricted CORS in production to `app.rulix.cloud` and
  `dashboard.rulix.cloud` unless `RULIX_ALLOWED_ORIGINS` is set.
- Added app security headers and noindex behavior for app/dashboard hosts.
- Added dashboard/app `robots.txt` and `sitemap.xml` behavior that prevents
  private surfaces from being indexed.
- Added CloudFront response headers policy and AWS WAF managed/rate-limit rules.
- Added KMS-encrypted retention for the real Lambda log group.
- Added required controlled-data acknowledgements before upload, paste, or new
  review creation.
- Added memo archive support so old memos are retained in account state but
  removed from the active review queue.
