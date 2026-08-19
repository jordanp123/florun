# FloRun — rootless Podman deployment

Everything needed to run FloRun under **rootless Podman** with systemd
[Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
units: containers become real user services with boot ordering,
restart-on-failure, journald logs and a daily auto-update timer. `install.sh`
does the wiring.

**Why rootless:** the container hardening (read-only rootfs, all capabilities
dropped, no-new-privileges, non-root user, internal-only network for nginx) is
achievable either way. The gain is that no root-owned daemon sits in the path
and **the daily update job does not run as root** — so a compromise of the git
remote lands as one unprivileged user instead of root. This stack is an easy
rootless fit because it **publishes no ports** (the tunnel dials out), so there
is no bind-below-1024 problem.

Requires **Podman 5+** and cgroups v2.

## Architecture

```
                    Cloudflare edge
                          │  (tunnel dials OUT; nothing is published)
                 ┌────────┴────────┐
                 │  cloudflared    │  florun-egress  ──► internet
                 │  (uid 17010)    │
                 └────────┬────────┘
                          │  florun-backend (Internal=true)
                 ┌────────┴────────┐
                 │  nginx :8080    │  NO route off the host, at all
                 │  (uid 17011)    │
                 └─────────────────┘
```

nginx serves static files and nothing else. It has no reason to reach the
internet, so it is placed on a network that cannot — which for an app that
handles location and photos is worth having even though the app itself makes
zero network requests.

### User namespaces and `/etc/subuid`

Both containers carry `UserNS=auto:size=65536`, so Podman gives **each one its
own private, non-overlapping range of host UIDs**. A process escaping one lands
in a namespace that does not overlap the other — or any other stack's on the
host.

That costs subuids: **containers × size**, i.e. `2 × 65536 = 131072` — *twice*
the 65536 a distro typically allocates. Check what the deploy account has:

```sh
grep "^$USER:" /etc/subuid /etc/subgid
```

If it is short, the containers simply fail to start. Widen the range in both
files, then:

```sh
podman system migrate                 # re-map existing containers
systemctl --user daemon-reload
systemctl --user restart florun-website.service florun-cloudflared.service
```

`install.sh` warns if the range looks too small, and **refuses** the install if
`APP_UID`/`TUNNEL_UID` are not below `size=` (a UID with nowhere to land cannot
start — better to fail now than at 05:00).

## Layout

```
deploy/
  install.sh                     installs + wires everything (run this)
  quadlet/                       -> ~/.config/containers/systemd/
    florun-backend.network         internal-only network (nginx: no egress)
    florun-egress.network          outbound network (tunnel only)
    florun-website.build           builds the site image from the webroot
    florun-website.container       nginx service
    florun-cloudflared.container   tunnel service
  systemd/                       -> ~/.config/systemd/user/
    florun-update.service          the daily refresh
    florun-update.timer            05:00 + up to 15m jitter, catches up if missed
  bin/
    florun-update.sh             -> ~/.local/bin/
```

Units are prefixed `florun-` because Quadlet units are flat and per-user —
generic names would collide with another project's units on the same host.

## Install

```sh
# The webroot holds config.florun and (after the first update) the assembled
# site. The git checkout lives inside it.
mkdir -p ~/florun && cd ~/florun
git clone https://github.com/jordanp123/florun.git FloRunWeb
./FloRunWeb/deploy/install.sh
```

That is the whole install. There is no config file to copy and edit first —
`install.sh` asks for the values it needs and writes `config.florun` for you:

```
FloRun installer
  Webroot:  /home/florun/florun
  Checkout: /home/florun/florun/FloRunWeb
  Install for this webroot? [Y/n]

Setting up config.florun
  No config.florun yet, so let's create one.
  Press Enter to accept the value shown in brackets.

  Git repository URL [https://github.com/jordanp123/florun.git]:
  Checkout directory name (under the webroot) [FloRunWeb]:
  Stack name (container name prefix) [FloRun]:
  UID for the nginx container [17011]:
  UID for the tunnel container [17010]:
  URL subpath, or '.' for the domain root [.]:
```

Every answer is validated as you type it, with the same rules the updater
enforces at 05:00 — a non-numeric UID, a root UID, a UID at or above the user
namespace size, a subpath containing `..`, two containers sharing a UID. Bad
input is rejected on the spot with the reason and re-asked, rather than
accepted and blowing up on a morning you are not watching.

It then offers the finishing steps, each as a separate question so nothing
happens behind your back:

- **the tunnel token** — read with the terminal echo off, and piped to
  `podman secret create` through `printf` so no trailing newline can reach it.
  It never touches a file, this repo, or your shell history.
- **lingering**, so the services keep running when you log out
- **the first deploy** (only offered once the token secret exists)
- **the daily update timer**

Decline any of them and the closing summary lists exactly what is left, with
the command to run.

`install.sh` is safe to re-run — after editing a unit, pulling a new version, or
moving the webroot. A second run does **not** re-interrogate you: an existing
`config.florun` is read and validated, not replaced.

| Flag | Effect |
| --- | --- |
| `--yes`, `-y` | Non-interactive: accept the detected webroot, take every default, never prompt, never touch a secret, never start anything. |
| `--reconfigure` | Re-run the questions even though `config.florun` exists; your current values become the defaults. |
| `--base-dir PATH` | Install for a webroot other than the checkout's parent (or set `FLORUN_BASE=PATH`). |
| `--help`, `-h` | Usage. |

It also drops to non-interactive automatically when stdin is not a terminal, so
running it from a script, CI or a systemd unit can never hang on a prompt.

`config.florun.example` is still shipped as the annotated reference for what
each value means, and you can copy and edit it by hand if you prefer — the
installer will use it as-is and skip its own questions.

**It does the interpolation Quadlet can't.** Quadlet files are systemd units, so
they don't expand `${VAR}`. `install.sh` reads your `config.florun` once and
writes `APP_UID`, `TUNNEL_UID`, `STACK_NAME` and `SUBPATH` into the installed
units, plus rewrites the `%h/florun` placeholder to your real webroot.
`config.florun` stays the single source of truth; nothing is hand-edited.

## The daily refresh

`bin/florun-update.sh` pulls, reassembles the webroot, rebuilds the image with
`--pull` (so the nginx base keeps getting CVE fixes), restarts the units, and
prunes. Order is the failsafe: nothing is stopped until the new image is built,
and **a rollout that fails to come up is rolled back to the previous image**
automatically.

It refuses to run as root, parses `config.florun` as data (never sources it),
validates every value before touching anything, and appends a start banner, an
`OK`/`ABORTED` line with exit code, and the deployed commit + image id to a
size-rotated `update.log` in the webroot (mode 0600).

```sh
systemctl --user start florun-update.service      # run it now
journalctl --user -u florun-update -f             # watch
systemctl --user list-timers florun-update.timer  # when is it next due?
```

Run it directly with `FLORUN_BASE=/path/to/webroot ~/.local/bin/florun-update.sh`
if your webroot is not `~/florun` (the timer needs nothing extra — the unit
carries the path).

## The tunnel token

The units read a **podman secret**, injected as `TUNNEL_TOKEN` at container
start — the variable cloudflared already reads.

```sh
printf '%s' 'YOUR-TOKEN' | podman secret create florun-tunnel-token -
```

Always `printf '%s'`, never `echo`: a trailing newline is stored verbatim and
cloudflared rejects the token with a confusing auth error.

What this buys, stated honestly: the token **leaves the deploy directory** — it
is not in the webroot, the build context, a backup of either, or any unit file.
Rotation and inventory become managed operations. What it does **not** buy:
podman's default secret driver stores secrets base64-encoded in the user's
container storage — **not encrypted**. Anyone who can read that user's files (or
is root) can recover it. This is better scoping and hygiene, not encryption at
rest. For real at-rest protection, point podman at an external driver.

**Rotation** — after issuing a new token in the Cloudflare dashboard:

```sh
podman secret rm florun-tunnel-token
printf '%s' 'NEW-TOKEN' | podman secret create florun-tunnel-token -
systemctl --user restart florun-cloudflared.service
```

## Verifying the isolation actually holds

The central claim is that **nginx has no route off the host**. That is worth
proving rather than assuming, especially after a host or Podman upgrade.

A bare "did it fail?" check is not enough: a probe that never ran produces the
same non-zero exit as a blocked one. So this runs a **positive control first**
(the container's own port, which must succeed) and reports elapsed seconds for
both. It targets a raw IP so DNS failure cannot masquerade as a routing failure.

```sh
podman exec FloRun sh -c 'S=$(date +%s); nc -z -w3 127.0.0.1 8080; A=$?; M=$(date +%s); nc -z -w3 1.1.1.1 443; B=$?; E=$(date +%s); echo "own-port(control): exit=$A in $((M-S))s | internet: exit=$B in $((E-M))s"'

# ...while the site itself keeps serving through the tunnel:
curl -sI https://your.domain/ | head -1
```

| own-port (control) | internet | verdict |
| --- | --- | --- |
| `exit=0` | `exit=1` in 0s | **Pass, strongest form** — no route exists, the kernel refused immediately (`ENETUNREACH`) and no packet was sent |
| `exit=0` | `exit=1` in ~3s | **Pass** — packets were emitted and silently dropped downstream |
| `exit=1` | anything | **Void** — `nc` is missing or `-z` unsupported; the probe never ran |
| anything | `exit=0` | **Fail** — nginx has a route off the host |

For proof by configuration rather than by probe, `podman exec FloRun ip route`
should show **no `default` line** at all.

A few more one-liners for the same reason:

```sh
podman inspect FloRun --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}'
podman top FloRun huser user            # host UID vs in-container UID (UserNS mapping)
podman secret ls                        # the token exists and is dated
systemctl --user list-timers florun-update.timer
```

**Host hygiene** for a machine running several service accounts: keep the deploy
account's home unreadable by its siblings (`chmod 750 /home/florun`); the
updater already writes `update.log` owner-only for the same reason.

## PWA-specific notes

FloRun is a Progressive Web App, which adds two serving requirements the
`nginx.conf` handles and which are easy to break by "tidying":

- **`/manifest.webmanifest` must be `application/manifest+json`.** Stock nginx
  `mime.types` has no entry for `.webmanifest` and falls back to
  `application/octet-stream`, which browsers refuse to parse — the app then
  silently stops being installable.
- **`/sw.js` must not be cached and must be served from the root.** A service
  worker's scope is capped by its own path, so serving it from the root is what
  lets it control the whole origin. A cached service worker is the classic way a
  PWA strands every user on an old build.

Two related traps:

- A location-level `add_header` **replaces** the inherited set rather than adding
  to it. The `/sw.js` block therefore repeats every server-level security header
  verbatim. `tests/deploy_check.py` fails the build if one is missing.
- `sw.js` carries a `CACHE = "florun-vN"` constant. **Bump it whenever any
  precached asset changes** — it is the only thing that triggers a client
  refresh. `tests/run.sh` checks it exists and is well formed, and
  `deploy_check.py` verifies every precached path actually exists and matches
  what `index.html` loads (an atomic `cache.addAll` means one 404 fails the whole
  install and no update ever lands).

## Gotchas

- **Tunnel DNS name.** `florun-website.container` sets `NetworkAlias=website`,
  so point your tunnel's ingress rule at `http://website:8080` regardless of what
  you set `STACK_NAME` to.
- **Rootless `--cpus`** needs cgroups v2 CPU delegation. If the container fails
  to start citing cgroups, drop `--cpus=1` from `PodmanArgs=`; the memory and
  pids limits work regardless.
- **`AutoUpdate=registry`** on the tunnel only marks it eligible for `podman
  auto-update`. `florun-update.timer` doesn't run that — the updater pulls the
  tunnel image explicitly every night. To cover *every* container on the host,
  also enable podman's own timer (it ships disabled):
  `systemctl --user enable --now podman-auto-update.timer`.
- **The `.build` unit** exists so a cold `systemctl --user start
  florun-website.service` works without a manual build. The updater rebuilds the
  same tag with `--pull` each morning, which is what keeps the nginx base patched.
- **SELinux** (Fedora/RHEL): these units mount no host volumes, so the usual
  `:z`/`:Z` relabeling issue does not arise.
- **Serving from a subpath** instead of a subdomain: set `SUBPATH=florun` in
  `config.florun` and point the tunnel route at the matching path. The app uses
  relative URLs throughout and needs no other change, but the service worker's
  scope narrows to that subpath accordingly.
