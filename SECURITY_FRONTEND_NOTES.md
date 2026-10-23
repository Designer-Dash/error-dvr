# Security & Frontend Tracking Notes

> Last updated: 23 Oct 2026

---

## Security (DeepSeek) — ✅ Complete for Phase 1

### Implemented in `src/security.js`
- **Secret management** (`loadSecrets`): Auto-generates 256-bit `ingestKey` + `adminToken` on first run, persisted to `data/.secrets.json` with mode `0o600`.
- **Constant-time credential comparison** (`safeEqual`): SHA-256 hashing + `timingSafeEqual` to prevent length-oracle attacks.
- **Split credential gates** (`requireCredential`): Write-only ingest key vs read-only admin token. No confusion possible.
- **Security headers + CSP** (`securityHeaders`, `playerCsp`): `default-src 'none'`, `frame-ancestors`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, COOP, CORP.
- **Host allow-list** (`hostAllowlist`): DNS-rebinding defence. Foreign `Host` headers get `421`.
- **Rate limiting** (`rateLimit`): Fixed-window per-IP. Dependency-free, in-process.
- **Event sanitisation** (`sanitizeEvents`, `scrub`): Recursive scrubbing of `on*` handlers, `javascript:` URIs, `srcdoc`, blocked tags (`script`, `iframe`, `object`, `embed`, `applet`, `frame`, `frameset`, `base`). Depth-limited to 64.

### Verified by tests
- 85 security regression checks (all PASS)
- 38 browser E2E checks including XSS execution test (all PASS)

### Known residual risks (documented in SECURITY.md)
- HTTP only — do not expose without TLS reverse proxy
- SQLite file is unencrypted at rest — rely on FDE
- Ingest key is public by design — junk slices bounded by rate limits + retention

---

## Frontend (ChatGPT) — Functional, Polish Pending

### What exists
| File | Purpose | Status |
|------|---------|--------|
| `public/app.html` + `app.css` + `app.js` | Dashboard SPA | ✅ Working |
| `public/replay.html` + `replay.css` + `replay.js` | Trace replay page | ✅ Working |
| `public/demo.html` + `demo.css` + `demo.js` | Instrumented demo page | ✅ Working |
| `public/player.html` + `player.js` | Sandboxed rrweb player (OOPIF) | ✅ Working |
| `public/sdk.js` | Client-side recording SDK | ✅ Working |

### What the E2E tests confirm
- Dashboard unlocks, renders KPIs, chart, trace list, detail drawer
- Replay loads, DOM is rebuilt, error pin placed, network/console/events tabs work
- Demo page bootstraps SDK, crash triggers upload, result card rendered

### What's not done yet
- Full design-system polish (typography, spacing, colour harmony)
- Responsive mobile layout
- Dark mode toggle
- Accessibility audit (ARIA, keyboard nav, contrast)
- Loading skeleton states
- Empty states for zero-trace dashboard

---

## Backend (Antigravity) — ✅ Complete for Phase 1

All backend work is done and tested. See [ROADMAP.md](./ROADMAP.md) for Phase 2+ features.
