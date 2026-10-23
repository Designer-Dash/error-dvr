# Roadmap

> Scope decision (23 Oct 2026): ship Phase 1 for the hackathon deadline.
> Phase 2+ items live here so nothing is lost.

---

## ✅ Phase 1 — Hackathon (shipped)

- [x] Hosted SDK (`public/sdk.js`) — drop-in `<script>` tag
- [x] Self-hosted Express server on Node 22 + `node:sqlite`
- [x] Single allowed origin (`127.0.0.1` / `localhost`)
- [x] Write-only ingest key + read-only admin token (split credentials)
- [x] Upload → sanitise → store → replay pipeline
- [x] XSS-proof sandboxed replay (OOPIF, CSP, recursive scrubbing)
- [x] Dashboard with KPIs, 24h chart, trace list, detail drawer
- [x] Rate limiting, host allow-list, DNS-rebinding defence
- [x] Vendor-pinned rrweb (no CDN)
- [x] 85 security regression tests
- [x] 38 browser E2E tests (headless Chrome)

---

## 🔜 Phase 2 — Post-hackathon (P1)

| Feature | Notes |
|---------|-------|
| Multi-origin CORS | Config-driven `Access-Control-Allow-Origin`. Currently locked to loopback. |
| Source-map integration | Server-side stack deobfuscation at read time. Upload `.map` files via admin API. |
| Session grouping | New `sessions` table + SDK session ID. Link multiple slices from the same user journey. |
| Structured error fingerprinting | Group identical errors by message + stack hash for an "Issues" view. |

## 📋 Phase 3 — Product maturity (P2)

| Feature | Notes |
|---------|-------|
| Webhook / Slack / email alerts | Outbound HTTP on `severity=critical`. Configurable per-channel. |
| Retention policies | Auto-prune by age (not just count). Cron or SQLite trigger. |
| TLS termination guide | Nginx / Caddy reverse proxy reference config. |
| Docker packaging | `Dockerfile` + `docker-compose.yml` for one-command deploy. |
| Privacy redaction audit log | Record what was masked, for compliance review. |

## 🗺️ Phase 4 — Scale (P3)

| Feature | Notes |
|---------|-------|
| Team auth (multi-user, RBAC) | OAuth2 / SSO. Admin, viewer, operator roles. |
| Cloud storage backend | Pluggable interface: S3, GCS, or keep SQLite. |
| Horizontal scaling | Stateless server + external DB (Postgres/Turso). |
| SDK CDN distribution | Optional `npm` package + `unpkg` / `jsdelivr` hosting. |
