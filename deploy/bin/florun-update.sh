#!/bin/bash
# FloRun daily deploy (rootless podman, run by florun-update.timer).
#
# Order is the failsafe: pull before touching anything, build the new image
# before stopping anything, and prune only once the new containers are up. Any
# failure aborts (set -e) and the running container keeps serving last-known
# good. If a fresh build starts but the container will not come up, the
# previous image is restored automatically.
#
# The braces make bash parse the whole file before executing any of it, so the
# copy below replacing this script mid-run cannot corrupt this run.
#
# All deployment-specific values live in config.florun (see
# config.florun.example); this script carries no hardcoded paths, UIDs or
# names. It self-locates: the install directory is wherever config.florun lives --
# FLORUN_BASE, this script's own directory, or its parent.
{
set -eEu

# ── Refuse root ──────────────────────────────────────────────────────
# The whole point of the rootless deployment is that this job is not root. A
# root run would also leave root-owned files in a checkout the service user then
# cannot write.
if [ "$(id -u)" -eq 0 ]; then
  echo "FATAL: florun-update.sh must not run as root (this is the rootless deployment)." >&2
  exit 1
fi

# The install directory is the git checkout: config.florun, update.log and the
# build context all live inside it, and nothing is written outside it. The
# systemd unit passes FLORUN_BASE; the walk-up is for running this by hand from
# somewhere inside the checkout.
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE=""
if [ -n "${FLORUN_BASE:-}" ] && [ -f "$FLORUN_BASE/config.florun" ]; then
  BASE="$(cd "$FLORUN_BASE" && pwd)"
else
  probe="$SELF_DIR"
  for _ in 1 2 3 4; do
    if [ -f "$probe/config.florun" ]; then BASE="$probe"; break; fi
    probe="$(cd "$probe/.." && pwd)"
    [ "$probe" = "/" ] && break
  done
fi
if [ -z "$BASE" ]; then
  echo "FATAL: config.florun not found (looked in \$FLORUN_BASE and upward from $SELF_DIR)." >&2
  echo "Run deploy/install.sh from the checkout to create it. Nothing was changed." >&2
  exit 1
fi

# config.florun is parsed as DATA, never sourced -- a config file should not be
# able to execute code, and a malformed line gets a clear FATAL instead of bash
# noise. KEY=value lines only; last assignment wins; CRLF tolerated.
cfg() { sed -n "s/^$1=//p" "$BASE/config.florun" | tail -1 | tr -d '\r'; }
APP_UID="$(cfg APP_UID)"
TUNNEL_UID="$(cfg TUNNEL_UID)"
STACK_NAME="$(cfg STACK_NAME)"
SUBPATH="$(cfg SUBPATH)"

# Validate BEFORE touching anything: a typo'd or missing value aborts here with
# nothing changed and the running site still serving.
case "$SUBPATH" in
  .) ;; # sanctioned: serve at the domain root
  *[!A-Za-z0-9._-]*|""|*..*) echo "FATAL: SUBPATH must be a plain path segment (A-Za-z0-9._- and no '..') or '.'" >&2; exit 1 ;;
esac
case "$STACK_NAME" in
  *[!A-Za-z0-9_-]*|"") echo "FATAL: STACK_NAME must be non-empty, characters A-Za-z0-9_-" >&2; exit 1 ;;
esac
case "$APP_UID" in    *[!0-9]*|""|0) echo "FATAL: APP_UID must be a non-root numeric UID" >&2; exit 1 ;; esac
case "$TUNNEL_UID" in *[!0-9]*|""|0) echo "FATAL: TUNNEL_UID must be a non-root numeric UID" >&2; exit 1 ;; esac
command -v podman >/dev/null || { echo "FATAL: podman is required" >&2; exit 1; }
command -v git >/dev/null || { echo "FATAL: git is required" >&2; exit 1; }

# The tunnel cannot start without its secret. Fail here with instructions
# rather than letting the container flap at 05:00.
if ! podman secret exists florun-tunnel-token 2>/dev/null; then
  if ! podman secret inspect florun-tunnel-token >/dev/null 2>&1; then
    echo "FATAL: podman secret 'florun-tunnel-token' is missing. Create it with:" >&2
    echo "  printf '%s' 'YOUR-TOKEN' | podman secret create florun-tunnel-token -" >&2
    exit 1
  fi
fi

# ── Self-logging ─────────────────────────────────────────────────────
# Every run (timer or manual) appends to $BASE/update.log with a start banner,
# an OK/ABORTED end line, and the deployed commit + image ids -- so a silent
# abort or a tampered deploy is visible in one glance at the log, not just as a
# mysteriously stale site. Size-rotated in place (no logrotate dependency).
# Written owner-only: on a host with several service accounts, siblings have no
# business reading this.
LOG="$BASE/update.log"
umask 077
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1048576 ]; then mv -f "$LOG" "$LOG.1"; fi
exec > >(tee -a "$LOG") 2>&1
# Restore a normal umask now that the log file exists. The 077 above must NOT
# survive into the `git pull` below, and this is not a hypothetical: it did,
# and it broke production. Every file that pull rewrote was created 0600, COPY
# carried that mode into the image, and nginx -- running as an unprivileged UID
# that owns none of it -- answered 403 Forbidden for files that were sitting
# right there. The giveaway is in nginx's own error log, not the HTTP status:
#
#   open() ".../index.html" failed (13: Permission denied)
#
# What made it stick is that git records no mode beyond the executable bit, so
# a later pull does not repair those files -- it does not touch them at all.
# This line stops new damage; the chmod before the build repairs old damage.
umask 022
echo "=== update run started $(date -u +%FT%TZ) ==="
trap 'echo "=== ABORTED (exit $?) $(date -u +%FT%TZ) ==="' ERR

CHECKOUT="$BASE"
IMAGE="localhost/florun-website:latest"
ROLLBACK="localhost/florun-website:rollback"

[ -d "$CHECKOUT/.git" ] || {
  echo "FATAL: $CHECKOUT is not a git checkout. Nothing was changed." >&2; exit 1; }

# ── Fetch ────────────────────────────────────────────────────────────
# Pull from whatever remote the checkout already has. --ff-only so a rewritten
# or diverged history stops the deploy rather than being silently merged into
# something nobody reviewed. A failed pull aborts with nothing changed.
#
# safe.directory is failure insurance for a checkout whose ownership drifted.
git -C "$CHECKOUT" -c safe.directory="$CHECKOUT" pull --ff-only

# ── Refresh the deployment itself ────────────────────────────────────
# The pull above updates the CHECKOUT, but the running units live in
# ~/.config/containers/systemd and this very script was copied to
# ~/.local/bin -- so without this step a change to a quadlet unit, or to the
# updater, would sit in the checkout doing nothing until someone re-ran
# install.sh by hand. Re-running it here is safe:
#
#   * --yes is non-interactive: it reads the EXISTING config.florun rather than
#     rewriting it, never touches the tunnel secret, and starts nothing.
#   * Overwriting this script mid-run cannot corrupt the run, because the { }
#     wrapper made bash parse the whole file before executing any of it.
#
# If install.sh fails the deploy aborts here, with the old containers still
# serving.
if [ -x "$CHECKOUT/deploy/install.sh" ]; then
  echo "--- refreshing units and updater from the checkout ---"
  "$CHECKOUT/deploy/install.sh" --yes --base-dir "$BASE"
  echo "--- refresh done ---"
fi

# ── Sanity-check the tree ────────────────────────────────────────────
# The build context IS the checkout (there is no separate webroot to assemble:
# every file the image needs is version-controlled, and .dockerignore is an
# allowlist so .git, tests/ and deploy/ never enter the context). Confirm the
# expected files are present and are real files -- a symlink here would make
# the build follow a link out of the tree.
for item in index.html manifest.webmanifest sw.js Dockerfile nginx.conf .dockerignore; do
  if [ -h "$CHECKOUT/$item" ] || [ ! -f "$CHECKOUT/$item" ]; then
    echo "FATAL: expected regular file $item is missing from the checkout" >&2; exit 1
  fi
done
for d in css js icons; do
  if [ -h "$CHECKOUT/$d" ] || [ ! -d "$CHECKOUT/$d" ]; then
    echo "FATAL: expected directory $d is missing from the checkout" >&2; exit 1
  fi
done

# ── Normalize permissions in the build context ───────────────────────
# COPY preserves the source file's mode, so a file that is 0600 on disk is
# 0600 in the image -- and nginx, running as an unprivileged UID that owns
# none of it, answers "403 Forbidden / Permission denied" for a file that is
# demonstrably present. That is a genuinely confusing failure.
#
# This is not hypothetical: an earlier version of this script left umask 077
# set across its own `git pull`, so every file that pull rewrote landed as
# 0600. Git tracks no mode beyond the executable bit, so those files stay 0600
# through every subsequent pull and checkout -- the damage outlives the bug.
#
# Every file listed here is served publicly by definition, so making them
# world-readable costs nothing. config.florun and update.log are deliberately
# NOT in the list: they stay owner-only.
for asset in index.html manifest.webmanifest sw.js nginx.conf Dockerfile css js icons; do
  [ -e "$BASE/$asset" ] && chmod -R a+rX "$BASE/$asset"
done

# ── Build ────────────────────────────────────────────────────────────
# Keep the currently-deployed image so a failed rollout can be undone. --pull
# is what keeps the nginx base patched; without it the cached base would never
# see another CVE fix.
if podman image exists "$IMAGE"; then
  podman tag "$IMAGE" "$ROLLBACK"
fi

podman build --pull -t "$IMAGE" --build-arg "SUBPATH=$SUBPATH" -f "$BASE/Dockerfile" "$BASE"
podman pull docker.io/cloudflare/cloudflared:latest

# ── Restart ──────────────────────────────────────────────────────────
systemctl --user daemon-reload
if ! systemctl --user restart florun-website.service florun-cloudflared.service; then
  echo "Restart FAILED -- rolling back to the previous image" >&2
  if podman image exists "$ROLLBACK"; then
    podman tag "$ROLLBACK" "$IMAGE"
    systemctl --user restart florun-website.service florun-cloudflared.service || true
  fi
  exit 1
fi

# Give the unit a moment to settle, then confirm it is genuinely up. systemd
# reports success on start; this catches a container that starts and
# immediately dies.
sleep 5
if ! systemctl --user is-active --quiet florun-website.service; then
  echo "florun-website did not stay up -- rolling back to the previous image" >&2
  if podman image exists "$ROLLBACK"; then
    podman tag "$ROLLBACK" "$IMAGE"
    systemctl --user restart florun-website.service || true
  fi
  exit 1
fi

# ── Smoke test ───────────────────────────────────────────────────────
# is-active only proves the process is up; it says nothing about WHAT is being
# served. A wrong SUBPATH puts the site in a subdirectory and leaves nginx's
# stock welcome page at the root -- a deployment that looks healthy from every
# angle except the one that matters (container running, tunnel connected, site
# wrong). Fetch the exact path the tunnel will hit and confirm FloRun is in it.
#
# A probe that cannot run is reported as skipped, never as a pass: "no wget in
# the image" and "the site is broken" must not produce the same silence.
if [ "$SUBPATH" = "." ]; then PROBE="/"; else PROBE="/$SUBPATH/"; fi
if podman exec "$STACK_NAME" sh -c 'command -v wget' >/dev/null 2>&1; then
  # -S puts the response headers on stderr, and 2>&1 keeps them: busybox wget
  # with -q prints NOTHING for a 404, a refused connection or an empty body
  # alike, so without the status line a failure says only "returned nothing" --
  # which is exactly as unhelpful as it sounds when the deploy is broken.
  RESP="$(podman exec "$STACK_NAME" wget -S -O- "http://127.0.0.1:8080$PROBE" 2>&1 || true)"
  STATUS="$(printf '%s\n' "$RESP" | sed -n 's|^ *HTTP/1\.[01] \([0-9][0-9][0-9]\).*|\1|p' | head -1)"

  case "$RESP" in
    *FloRun*)
      echo "smoke test: $PROBE serves FloRun (HTTP ${STATUS:-200})"
      ;;
    *)
      echo "SMOKE TEST FAILED: $PROBE did not serve FloRun (HTTP ${STATUS:-none})." >&2
      case "$RESP" in
        *"Welcome to nginx"*)
          echo "  It is nginx's stock welcome page: the site was built into a subdirectory." >&2
          ;;
      esac
      if [ "$STATUS" = "403" ]; then
        echo "  A 403 at the site root is nginx refusing to serve. Either it cannot READ" >&2
        echo "  index.html, or index.html is absent and it will not list the directory." >&2
        echo "  The nginx error log below says which. What the image actually contains:" >&2
        podman run --rm --entrypoint sh "$IMAGE" -c 'ls -la /usr/share/nginx/html/' 2>&1 |
          sed 's/^/  | /' >&2
      elif [ "$STATUS" = "404" ]; then
        echo "  A 404 at the site root means index.html is not where nginx expects it." >&2
        echo "  SUBPATH is '$SUBPATH'; check where the files actually landed with:" >&2
        echo "    podman run --rm --entrypoint sh $IMAGE -c 'ls -R /usr/share/nginx/html'" >&2
      elif [ -z "$STATUS" ]; then
        echo "  No HTTP status at all -- nginx did not answer on 127.0.0.1:8080 inside" >&2
        echo "  the container. Check: podman logs $STACK_NAME" >&2
      fi
      # The full response is worth having in the log; a failed deploy is not
      # the moment to be economical about output.
      echo "  --- probe response (first 20 lines) ---" >&2
      printf '%s\n' "$RESP" | head -20 | sed 's/^/  | /' >&2
      echo "  --- nginx's own log (it names the file it could not serve) ---" >&2
      podman logs --tail 15 "$STACK_NAME" 2>&1 | sed 's/^/  | /' >&2
      echo "  --- end ---" >&2
      echo "  Rolling back to the previous image." >&2
      if podman image exists "$ROLLBACK"; then
        podman tag "$ROLLBACK" "$IMAGE"
        systemctl --user restart florun-website.service || true
      fi
      exit 1
      ;;
  esac
else
  echo "smoke test SKIPPED: no wget in the container image (probe could not run)"
fi

# ── Record and clean up ──────────────────────────────────────────────
# Forensic record: exactly what is deployed right now. With the start/OK
# banners this makes the log a verifiable timeline of every change that
# reached production.
echo "deployed commit: $(git -C "$CHECKOUT" rev-parse HEAD)"
echo "deployed image:  $(podman image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || echo unknown)"
podman ps --filter "name=$STACK_NAME" --format 'running: {{.Names}} {{.Image}} ({{.Status}})'

# Prune only now that the new containers are proven up. Rootless prune touches
# only this user's own image store, so it cannot disturb another stack.
podman image rm "$ROLLBACK" >/dev/null 2>&1 || true
podman system prune -f >/dev/null

echo "=== OK $(date -u +%FT%TZ) ==="
exit 0
}
