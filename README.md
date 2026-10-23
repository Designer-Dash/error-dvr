# Error‑DVR

A local‑only **error DVR** for web apps. It records a rolling window of DOM
mutations, network metadata and console output, uploads one slice when an error
fires, and lets you replay the exact lead‑up — with the failure pinned on a
timeline.

The interface is a soft‑UI dashboard: pale canvas, raised white surfaces, violet
for structure, mint for healthy, coral only for real failure.

![Dashboard](shots/dashboard.png)

> **Read [SECURITY.md](SECURITY.md) before recording anything real.** It documents
> the threat model, the audit that produced this design, and the residual risks.

---

## Quick start

```bash
npm install          # one dependency: express
npm start            # http://127.0.0.1:3000
```

Open the dashboard, paste the admin token printed at startup, and you are in.

```
  Error-DVR (hardened) listening on http://127.0.0.1:3000
  Dashboard  : http://127.0.0.1:3000/
  Demo page  : http://127.0.0.1:3000/demo
  Admin token: 2gKdtqrqa7oynpivlHh7ojgiBcJ5M0AHSird-MnV3II
```

Requires **Node.js ≥ 22.5** for the built‑in `node:sqlite` module. No native build tools.

---

## The three screens

| Route | What it is |
|---|---|
| `/` | Dashboard — greeting, failure count, 24‑hour histogram, recent traces, attention list, detail drawer |
| `/demo` | Instrumented page — throws a real `TypeError` so you can watch a trace appear |
| `/replay/:id` | Trace review — replay canvas, timeline with the error pin, error summary, network/console/events tabs |

### Dashboard

The rail switches between **Dashboard**, **Recordings** (filterable archive with
severity counts), **Issues** (grouped by message) and **Settings** (security
posture). Clicking any trace opens a drawer first; **Open replay** is the primary
action.

### Replay

The left pane is the sandboxed replay with inset playback controls and a timeline;
the red marker sits at the exact moment of first failure. The right pane answers
"what happened": the error, its file and line, a short factual bullet list
(last click, first error, last request), and one clearly‑labelled inference. The
tabbed inspector shows **Network**, **Console** and **Events**, each filterable.

![Replay](shots/replay.png)

---

## Two credentials, deliberately

| Credential | Who holds it | Can do |
|---|---|---|
| **ingest key** | the instrumented page (via `/config.js`) | create slices — nothing else |
| **admin token** | you, the operator | read slices |

The instrumented page is the component most likely to be compromised, so it holds
a write‑only key and can never read another user's recording.

The admin token lives in **`sessionStorage` for that tab only** — never
`localStorage`, never a cookie, never a URL. Share links carry no token; a
recipient unlocks their own tab. A `#token=` fragment is accepted for one‑off
links and stripped from the address bar immediately.

### Replay is isolated by origin

Recorded DOM is attacker‑influenced data. It is sanitised server‑side before
storage, then rendered in an iframe served from **the other loopback hostname**
(`localhost` if you are on `127.0.0.1`, and vice versa). That is a real origin
boundary: the player cannot read the dashboard's DOM or its token, and its CSP
sets `connect-src 'none'` so it cannot exfiltrate.

### Masking actually works

Inputs are masked by rrweb before serialisation; emails, card numbers and long
tokens are redacted from console output and URLs. Mark extra elements with
`data-dvr-sensitive` (mask text) or `data-dvr-block` (exclude entirely).

---

## Tests

```bash
npm test             # 85 black-box security checks against a running server
npm run test:e2e     # 38 headless-Chrome checks: dashboard, replay, recorder
```

Start the server first; both read `data/.secrets.json` for credentials. Pass a base
URL as the first argument to point them at another port:

```bash
node test/security.test.mjs http://127.0.0.1:3100
```

The E2E suite asserts the player is a separate origin, that it cannot read the
parent or hold the token, that rrweb **actually rebuilt the recorded DOM**, that
the error pin is placed, and that the recorder produces an accepted upload. It
reports `SKIP` when no headless browser can start.

`node test/shots-live.mjs` records a fresh session and writes screenshots to
`shots/` — handy for visual review.

---

## Configuration

`src/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | bind address — loopback only |
| `port` | `3000` | override with `DVR_PORT` to run alongside another instance |
| `allowedHosts` | loopback names | `Host` header allow‑list (DNS‑rebinding defence) |
| `maxUploadBytes` | `1048576` | request body cap |
| `maxEventsPerSlice` | `5000` | events per slice |
| `maxSlices` | `2000` | retention; oldest are pruned |
| `maxListLimit` | `100` | maximum rows the dashboard may request |
| `uploadRateLimitPerMin` | `30` | per IP |
| `readRateLimitPerMin` | `240` | per IP |
| `privacyMasking` | `true` | **never disable for real sessions** |
| `sliceLengthSec` | `15` | rolling window |

If you change `host` or `port`, the `ORIGINS` list in `src/server.js` must match,
or the Host check and the player CSP will reject you. That is intentional.

Set `DVR_QUIET=1` to stop the admin token being printed at startup.

---

## Intentional limitations

- HTTP only, loopback only. Do not bind to a real interface without TLS in front.
- The SQLite file is unencrypted; use full‑disk encryption on shared machines.
- External images are blocked during replay (`img-src` limits) so a recorded
  tracker pixel cannot beacon. Image‑heavy replays will look plain.
- The ingest key is public by design; an attacker can add junk slices, bounded by
  retention and rate limits. They cannot read anything.
