#!/bin/sh
# All headless tests via macOS JavaScriptCore (no Node, no browser, no deps) --
# the same approach WebSWR uses, for the same reason: the app itself has zero
# dependencies, and a test runner that needed a toolchain would be the only
# thing in the project that did.
#
#   tests/run.sh
#
# Concatenates the pure modules into one bundle per suite and runs it with
# osascript. Any thrown assertion fails that suite and the overall run.
DIR=$(cd "$(dirname "$0")/.." && pwd)
fail=0

runbundle() {
  label=$1; shift
  BUNDLE=$(mktemp /tmp/florun_test.XXXXXX.js)
  cat "$@" > "$BUNDLE"
  echo "== $label =="
  osascript -l JavaScript "$BUNDLE"; rc=$?
  rm -f "$BUNDLE"
  [ $rc -ne 0 ] && fail=1
  echo ""
}

runbundle "core: charts, conversions, flow math, CSV" \
  "$DIR/tests/_shim.js" \
  "$DIR/js/format.js" "$DIR/js/bucket-chart.js" "$DIR/js/weir-chart.js" \
  "$DIR/js/core.js" "$DIR/js/csv.js" \
  "$DIR/tests/test_core.js"

runbundle "pdf writer: structure, escaping, JPEG parsing" \
  "$DIR/tests/_shim.js" \
  "$DIR/js/format.js" "$DIR/js/bucket-chart.js" "$DIR/js/weir-chart.js" \
  "$DIR/js/core.js" "$DIR/js/pdf.js" "$DIR/js/export.js" \
  "$DIR/tests/test_pdf.js"

# Deployment sanity: the quadlet units, Dockerfile and nginx config must agree
# with each other and with config.florun.example. Catches the kind of drift
# that only shows up at 05:00 on a server you are not watching.
echo "== deployment sanity (quadlet + nginx + Dockerfile) =="
if python3 "$DIR/tests/deploy_check.py"; then :; else fail=1; fi
echo ""

# Guard: every runtime module must actually be referenced by index.html AND
# precached by the service worker. The headless bundles load them regardless,
# so only this catches a missing <script> or a stale precache list.
echo "== index.html and sw.js reference every runtime script =="
miss=0
for f in format bucket-chart weir-chart core csv pdf store photos geo stopwatch export ui; do
  grep -q "js/$f.js" "$DIR/index.html" || { echo "  MISSING <script src=\"js/$f.js\"> in index.html"; miss=1; fail=1; }
  grep -q "js/$f.js" "$DIR/sw.js"      || { echo "  MISSING js/$f.js in sw.js precache list"; miss=1; fail=1; }
done
[ $miss -eq 0 ] && echo "  ok: all 13 runtime scripts referenced and precached"
echo ""

# Guard: every element id ui.js reaches for must exist in index.html. A typo
# here fails silently -- the warning or field simply never appears, and no
# headless bundle can catch it because none of them load the DOM.
echo "== ui.js element ids all exist in index.html =="
if python3 - "$DIR" <<'PYEOF'; then :; else fail=1; fi
import io, re, sys
root = sys.argv[1]
ui = io.open(root + "/js/ui.js", encoding="utf-8").read()
html = io.open(root + "/index.html", encoding="utf-8").read()
want = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', ui))
want |= set(re.findall(r'setWarning\("([A-Za-z0-9_-]+)"', ui))
have = set(re.findall(r'id="([A-Za-z0-9_-]+)"', html))
missing = sorted(want - have)
if missing:
    for m in missing:
        print("  MISSING id=\"%s\" in index.html (referenced by ui.js)" % m)
    raise SystemExit(1)
print("  ok: all %d referenced ids present" % len(want))
PYEOF
echo ""

# The service worker cache version must be bumped whenever assets change; a
# stale version is the classic "users stuck on the old build" PWA failure.
echo "== service worker has a cache version =="
if grep -qE 'CACHE *= *"florun-v[0-9]+"' "$DIR/sw.js"; then
  echo "  ok: $(grep -oE 'florun-v[0-9]+' "$DIR/sw.js" | head -1)"
else
  echo "  MISSING or malformed CACHE version constant in sw.js"; fail=1
fi
echo ""

[ $fail -eq 0 ] && echo "ALL GREEN" || echo "SOME TESTS FAILED"
exit $fail
