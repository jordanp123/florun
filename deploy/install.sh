#!/bin/bash
# Installs the FloRun rootless-Podman deployment: quadlet units, the systemd
# timer and the updater. Safe to re-run -- after editing a unit, pulling a new
# version, or moving the webroot.
#
# It exists because Quadlet files are systemd units and systemd does NOT expand
# ${VAR}. This script reads config.florun once and writes the real UIDs, names,
# subpath and webroot into the installed copies, so config.florun stays the
# single source of truth and nothing is ever hand-edited.
set -eEu

usage() {
  cat <<'USAGE'
Usage: deploy/install.sh [--yes] [--base-dir PATH]

  --yes             accept the detected webroot without prompting
  --base-dir PATH   webroot to install for (or set FLORUN_BASE=PATH)
  --help            this message

The webroot is the directory holding config.florun, with the git checkout
inside it. Typically ~/florun.
USAGE
}

ASSUME_YES=0
BASE_ARG="${FLORUN_BASE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    --base-dir) BASE_ARG="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -eq 0 ]; then
  echo "FATAL: run this as the unprivileged deploy user, not root." >&2
  echo "The rootless deployment exists so that neither the containers nor the" >&2
  echo "nightly update job run with root privileges." >&2
  exit 1
fi

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"     # .../<checkout>/deploy
REPO_DIR="$(cd "$SELF_DIR/.." && pwd)"        # .../<checkout>

# Locate the webroot: explicit flag, else the checkout's parent.
if [ -n "$BASE_ARG" ]; then
  BASE="$(cd "$BASE_ARG" 2>/dev/null && pwd)" || { echo "FATAL: --base-dir '$BASE_ARG' does not exist" >&2; exit 1; }
else
  BASE="$(cd "$REPO_DIR/.." && pwd)"
fi

echo "Webroot:  $BASE"
echo "Checkout: $REPO_DIR"
if [ ! -f "$BASE/config.florun" ]; then
  echo >&2
  echo "FATAL: $BASE/config.florun not found." >&2
  echo "Create it first:" >&2
  echo "  cp $REPO_DIR/config.florun.example $BASE/config.florun" >&2
  echo "then edit it and re-run this script." >&2
  exit 1
fi
if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Install units for this webroot? [y/N] '
  read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) echo "Aborted; nothing was changed."; exit 1 ;; esac
fi

# ── config (parsed as DATA, never sourced) ───────────────────────────
cfg() { sed -n "s/^$1=//p" "$BASE/config.florun" | tail -1 | tr -d '\r'; }
APP_UID="$(cfg APP_UID)"
TUNNEL_UID="$(cfg TUNNEL_UID)"
STACK_NAME="$(cfg STACK_NAME)"
SUBPATH="$(cfg SUBPATH)"
CHECKOUT_DIR="$(cfg CHECKOUT_DIR)"

case "$APP_UID" in    *[!0-9]*|""|0) echo "FATAL: APP_UID must be a non-root numeric UID" >&2; exit 1 ;; esac
case "$TUNNEL_UID" in *[!0-9]*|""|0) echo "FATAL: TUNNEL_UID must be a non-root numeric UID" >&2; exit 1 ;; esac
case "$STACK_NAME" in *[!A-Za-z0-9_-]*|"") echo "FATAL: STACK_NAME must be non-empty, characters A-Za-z0-9_-" >&2; exit 1 ;; esac
case "$SUBPATH" in
  .) ;;
  *[!A-Za-z0-9._-]*|""|*..*) echo "FATAL: SUBPATH must be a plain path segment or '.'" >&2; exit 1 ;;
esac
case "$CHECKOUT_DIR" in *[!A-Za-z0-9._-]*|""|.|..|*..*) echo "FATAL: CHECKOUT_DIR must be a plain directory name" >&2; exit 1 ;; esac

# A UID with nowhere to land inside the user namespace cannot start. Refuse the
# install now rather than let it fail silently at 05:00.
USERNS_SIZE=65536
if [ "$APP_UID" -ge "$USERNS_SIZE" ] || [ "$TUNNEL_UID" -ge "$USERNS_SIZE" ]; then
  echo "FATAL: APP_UID and TUNNEL_UID must both be below the UserNS size ($USERNS_SIZE)." >&2
  echo "A UID above the mapping has nowhere to land and the container will not start." >&2
  exit 1
fi

# Subuid sizing: each container gets its own 65536 range, so this stack needs
# 131072 -- twice what a distro typically allocates. Warn (do not fail): the
# ranges may legitimately be managed elsewhere.
if [ -r /etc/subuid ]; then
  have="$(awk -F: -v u="$(id -un)" '$1==u {sum+=$3} END {print sum+0}' /etc/subuid)"
  need=$((USERNS_SIZE * 2))
  if [ "$have" -lt "$need" ]; then
    echo
    echo "WARNING: /etc/subuid grants $(id -un) $have subordinate UIDs; this stack wants $need"
    echo "         (2 containers x $USERNS_SIZE). If the containers fail to start, widen the"
    echo "         range in /etc/subuid AND /etc/subgid, then: podman system migrate"
  fi
fi

QUADLET_DIR="$HOME/.config/containers/systemd"
SYSTEMD_DIR="$HOME/.config/systemd/user"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$QUADLET_DIR" "$SYSTEMD_DIR" "$BIN_DIR"

# ── install units, interpolating what Quadlet cannot ─────────────────
# %h/florun is the placeholder the shipped units carry; rewrite it to the real
# webroot. Everything else comes straight from config.florun.
install_unit() {
  src="$1"; dest="$2"
  sed \
    -e "s|%h/florun|$BASE|g" \
    -e "s|^ContainerName=FloRun$|ContainerName=$STACK_NAME|" \
    -e "s|^ContainerName=cloudflared-tunnel-FloRun$|ContainerName=cloudflared-tunnel-$STACK_NAME|" \
    -e "s|^BuildArg=SUBPATH=.*$|BuildArg=SUBPATH=$SUBPATH|" \
    "$src" > "$dest.tmp"
  # UIDs are rewritten per-unit below, because website and tunnel differ.
  mv -f "$dest.tmp" "$dest"
  echo "  installed $dest"
}

install_unit "$SELF_DIR/quadlet/florun-backend.network"  "$QUADLET_DIR/florun-backend.network"
install_unit "$SELF_DIR/quadlet/florun-egress.network"   "$QUADLET_DIR/florun-egress.network"
install_unit "$SELF_DIR/quadlet/florun-website.build"    "$QUADLET_DIR/florun-website.build"

install_unit "$SELF_DIR/quadlet/florun-website.container" "$QUADLET_DIR/florun-website.container"
sed -i.bak -e "s|^User=.*$|User=$APP_UID|" -e "s|^Group=.*$|Group=$APP_UID|" \
  "$QUADLET_DIR/florun-website.container" && rm -f "$QUADLET_DIR/florun-website.container.bak"

install_unit "$SELF_DIR/quadlet/florun-cloudflared.container" "$QUADLET_DIR/florun-cloudflared.container"
sed -i.bak -e "s|^User=.*$|User=$TUNNEL_UID|" -e "s|^Group=.*$|Group=$TUNNEL_UID|" \
  "$QUADLET_DIR/florun-cloudflared.container" && rm -f "$QUADLET_DIR/florun-cloudflared.container.bak"

for u in florun-update.service florun-update.timer; do
  sed -e "s|%h/florun|$BASE|g" "$SELF_DIR/systemd/$u" > "$SYSTEMD_DIR/$u"
  echo "  installed $SYSTEMD_DIR/$u"
done

install -m 0755 "$SELF_DIR/bin/florun-update.sh" "$BIN_DIR/florun-update.sh"
echo "  installed $BIN_DIR/florun-update.sh"

systemctl --user daemon-reload
echo
echo "Units installed and systemd reloaded."

# ── next steps ───────────────────────────────────────────────────────
cat <<NEXT

Next steps
----------
1. Tunnel token (only if you have not created it yet). Use printf, NOT echo --
   a trailing newline is stored verbatim and cloudflared rejects it:

     printf '%s' 'YOUR-TUNNEL-TOKEN' | podman secret create florun-tunnel-token -

   Point the tunnel's ingress rule at:  http://website:8080

2. Keep the services running when you are not logged in:

     loginctl enable-linger $(id -un)

3. First deploy (assembles the webroot, builds the image, starts everything):

     systemctl --user start florun-update.service
     journalctl --user -u florun-update -f

4. Enable the daily refresh:

     systemctl --user enable --now florun-update.timer
     systemctl --user list-timers florun-update.timer

Verify the isolation actually holds -- nginx must have NO route off the host.
The positive control runs first, so a probe that never ran cannot be mistaken
for a blocked one:

  podman exec $STACK_NAME sh -c 'S=\$(date +%s); nc -z -w3 127.0.0.1 8080; A=\$?; M=\$(date +%s); nc -z -w3 1.1.1.1 443; B=\$?; E=\$(date +%s); echo "own-port(control): exit=\$A in \$((M-S))s | internet: exit=\$B in \$((E-M))s"'

  own-port exit=0 + internet exit=1  -> pass (no route; kernel refused)
  own-port exit=1                    -> void (nc missing; probe never ran)
  internet exit=0                    -> FAIL (nginx can reach the internet)

NEXT
