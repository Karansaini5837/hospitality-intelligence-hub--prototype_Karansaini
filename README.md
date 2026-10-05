# Hospitality Intelligence Hub — prototype

Interactive prototype of an AI revenue-attribution platform for UK independent restaurants, with a small Node.js backend that powers the site's forms, footer and demo assistant.

## Run it

Requires Node.js 18 or newer. There are no dependencies to install and no paid services.

```bash
npm start        # → http://localhost:3000
```

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default `3000`) |
| `ADMIN_TOKEN` | Enables the read-only admin endpoints below |
| `DATA_DIR` | Where submissions are stored (default `./data`, git-ignored) |

Opening `index.html` directly, or hosting it on a static host such as GitHub Pages, still works. The footer shows "Static preview · backend offline", legal documents load from `content/legal.json`, and forms tell visitors to email instead.

## What the backend does

| Feature | Where | Endpoint |
|---|---|---|
| Newsletter sign-up (consent recorded, duplicate-safe) | Footer | `POST /api/newsletter/subscribe` |
| Unsubscribe | Footer → Unsubscribe | `POST /api/newsletter/unsubscribe` |
| Legal documents (Privacy, Terms, Cookies, DPA, Accessibility) | Footer → Legal & Trust | `GET /api/legal`, `GET /api/legal/:slug` |
| UK GDPR data-rights requests (reference number + one-month due date) | Footer → Your Data Rights | `POST /api/privacy-requests` |
| Live platform status badge | Footer | `GET /api/status` |
| Pilot application, demo-call booking, general enquiries | Contact page | `POST /api/enquiries` |
| Demo assistant chat (scripted answers, no external AI) | Chat bubble | `POST /api/ai/chat` |
| Sample insight for each demo step (template) | Live Demo | `POST /api/ai/insight` |
| Admin summary and CSV/JSON export | — | `GET /api/admin/summary`, `GET /api/admin/export/{subscribers,enquiries,privacyRequests}.{csv,json}` |

Admin requests need `Authorization: Bearer $ADMIN_TOKEN`, for example:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3000/api/admin/export/enquiries.csv -o enquiries.csv
```

Safeguards: input validation with per-field errors, a 32 KB body limit, per-IP rate limits, a honeypot field against spam bots, IP addresses stored only as hashes, atomic writes to the JSON store, security headers, an allow-list of static paths (server code and `data/` are never served), and protection against formula injection in CSV exports.

## Footer

All 14 pages share one footer, rendered by `assets/site.js`. Every link works:

- **Platform / Company** links are real `#/page` URLs, so they can be bookmarked, shared and opened in a new tab, and the browser Back button works.
- **Legal & Trust** links open accessible dialogs: focus is trapped inside, Escape closes them, and each has a print/save-as-PDF option.
- The **share buttons** share the current page on LinkedIn or X, email the team, or copy the link.

## Project layout

```
index.html          the single-page prototype
assets/site.js      footer, routing, dialogs, forms, API client
assets/site.css     footer, dialog and form styles
content/legal.json  legal documents (served by the API, static fallback)
server.mjs          Node.js backend (no required dependencies)
test/api.test.mjs   API tests (npm test)
```

The legal documents are drafts. Have a UK solicitor review them before the platform processes real customer data.
