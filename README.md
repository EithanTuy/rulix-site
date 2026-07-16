# Rulix marketing site

Public site for Rulix, the human-review-first export-control memo audit console.

- **Stack:** Vite + React 18 + TypeScript + Tailwind CSS v4
- **Pages:** Home (`/`), Security (`/security`), Legal (`/legal`), Contact (`/contact`), SEO landing pages
- **Deploy:** Netlify static output (`dist/`) for `rulix.cloud`, with native Netlify Forms lead capture

## Develop

```sh
npm install
npm run dev     # http://localhost:5174
```

## Build

```sh
npm run build   # typecheck + vite build -> dist/
```

## SEO routes

- `/export-control-memo-review`
- `/eccn-classification-assistant`
- `/ai-export-compliance-review`
- `/university-export-control-review`
- `/manufacturer-eccn-review`

Netlify uses `public/_redirects` so these browser routes serve `index.html`.

## Access-request delivery

The request-access form posts to the Netlify form named `access-request`. Netlify
detects the hidden form declaration in `index.html`, validates the honeypot field,
and stores submissions in the site dashboard without requiring a separate API.
If delivery fails, the visitor sees an inline error and direct-email fallback.

## Messaging guardrails

Copy on this site must never imply that Rulix issues final ECCN, license, sanctions,
or jurisdiction determinations. All product visuals use demo data only. Input-scope
warnings (sanitized / public / approved text only) stay prominent on every page.
