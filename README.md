# Error‑DVR

**See exactly what happened in the seconds before your app crashed.** Error‑DVR
records a rolling window of DOM activity, network calls and console output in the
browser, uploads one trace when an error fires, and lets you replay it — with the
failure pinned on a timeline.

Runs on your machine. Nothing leaves it.

```bash
npx error-dvr
```

That prints a dashboard URL and an admin token. Paste the token, and you are in.

![Dashboard](shots/dashboard.png)

---

## Why

A stack trace tells you *where* it broke. It never tells you what the user did
next to it: which button they pressed, which request came back 500, what the form
looked like. Error‑DVR keeps the last 15 seconds in memory and ships that slice
the moment something throws — so you can watch it back instead of guessing.

---

## Quick start

```bash
npx error-dvr
```

```
  Error-DVR  v1.0.0
  record · replay · diagnose the moment before the crash

  ● listening on http://127.0.0.1:3000

  dashboard  http://127.0.0.1:3000
  demo       http://127.0.0.1:3000/demo
  data       /your/project/data

  admin token
  2gKdtqrqa7oynpivlHh7ojgiBcJ5M0AHSird-MnV3II
  paste it into the dashboard to unlock it
```

1. Open the dashboard and paste the token.
2. Open `/demo` and hit **Run controlled crash** to see a trace appear.
3. Add the snippet below to *your* site to start capturing real ones.

Requires **Node.js 22.5+** (it uses the built‑in `node:sqlite`). One dependency: Express.

---

## What it captures

The demo page throws on purpose so you can see the whole loop in one click. Real
pages are detected the same way — the SDK listens for the failures an app
actually dies from:

| Signal | Recorded | Uploads a trace on its own |
|---|---|---|
| Uncaught exception (`throw`, `null.x`, etc.) | yes | **yes** |
| Unhandled promise rejection | yes | **yes** |
| `console.error` / `console.warn` | yes | no — included in the next trace |
| Failed request (4xx / 5xx) | yes | no — included in the next trace |
| A healthy page | — | no trace at all |

So a route that renders fine produces nothing; a route that blows up produces a
trace with the click that led to it, the request that returned 500, and the DOM
as it looked.

---

## Instrument your own site

```bash
npx error-dvr snippet
```

prints a snippet to paste before `</body>`:

```html
<script>
  window.__DVR__ = {
    uploadUrl: "http://127.0.0.1:3000/upload",
    ingestKey: "…",          // write-only
    sliceLengthSec: 15,
    privacyMasking: true
  };
</script>
<script src="http://127.0.0.1:3000/vendor/rrweb.js"></script>
<script src="http://127.0.0.1:3000/sdk.js"></script>
```

It works from any origin — including localhost:5173, a LAN dev box, or a staging
domain — because `/upload` is CORS‑enabled for writes only. If you skip the rrweb
line, the SDK fetches it from the DVR itself. Mark sensitive elements with
`data-dvr-sensitive` (masked) or `data-dvr-block` (excluded).

---

## Commands

| Command | What it does |
|---|---|
| `error-dvr` | start the recorder and dashboard |
| `error-dvr token` | print the admin token and ingest key |
| `error-dvr snippet` | print the instrumentation snippet (uses the last port you started) |
| `error-dvr rotate` | generate a fresh key pair |
| `error-dvr demo` | print the demo page URL |
| `error-dvr --port 4000` | run on a different port |
| `error-dvr --data-dir ./traces` | choose where recordings live |
| `error-dvr --open` | open the dashboard automatically |
| `error-dvr --quiet` | never print the token (CI, screen sharing) |

If the port is busy, Error‑DVR walks to the next free one and tells you.

---

## The screens

| Route | What it is |
|---|---|
| `/` | Dashboard — failure count, 24‑hour histogram, recent traces, attention list |
| `/demo` | Instrumented page that crashes on purpose |
| `/replay/:id` | Replay canvas, timeline with the error pin, error summary, network/console/events tabs |

![Replay](shots/replay.png)

The replay pane answers "what happened" with facts, not guesses: the last click,
the first error and its offset, the last request — plus one clearly labelled
inference.

---

## Privacy

Inputs are masked by rrweb *before* serialisation. Emails, card numbers and long
tokens are redacted from console output and URLs. Recordings never leave the
machine, and replay runs in an iframe served from a second loopback origin, so
captured DOM cannot reach the dashboard or its token.

Details, threat model and the full audit: **[SECURITY.md](SECURITY.md)**.

---

## Configuration

Defaults live in `src/config.json`; the CLI flags above override the common ones.

| Key | Default | Meaning |
|---|---|---|
| `port` | `3000` | listen port (auto-increments if busy) |
| `maxSlices` | `2000` | retention before the oldest are pruned |
| `maxUploadBytes` | `1048576` | per‑trace payload cap |
| `sliceLengthSec` | `15` | rolling window length |
| `uploadRateLimitPerMin` | `30` | per IP |
| `privacyMasking` | `true` | **never disable for real sessions** |

Data lives in `./data` in the directory you run from — delete it for a clean
slate (a new token is generated on next start).

---

## Development

```bash
npm test          # 86 security checks (needs a running server)
npm run test:e2e  # 38 headless-Chrome checks
npm run test:cli  # 31 CLI + CORS checks
npm run test:detect  # 13 checks that real failures are caught on a foreign page
```

Start the server first for the first two; `test:cli` manages its own instance.
`node test/shots-live.mjs` records a real session and refreshes `shots/`.

---

## Limitations

- Loopback only, by design. The replay isolation depends on a second loopback
  origin; put a TLS proxy in front if you need remote access.
- External images are blocked during replay, so recorded tracker pixels cannot
  beacon — image‑heavy replays look plain.
- The ingest key is public by design: it can create traces, never read them.

MIT licensed.
