# FloRun (web)

A field flow-rate calculator for environmental work — wastewater, stormwater,
SWPPP, construction-site decants and impoundments. It estimates **gallons per
minute, hour and day** from four kinds of reading:

| Method | What you enter | Stopwatch? |
| --- | --- | --- |
| **Timed volume** | captured volume in mL, L, fl oz or US gal | yes |
| **Calibrated bucket** | water-column height in a standard 5-gal pail | yes |
| **V-notch weir** | head height on a 90° or 60° triangular notch | no |
| **Manual entry** | a GPM value measured some other way | no |

Saved measurements carry an optional site label, notes, a photo and GPS
coordinates, and export as **PDF** (single record or the whole history) or
**CSV**.

This is the web port of the FloRun iOS app. The charts, conversion factors and
export layouts are ports of the originals, so a PDF from either platform can sit
in the same folder without looking like it came from a different tool.

## Design constraints

**No dependencies, no build step.** Plain ES5-compatible JavaScript in IIFE
modules hung off one global (`FloRun`), loaded with `<script src>`. There is
nothing to `npm install`, nothing to transpile, and nothing that can rot in a
lockfile. Editing a file and reloading is the whole development loop.

**Works entirely offline.** A service worker precaches the app shell. The app
makes no network requests of its own: no CDNs, no fonts, no analytics, no
telemetry, and it ships zero `fetch`/XHR code outside the service worker.

**Data stays on the device.** History lives in `localStorage`, photos as blobs
in IndexedDB. Nothing is uploaded anywhere. The last **25** measurements are
kept; saving a 26th removes the oldest, and its photo is deleted with it, so
storage stays flat forever without anyone maintaining it.

**Strict CSP.** `default-src 'none'` with no inline scripts, no inline event
handlers and no `eval`. The only relaxations are `img-src blob:` (photo
previews), `worker-src`, `manifest-src` and a same-origin `connect-src` for the
service worker revalidating its own assets.

## Layout

```
index.html            markup only; every handler is bound in js/ui.js
manifest.webmanifest  PWA manifest (installable, standalone, portrait)
sw.js                 service worker: precache + cache-first, versioned
css/styles.css        field-first styling: big targets, high contrast, dark mode
icons/                droplet mark: SVG plus rendered PNGs incl. maskable
js/
  format.js           number, duration and date formatting; locale-tolerant parsing
  bucket-chart.js     5-gal pail height -> gallons, interpolated
  weir-chart.js       90°/60° V-notch head -> GPM, interpolated
  core.js             units, flow math, the record shape
  csv.js              RFC 4180 export
  pdf.js              minimal PDF 1.4 writer (text, rules, fills, JPEG embed)
  store.js            localStorage history + IndexedDB photos, 25-record cap
  photos.js           capture, downscale, re-encode
  geo.js              one-shot location fix, 5s ceiling, never rejects
  stopwatch.js        monotonic timing, persistence, wake lock
  export.js           PDF/CSV layouts and delivery
  ui.js               view wiring
deploy/               rootless Podman deployment (see deploy/README.md)
tests/                headless test suite (see below)
```

### Why a hand-rolled PDF writer

The web has no `UIGraphicsPDFRenderer`, and a PDF library would break both the
no-dependency rule and the CSP. `js/pdf.js` is a few hundred lines because it
only needs four primitives — text, lines, filled rectangles and images — and two
things keep it small:

1. The 14 standard PDF fonts need no embedding, so there is no font subsetting.
   The ASCII width tables for Helvetica ship inline for measurement.
2. PDF's `DCTDecode` filter takes raw JPEG bytes verbatim, so a photo the browser
   already encoded is embedded **losslessly and without recompression** — we only
   parse its header for dimensions.

## Tests

```sh
sh tests/run.sh
```

Runs on macOS **JavaScriptCore** via `osascript` — no Node, no browser, no
dependencies, matching the app itself. Three suites:

- **core** — chart lookups against their exact published values, NIST conversion
  factors, flow math, formatting, CSV escaping. Table points must round-trip
  *exactly*; interpolated points must hit the arithmetic midpoint; out-of-range
  input must clamp or zero rather than extrapolate. Both charts are asserted
  strictly increasing (the invariant that caught a transcription typo in the 90°
  weir table, where 23 in read 4565 instead of 5565 and made discharge *fall* as
  head rose).
- **pdf** — document structure, WinAnsi encoding, string escaping, text
  measurement, word wrap, JPEG parsing, and byte-exact xref offsets. Every xref
  entry is parsed back out of the emitted bytes and checked to land on its
  object header.
- **deploy** — `tests/deploy_check.py`: container hardening flags, network
  isolation, distinct non-root UIDs below the namespace size, updater safety
  properties, nginx headers, and that the service-worker precache list matches
  both the files on disk and the scripts `index.html` loads.

## Running locally

Any static file server will do:

```sh
python3 -m http.server 8795
```

Then open `http://localhost:8795/`. Service workers and geolocation need a
secure context — `localhost` counts, so both work without TLS in development.

## Deployment

See **[deploy/README.md](deploy/README.md)**. Summary: a hardened
`nginx-unprivileged` container (read-only rootfs, all capabilities dropped, its
own user namespace, tmpfs for everything writable) on an **internal-only network
with no route to the internet**, reached solely through a Cloudflare tunnel
sidecar. No ports are published. Rootless Podman with systemd Quadlet units and
a daily update timer that rolls back automatically if a new build fails to come
up.

All deployment values live in `config.florun` (copy `config.florun.example`),
which is parsed as data, never sourced, and validated before anything is touched.

## Assistance aid only

FloRun is an **assistance aid**. Results are estimates and may contain errors
from chart interpolation, transcription, input precision or device timing. The
bucket chart describes a *generic* 5-gallon pail; brands differ by a few percent.
The weir tables assume a correctly installed weir (sharp crest, free discharge,
head measured 3–4× the maximum head upstream, adequate approach pool, end
contractions, level crest).

Provided "AS IS" without warranty of any kind. For regulatory reporting,
compliance documentation or any critical decision, verify results with calibrated
instruments and qualified personnel. The app states this on first launch, beside
every result, and in its PDF exports.

## License

GPL-3.0 — see [LICENSE](LICENSE).
