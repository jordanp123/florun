#!/bin/bash
# Installs the FloRun rootless-Podman deployment: quadlet units, the systemd
# timer and the updater. Safe to re-run -- after editing a unit, pulling a new
# version, or moving the checkout.
#
# It exists because Quadlet files are systemd units and systemd does NOT expand
# ${VAR}. This script reads config.florun once and writes the real UIDs, names,
# subpath and install path into the installed copies, so config.florun stays the
# single source of truth and nothing is ever hand-edited.
#
# On a first install (no config.florun yet) it runs an interactive setup that
# writes the file for you. Re-running it later never re-interrogates you: an
# existing config.florun is read and validated, not replaced.
set -eEu

usage() {
  cat <<'USAGE'
Usage: deploy/install.sh [--yes] [--base-dir PATH] [--reconfigure]

  --yes, -y         non-interactive: accept the detected directory and take the
                    default for every setting. Never prompts, never touches a
                    secret, never starts anything.
  --base-dir PATH   install directory to use (or set FLORUN_BASE=PATH)
  --reconfigure     re-run the interactive setup even though config.florun
                    already exists (the current values become the defaults)
  --help, -h        this message

By default this is the git checkout itself: config.florun, update.log and the
build context all live inside it, and nothing is written outside it.
USAGE
}

ASSUME_YES=0
RECONFIGURE=0
BASE_ARG="${FLORUN_BASE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    --base-dir) BASE_ARG="${2:-}"; shift 2 ;;
    --reconfigure) RECONFIGURE=1; shift ;;
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

# Interactive only when there is a terminal to talk to. Under systemd, cron or
# CI there is not, and a blocked prompt would hang the run forever.
INTERACTIVE=1
[ "$ASSUME_YES" -eq 1 ] && INTERACTIVE=0
[ -t 0 ] || INTERACTIVE=0

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"     # .../<checkout>/deploy
REPO_DIR="$(cd "$SELF_DIR/.." && pwd)"        # .../<checkout>

# ── prompt helpers ───────────────────────────────────────────────────

# ask VAR "Prompt" "default" [validator]
# Re-asks until the validator accepts. Non-interactive runs take the default
# without asking (and still validate it, so a bad default fails loudly).
ask() {
  local __var="$1" __prompt="$2" __default="$3" __validate="${4:-}"
  local __value
  while :; do
    if [ "$INTERACTIVE" -eq 0 ]; then
      __value="$__default"
    else
      printf '  %s [%s]: ' "$__prompt" "$__default" >&2
      IFS= read -r __value || __value=""
      [ -z "$__value" ] && __value="$__default"
    fi
    if [ -z "$__validate" ] || "$__validate" "$__value"; then
      printf -v "$__var" '%s' "$__value"
      return 0
    fi
    if [ "$INTERACTIVE" -eq 0 ]; then
      echo "FATAL: default value '$__value' for $__var is invalid." >&2
      exit 1
    fi
  done
}

# confirm "Question" default(y|n) -> returns 0 for yes
confirm() {
  local __prompt="$1" __default="${2:-n}" __reply __hint
  if [ "$__default" = "y" ]; then __hint="[Y/n]"; else __hint="[y/N]"; fi
  if [ "$INTERACTIVE" -eq 0 ]; then
    [ "$__default" = "y" ]
    return
  fi
  printf '  %s %s ' "$__prompt" "$__hint" >&2
  IFS= read -r __reply || __reply=""
  [ -z "$__reply" ] && __reply="$__default"
  case "$__reply" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

heading() { printf '\n\033[1m%s\033[0m\n' "$1" >&2; }
note()    { printf '  %s\n' "$1" >&2; }
bad()     { printf '  !! %s\n' "$1" >&2; }

# ── validators (same rules the updater enforces at 05:00) ────────────

v_stack() {
  case "$1" in
    "") bad "cannot be empty"; return 1 ;;
    *[!A-Za-z0-9_-]*) bad "only letters, digits, _ and - are allowed"; return 1 ;;
    *) return 0 ;;
  esac
}
v_subpath() {
  case "$1" in
    .) return 0 ;;
    "") bad "cannot be empty (use '.' to serve at the domain root)"; return 1 ;;
    *..*) bad "must not contain '..'"; return 1 ;;
    *[!A-Za-z0-9._-]*) bad "only letters, digits and . _ - are allowed"; return 1 ;;
    *) return 0 ;;
  esac
}
USERNS_SIZE=65536
v_uid() {
  case "$1" in
    ""|*[!0-9]*) bad "must be numeric"; return 1 ;;
    0) bad "must not be root (0)"; return 1 ;;
  esac
  # A UID at or above the namespace size has nowhere to map and the container
  # simply will not start. Catch it here, not at 05:00.
  if [ "$1" -ge "$USERNS_SIZE" ]; then
    bad "must be below the UserNS size ($USERNS_SIZE) or the container cannot start"
    return 1
  fi
  return 0
}

# ── locate the install directory ─────────────────────────────────────
# The checkout IS the install directory: config.florun, update.log and the
# podman build context all live inside it, and nothing is ever written outside
# it. Defaulting to the checkout's PARENT (as the WebSWR layout this was
# derived from does) meant that cloning into your home directory quietly made
# $HOME the webroot and scattered config, logs and a copy of the site through
# it. WebSWR needs that split because its webroot also holds data files fetched
# daily that are not in the repo; FloRun has no generated files, so the split
# bought nothing and cost a tidy server.

if [ -n "$BASE_ARG" ]; then
  BASE="$(cd "$BASE_ARG" 2>/dev/null && pwd)" || {
    echo "FATAL: --base-dir '$BASE_ARG' does not exist" >&2; exit 1; }
else
  BASE="$REPO_DIR"
fi

heading "FloRun installer"
note "Install directory: $BASE"
if [ "$BASE" != "$REPO_DIR" ]; then
  note "Checkout:          $REPO_DIR"
fi

if [ "$INTERACTIVE" -eq 1 ]; then
  confirm "Install here?" y || { echo "Aborted; nothing was changed." >&2; exit 1; }
fi

CONFIG="$BASE/config.florun"

# ── configuration ────────────────────────────────────────────────────

# Defaults come from an existing config when there is one, so --reconfigure
# offers your current values back rather than the stock ones.
#
# There is deliberately no REPO_URL or CHECKOUT_DIR here any more. Both only
# ever mattered for cloning the repo on a fresh server -- and you cannot reach
# this script without having cloned it already. The updater pulls from whatever
# remote the checkout has, which is the same answer with nothing to keep in
# sync. Config that is never read is config that eventually lies.
d_stack="FloRun"
d_app_uid="17011"
d_tunnel_uid="17010"
d_subpath="."

cfg_get() { sed -n "s/^$1=//p" "$CONFIG" 2>/dev/null | tail -1 | tr -d '\r'; }

if [ -f "$CONFIG" ]; then
  [ -n "$(cfg_get STACK_NAME)" ]   && d_stack="$(cfg_get STACK_NAME)"
  [ -n "$(cfg_get APP_UID)" ]      && d_app_uid="$(cfg_get APP_UID)"
  [ -n "$(cfg_get TUNNEL_UID)" ]   && d_tunnel_uid="$(cfg_get TUNNEL_UID)"
  [ -n "$(cfg_get SUBPATH)" ]      && d_subpath="$(cfg_get SUBPATH)"
fi

WRITE_CONFIG=0
if [ ! -f "$CONFIG" ]; then
  WRITE_CONFIG=1
  heading "Setting up config.florun"
  if [ "$INTERACTIVE" -eq 1 ]; then
    note "No config.florun yet, so let's create one."
    note "Press Enter to accept the value shown in brackets."
    note ""
  else
    note "No config.florun yet; writing one from the defaults (--yes)."
  fi
elif [ "$RECONFIGURE" -eq 1 ]; then
  WRITE_CONFIG=1
  heading "Reconfiguring config.florun"
  note "Current values are offered as the defaults."
  note ""
else
  heading "Using existing config.florun"
  note "$CONFIG"
  note "Re-run with --reconfigure to change these values interactively."
fi

if [ "$WRITE_CONFIG" -eq 1 ]; then
  ask STACK_NAME   "Stack name (container name prefix)" "$d_stack" v_stack
  ask APP_UID      "UID for the nginx container" "$d_app_uid"      v_uid

  # The tunnel UID is validated against the nginx one HERE rather than after
  # the remaining questions: being told about a clash only once you have
  # answered everything else, and then thrown back three prompts, is the kind
  # of thing that makes an installer feel broken.
  while :; do
    ask TUNNEL_UID "UID for the tunnel container" "$d_tunnel_uid" v_uid
    if [ "$TUNNEL_UID" != "$APP_UID" ]; then
      break
    fi
    # Distinct UIDs are the point: one compromised container must not be able
    # to touch the other's processes.
    bad "must differ from the nginx UID ($APP_UID), so neither container can"
    bad "touch the other's processes"
    if [ "$INTERACTIVE" -eq 0 ]; then
      echo "FATAL: APP_UID and TUNNEL_UID must differ." >&2
      exit 1
    fi
  done

  # Asked as a yes/no rather than "type a path, or '.' for the root".
  # The old free-text prompt invited typing the app's name -- which is a
  # perfectly reasonable thing to type, and silently wrong on a dedicated
  # subdomain: the files land in /florun/ and the domain root serves nginx's
  # stock welcome page instead. The common case is now one keypress.
  if [ "$d_subpath" = "." ]; then subpath_default=y; else subpath_default=n; fi
  if confirm "Serve at the domain root? (yes for a dedicated subdomain, e.g. florun.example.com)" "$subpath_default"; then
    SUBPATH="."
  else
    note "The site will be served under https://your.domain/<subpath>/"
    if [ "$d_subpath" = "." ]; then subpath_hint="florun"; else subpath_hint="$d_subpath"; fi
    ask SUBPATH "URL path segment" "$subpath_hint" v_subpath
  fi

  # Written fresh rather than sed-patched, so the file always matches what this
  # version of the installer understands. 0600: it holds no secrets, but it
  # describes the host's layout and there is no reason for siblings to read it.
  umask 077
  cat > "$CONFIG" <<CONFIGEOF
# FloRun deployment configuration.
# Generated by deploy/install.sh on $(date -u +%FT%TZ).
#
# Lives in the install directory alongside the checkout, and is gitignored, so
# a pull can never overwrite it. Plain KEY=value, no spaces around '=', no
# quotes. The updater parses this as DATA (it is never executed) and validates
# every value before touching anything. Holds NO secrets: the Cloudflare tunnel
# token lives in a podman secret. Re-run 'deploy/install.sh --reconfigure' to
# change these values.

APP_UID=$APP_UID
TUNNEL_UID=$TUNNEL_UID
STACK_NAME=$STACK_NAME
SUBPATH=$SUBPATH
CONFIGEOF
  umask 022
  note ""
  note "Wrote $CONFIG"
else
  STACK_NAME="$d_stack"
  APP_UID="$d_app_uid"; TUNNEL_UID="$d_tunnel_uid"; SUBPATH="$d_subpath"
fi

# Validate whatever we ended up with -- an existing hand-edited config gets the
# same scrutiny as a freshly generated one.
v_stack    "$STACK_NAME" || { echo "FATAL: bad STACK_NAME in $CONFIG" >&2; exit 1; }
v_subpath  "$SUBPATH" || { echo "FATAL: bad SUBPATH in $CONFIG" >&2; exit 1; }
v_uid      "$APP_UID" || { echo "FATAL: bad APP_UID in $CONFIG" >&2; exit 1; }
v_uid      "$TUNNEL_UID" || { echo "FATAL: bad TUNNEL_UID in $CONFIG" >&2; exit 1; }
[ "$APP_UID" != "$TUNNEL_UID" ] || { echo "FATAL: APP_UID and TUNNEL_UID must differ" >&2; exit 1; }

# Subuid sizing: each container gets its own 65536 range, so this stack needs
# 131072 -- twice what a distro typically allocates. Warn (do not fail): the
# ranges may legitimately be managed elsewhere.
if [ -r /etc/subuid ]; then
  have="$(awk -F: -v u="$(id -un)" '$1==u {sum+=$3} END {print sum+0}' /etc/subuid)"
  need=$((USERNS_SIZE * 2))
  if [ "$have" -lt "$need" ]; then
    heading "Warning: subordinate UID range looks too small"
    note "/etc/subuid grants $(id -un) $have subordinate UIDs; this stack wants $need"
    note "(2 containers x $USERNS_SIZE). If the containers fail to start, widen the"
    note "range in /etc/subuid AND /etc/subgid, then: podman system migrate"
  fi
fi

# ── tunnel token ─────────────────────────────────────────────────────
# Offered here because the updater refuses to run without it, and because the
# token has one specific trap: a trailing newline is stored verbatim and
# cloudflared then rejects it with a confusing auth error. Reading with -r -s
# and piping through printf avoids that, keeps the token off the screen, and
# keeps it out of shell history and out of every file in the deployment.

secret_exists() {
  podman secret exists florun-tunnel-token 2>/dev/null && return 0
  podman secret inspect florun-tunnel-token >/dev/null 2>&1
}

if command -v podman >/dev/null 2>&1; then
  heading "Cloudflare tunnel token"
  if secret_exists; then
    note "podman secret 'florun-tunnel-token' already exists -- leaving it alone."
    note "To rotate it:  podman secret rm florun-tunnel-token && re-run this script"
  elif [ "$INTERACTIVE" -eq 1 ]; then
    note "Stored as a podman secret, never in a file, this repo or your shell history."
    note "Create one in the Cloudflare Zero Trust dashboard, then route the hostname"
    note "to  http://website:8080"
    note ""
    if confirm "Enter the tunnel token now?" y; then
      while :; do
        printf '  Token (input hidden): ' >&2
        IFS= read -rs FLORUN_TOKEN || FLORUN_TOKEN=""
        printf '\n' >&2
        if [ -z "$FLORUN_TOKEN" ]; then
          bad "Nothing entered."
          confirm "Try again?" y || break
          continue
        fi
        # printf, never echo: no trailing newline may reach the secret.
        if printf '%s' "$FLORUN_TOKEN" | podman secret create florun-tunnel-token - >/dev/null 2>&1; then
          note "Secret 'florun-tunnel-token' created."
          break
        fi
        bad "podman could not create the secret."
        confirm "Try again?" n || break
      done
      unset FLORUN_TOKEN
    else
      note "Skipped. Create it before the first deploy with:"
      note "  printf '%s' 'YOUR-TOKEN' | podman secret create florun-tunnel-token -"
    fi
  else
    note "Not set. Create it before the first deploy with:"
    note "  printf '%s' 'YOUR-TOKEN' | podman secret create florun-tunnel-token -"
  fi
else
  heading "Warning: podman not found"
  note "The units install fine, but nothing can run until podman is available."
fi

# ── install units, interpolating what Quadlet cannot ─────────────────

QUADLET_DIR="$HOME/.config/containers/systemd"
SYSTEMD_DIR="$HOME/.config/systemd/user"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$QUADLET_DIR" "$SYSTEMD_DIR" "$BIN_DIR"

heading "Installing units"

# %h/florun is the placeholder the shipped units carry; rewrite it to the real
# install directory. Everything else comes straight from the config above.
install_unit() {
  local src="$1" dest="$2"
  sed \
    -e "s|%h/florun|$BASE|g" \
    -e "s|^ContainerName=FloRun$|ContainerName=$STACK_NAME|" \
    -e "s|^ContainerName=cloudflared-tunnel-FloRun$|ContainerName=cloudflared-tunnel-$STACK_NAME|" \
    -e "s|^BuildArg=SUBPATH=.*$|BuildArg=SUBPATH=$SUBPATH|" \
    "$src" > "$dest.tmp"
  mv -f "$dest.tmp" "$dest"
  note "installed $dest"
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
  note "installed $SYSTEMD_DIR/$u"
done

install -m 0755 "$SELF_DIR/bin/florun-update.sh" "$BIN_DIR/florun-update.sh"
note "installed $BIN_DIR/florun-update.sh"

systemctl --user daemon-reload
note "systemd reloaded"

# ── optional finishing steps ─────────────────────────────────────────
# Each is offered rather than assumed: they change system state beyond dropping
# files in place, and someone re-running the installer to pick up an edited
# unit should not have a deploy kicked off underneath them.

LINGER_DONE=0
FIRST_RUN_DONE=0
TIMER_DONE=0

if [ "$INTERACTIVE" -eq 1 ]; then
  heading "Finishing up"

  if command -v loginctl >/dev/null 2>&1; then
    if loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
      note "Lingering already enabled."
      LINGER_DONE=1
    elif confirm "Enable lingering so the services run when you are not logged in?" y; then
      if loginctl enable-linger "$(id -un)" 2>/dev/null; then
        note "Lingering enabled."; LINGER_DONE=1
      else
        bad "Could not enable lingering (it may need sudo):"
        bad "  sudo loginctl enable-linger $(id -un)"
      fi
    fi
  fi

  if secret_exists; then
    if confirm "Run the first deploy now (pull, build the image, start everything)?" n; then
      note "Running florun-update.service -- this builds a container image and may take a few minutes."
      if systemctl --user start florun-update.service; then
        note "First deploy finished. Check it with:  journalctl --user -u florun-update -n 40"
        FIRST_RUN_DONE=1
      else
        bad "The first deploy failed. Inspect it with:"
        bad "  journalctl --user -u florun-update -n 60 --no-pager"
      fi
    fi
  else
    note "Skipping the first-deploy offer: the tunnel token secret is not set yet."
  fi

  if confirm "Enable the daily update timer (05:00 with jitter)?" y; then
    if systemctl --user enable --now florun-update.timer >/dev/null 2>&1; then
      note "Timer enabled."; TIMER_DONE=1
    else
      bad "Could not enable the timer; do it manually:"
      bad "  systemctl --user enable --now florun-update.timer"
    fi
  fi
fi

# ── what is left to do ───────────────────────────────────────────────

heading "Done"
remaining=0
if ! secret_exists 2>/dev/null; then
  remaining=$((remaining + 1))
  note "$remaining. Create the tunnel token secret (printf, NOT echo -- a trailing"
  note "   newline is stored verbatim and cloudflared rejects it):"
  note "     printf '%s' 'YOUR-TOKEN' | podman secret create florun-tunnel-token -"
  note "   Point the tunnel's ingress rule at:  http://website:8080"
fi
if [ "$LINGER_DONE" -eq 0 ]; then
  remaining=$((remaining + 1))
  note "$remaining. Keep the services running when you are not logged in:"
  note "     loginctl enable-linger $(id -un)"
fi
if [ "$FIRST_RUN_DONE" -eq 0 ]; then
  remaining=$((remaining + 1))
  note "$remaining. First deploy (pull, build the image, start everything):"
  note "     systemctl --user start florun-update.service"
  note "     journalctl --user -u florun-update -f"
fi
if [ "$TIMER_DONE" -eq 0 ]; then
  remaining=$((remaining + 1))
  note "$remaining. Enable the daily refresh:"
  note "     systemctl --user enable --now florun-update.timer"
fi
[ "$remaining" -eq 0 ] && note "Everything is installed, configured and running."

cat >&2 <<NEXT

Verify the isolation actually holds -- nginx must have NO route off the host.
The positive control runs first, so a probe that never ran cannot be mistaken
for a blocked one:

  podman exec $STACK_NAME sh -c 'S=\$(date +%s); nc -z -w3 127.0.0.1 8080; A=\$?; M=\$(date +%s); nc -z -w3 1.1.1.1 443; B=\$?; E=\$(date +%s); echo "own-port(control): exit=\$A in \$((M-S))s | internet: exit=\$B in \$((E-M))s"'

  own-port exit=0 + internet exit=1  -> pass (no route; kernel refused)
  own-port exit=1                    -> void (nc missing; probe never ran)
  internet exit=0                    -> FAIL (nginx can reach the internet)

NEXT
