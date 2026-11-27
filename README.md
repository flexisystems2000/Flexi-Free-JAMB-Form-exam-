# Flexi Free JAMB Form Exam

Mobile-first CBT website for the Flexi Educational Consult Free JAMB Form Initiative.

## Architecture

- **Vercel:** static website hosting and branch preview deployments only.
- **Cloudflare Worker:** all CBT APIs, including candidate verification, attempt creation, question delivery, answer saving/recovery, submission, expiry finalization, proctor events, admin overview, alerts, candidates, and results.
- **Supabase:** CBT operational data and candidate registration records.
- **Question bank:** `flexisystems2000/Flexi-JAMB-CBT-App-`.

The website calls the Cloudflare Worker directly at:

`https://flexi-jamb-cbt-api.flexisystems2000.workers.dev`

There must be no Vercel Serverless Functions or `/api` handlers in this repository. Vercel is used only to preview and serve the frontend.

## Existing registration source

The Cloudflare Worker reads the existing candidate registration records. The CBT must not modify original registration or schedule records.

## Deployment workflow

1. Push frontend changes to `cloudflare-migration`.
2. Vercel creates a preview deployment of the website only.
3. CBT API changes are deployed separately to the Cloudflare Worker.
4. Do not merge to `main` or alter production candidates as part of isolated testing.
