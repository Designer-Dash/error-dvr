# Security notes — superseded

> **This file previously described a different implementation and was inaccurate.**
> It claimed the following controls, none of which existed in `src/server.js` as reviewed on
> 2026‑10‑23. It has been replaced so it cannot be mistaken for an accurate audit.

## Corrections to the previous version of this file

| Previously claimed | Reality at review time |
|---|---|
| "**Helmet** – added to set secure HTTP headers" | No Helmet and no security headers at all. Now implemented directly in `src/security.js`. |
| "**CORS** – `origin: '*'`" | Not present — and `*` would have been the wrong choice: it would let any website read recordings from a local server. **Do not add it.** Correct behaviour is no CORS headers, which is what the app now does. |
| "**express-rate-limit** – 100 requests / 5 min" | Not present. Replaced with an in-process limiter (30 uploads/min, 120 reads/min). |
| "**Optional API-key auth** via `x-api-key`" | Not present; no authentication of any kind. Replaced with two separate credentials (write-only ingest key, read-only admin token). |
| "**`GET /api/slices`** lists all slice IDs" | Not present. Deliberately **not** added: it would turn IDOR into full-archive enumeration. |
| "**Privacy masking** – all PII is masked before storage" | False. The masking branch never executed (it keyed off rrweb `type === 2`, which is `FullSnapshot`, not a mutation), so recordings were stored in plaintext. Fixed in `public/sdk.js`. |
| "Front‑end kept separate from the security implementation" | The two are coupled: the replay UI executes recorded DOM, which was a critical XSS path. |

## Where the real documentation lives

- **[SECURITY.md](SECURITY.md)** — the full audit: findings, severity, root cause, fixes, verification, residual risk.
- **[README.md](README.md)** — how to run it and how the trust model works.

## Standing rules for this project

1. Never expose the port beyond `127.0.0.1`. `src/config.json` pins the bind address.
2. Do not add permissive CORS. The browser talks to the same origin only; the only exception is
   `Cross-Origin-Resource-Policy: cross-origin` on the handful of assets the sandboxed player
   frame loads (they are public library code).
3. Do not disable privacy masking for real sessions.
4. Run `npm test` and `npm run test:e2e` after any change to `src/` or `public/`.
   Both currently pass (73 security checks, 24 browser checks).
