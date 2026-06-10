# Rulix — marketing site

Public site for Rulix, the human-review-first export-control memo audit console.

- **Stack:** Vite + React 18 + TypeScript + Tailwind CSS v4 (same design tokens as the reviewer console)
- **Pages:** Home (`/#/`), Security (`/#/security`), Legal (`/#/legal`)
- **Deploy:** static output (`dist/`) — Vercel-ready, no server required

## Develop

```sh
npm install
npm run dev     # http://localhost:5174
```

## Build

```sh
npm run build   # typecheck + vite build → dist/
```

## Messaging guardrails

Copy on this site must never imply that Rulix issues final ECCN, license, sanctions,
or jurisdiction determinations. All product visuals use demo data only. Input-scope
warnings (sanitized / public / approved text only) stay prominent on every page.
