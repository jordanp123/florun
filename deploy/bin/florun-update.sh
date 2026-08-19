#!/bin/bash
# FloRun daily deploy (rootless podman, run by florun-update.timer).
#
# Order is the failsafe: pull before touching the webroot, build the new image
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
# names. It self-locates: the webroot is wherever config.florun lives -- either
# FLORUN_BASE, this script's own directory, or its parent.
{
set -eEu

# ── Refuse root ──────────────────────────────────────────────────────
# The whole point of the rootless deployment is that this job is not root. A
# root run would also leave root-owned files in a webroot the service user then
# cannot write.
if [ "$(id -u)" -eq 0 ]; then
  echo "FATAL: florun-update.sh must not run as root (this is the rootless deployment)." >&2
  exit 1
fi

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${FLORUN_BASE:-}" ] && [ -f "$FLORUN_BASE/config.florun" ]; then
  BASE="$(cd "$FLORUN_BASE" && pwd)"
elif [ -f "$SELF_DIR/../config.florun" ]; then
  BASE="$(cd "$SELF_DIR/.." && pwd)"
elif [ -f "$SELF_DIR/config.florun" ]; then
  BASE="$SELF_DIR"
else
  echo "FATAL: config.florun not found (looked in \$FLORUN_BASE, $SELF_DIR and its parent)." >&2
  echo "Copy config.florun.example to the webroot as config.florun and edit it." >&2
  echo "Nothing was changed." >&2
  exit 1
fi

# config.florun is parsed as DATA, never sourced -- a config file should not be
# able to execute code, and a malformed line gets a clear FATAL instead of bash
# noise. KEY=value lines only; last assignment wins; CRLF tolerated.
cfg() { sed -n "s/^$1=//p" "$BASE/config.florun" | tail -1 | tr -d '\r'; }
REPO_URL="$(cfg REPO_URL)"
CHECKOUT_DIR="$(cfg CHECKOUT_DIR)"
APP_UID="$(cfg APP_UID)"
TUNNEL_UID="$(cfg TUNNEL_UID)"
STACK_NAME="$(cfg STACK_NAME)"
SUBPATH="$(cfg SUBPATH)"

# Validate BEFORE touching anything: a typo'd or missing value aborts here with
# the webroot untouched and the running site still serving.
[ -n "$REPO_URL" ] || { echo "FATAL: config.florun must set REPO_URL" >&2; exit 1; }
case "$CHECKOUT_DIR" in
  *[!A-Za-z0-9._-]*|""|.|..|*..*) echo "FATAL: CHECKOUT_DIR must be a plain directory name (A-Za-z0-9._- and no '..')" >&2; exit 1 ;;
esac
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
echo "=== update run started $(date -u +%FT%TZ) ==="
trap 'echo "=== ABORTED (exit $?) $(date -u +%FT%TZ) ==="' ERR

CHECKOUT="$BASE/$CHECKOUT_DIR"
IMAGE="localhost/florun-website:latest"
ROLLBACK="localhost/florun-website:rollback"

# ── Fetch ────────────────────────────────────────────────────────────
# First run on a fresh server clones; day to day it pulls. A failed clone/pull
# aborts with the webroot untouched.
if [ ! -d "$CHECKOUT/.git" ]; then
  git clone "$REPO_URL" "$CHECKOUT"
fi
git -C "$CHECKOUT" -c safe.directory="$CHECKOUT" pull --ff-only

# ── Assemble the webroot ─────────────────────────────────────────────
# The build context is the webroot, not the checkout. Copy only the files the
# image actually needs, and refuse symlinks: nothing from the repo should be
# able to make the build follow a link out of the tree.
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

rm -rf "$BASE/css" "$BASE/js" "$BASE/icons"
cp -R "$CHECKOUT/css" "$CHECKOUT/js" "$CHECKOUT/icons" "$BASE/"
cp "$CHECKOUT/index.html" "$CHECKOUT/manifest.webmanifest" "$CHECKOUT/sw.js" \
   "$CHECKOUT/Dockerfile" "$CHECKOUT/nginx.conf" "$BASE/"
cp "$CHECKOUT/.dockerignore" "$BASE/"

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
