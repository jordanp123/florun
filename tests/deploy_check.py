#!/usr/bin/env python3
"""
deploy_check.py -- deployment invariants.

WebSWR keeps two deployments honest with a parity test. FloRun ships only the
Podman path, so instead this asserts the properties that make that deployment
what it claims to be, and the couplings that are easy to break silently:

  * nginx genuinely has no route off the host (internal network, joined alone)
  * the hardening flags are actually present on both containers
  * the service-worker precache list matches the files that exist AND the
    scripts index.html loads -- a precache 404 makes install fail atomically,
    which would strand every user on the previous build
  * the /sw.js nginx location repeats every server-level security header,
    because a location-level add_header REPLACES the inherited set
  * the Dockerfile ships everything the precache expects

Exits non-zero with a readable list of failures. No dependencies.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

failures = []
checks = 0


def check(label, ok, detail=""):
    global checks
    checks += 1
    if not ok:
        failures.append(label + (": " + detail if detail else ""))


def read(*parts):
    path = os.path.join(ROOT, *parts)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


# ── files exist ──────────────────────────────────────────────────────

REQUIRED = [
    "index.html", "manifest.webmanifest", "sw.js", "Dockerfile", "nginx.conf",
    ".dockerignore", "config.florun.example",
    "deploy/install.sh", "deploy/bin/florun-update.sh",
    "deploy/quadlet/florun-backend.network",
    "deploy/quadlet/florun-egress.network",
    "deploy/quadlet/florun-website.build",
    "deploy/quadlet/florun-website.container",
    "deploy/quadlet/florun-cloudflared.container",
    "deploy/systemd/florun-update.service",
    "deploy/systemd/florun-update.timer",
]
for rel in REQUIRED:
    check("required file present: " + rel, read(*rel.split("/")) is not None)

website = read("deploy", "quadlet", "florun-website.container") or ""
tunnel = read("deploy", "quadlet", "florun-cloudflared.container") or ""
backend = read("deploy", "quadlet", "florun-backend.network") or ""
egress = read("deploy", "quadlet", "florun-egress.network") or ""
build = read("deploy", "quadlet", "florun-website.build") or ""
nginx = read("nginx.conf") or ""
dockerfile = read("Dockerfile") or ""
swjs = read("sw.js") or ""
html = read("index.html") or ""
example = read("config.florun.example") or ""
updater = read("deploy", "bin", "florun-update.sh") or ""

# ── isolation: nginx must have no way out ────────────────────────────

check("backend network is internal", "Internal=true" in backend)
check("egress network is NOT internal", "Internal=true" not in egress)
check("website joins the backend network", "Network=florun-backend.network" in website)
check("website does NOT join egress (this is the whole isolation claim)",
      "florun-egress" not in website)
check("tunnel joins backend", "Network=florun-backend.network" in tunnel)
check("tunnel joins egress", "Network=florun-egress.network" in tunnel)

# No published ports anywhere: the tunnel dials out, nothing listens publicly.
for name, text in (("website", website), ("tunnel", tunnel)):
    check(name + " publishes no ports",
          "PublishPort" not in text and "-p " not in text)

# ── hardening, both containers ───────────────────────────────────────

for name, text in (("website", website), ("tunnel", tunnel)):
    check(name + " read-only rootfs", "ReadOnly=true" in text)
    check(name + " no-new-privileges", "NoNewPrivileges=true" in text)
    check(name + " drops all capabilities", "DropCapability=ALL" in text)
    check(name + " uses a private user namespace", "UserNS=auto:size=" in text)
    check(name + " runs as a non-root user",
          bool(re.search(r"^User=[1-9]\d*$", text, re.M)))
    check(name + " has a memory limit", "--memory=" in text)
    check(name + " has a pids limit", "--pids-limit=" in text)

# The read-only rootfs means nginx needs tmpfs for everything it writes.
for path in ("/tmp", "/run", "/var/cache/nginx"):
    check("website has tmpfs for " + path, "Tmpfs=" + path + ":" in website)

# The tunnel token must come from a podman secret, never a file or a literal.
check("tunnel token comes from a podman secret",
      "Secret=florun-tunnel-token,type=env,target=TUNNEL_TOKEN" in tunnel)
check("no tunnel token literal in any unit",
      "TUNNEL_TOKEN=" not in website and
      not re.search(r"Environment=.*TUNNEL_TOKEN=\S", tunnel))

# Distinct UIDs: one compromised container must not be able to touch the other.
app_uid = re.search(r"^APP_UID=(\d+)$", example, re.M)
tun_uid = re.search(r"^TUNNEL_UID=(\d+)$", example, re.M)
check("config example sets APP_UID", app_uid is not None)
check("config example sets TUNNEL_UID", tun_uid is not None)
if app_uid and tun_uid:
    a, t = int(app_uid.group(1)), int(tun_uid.group(1))
    check("APP_UID and TUNNEL_UID differ", a != t, "%d vs %d" % (a, t))
    check("APP_UID is not root", a != 0)
    check("TUNNEL_UID is not root", t != 0)
    # A UID at or above the namespace size has nowhere to map and cannot start.
    size = re.search(r"UserNS=auto:size=(\d+)", website)
    if size:
        limit = int(size.group(1))
        check("APP_UID below the UserNS size", a < limit, "%d >= %d" % (a, limit))
        check("TUNNEL_UID below the UserNS size", t < limit, "%d >= %d" % (t, limit))

# ── updater safety ───────────────────────────────────────────────────

installer = read("deploy", "install.sh") or ""

# The installer is interactive on a first run, which brings its own hazards:
# a prompt that blocks forever under systemd, or a token that lands somewhere
# it should not.
check("installer refuses to run as root", "not root" in installer)
check("installer has a non-interactive path", "--yes" in installer and "ASSUME_YES" in installer)
check("installer drops to non-interactive without a TTY (never hangs on a prompt)",
      "[ -t 0 ]" in installer)
check("installer never overwrites an existing config unless asked",
      "--reconfigure" in installer and 'if [ ! -f "$CONFIG" ]' in installer)
# Token handling: silent read, printf (never echo, which appends a newline that
# cloudflared rejects), and never written to a file.
check("installer reads the token with echo off", "read -rs" in installer)
check("installer pipes the token through printf, not echo",
      "printf '%s' \"$FLORUN_TOKEN\" | podman secret create" in installer)
check("installer clears the token variable afterwards", "unset FLORUN_TOKEN" in installer)
check("installer never writes the token to a file",
      not re.search(r"FLORUN_TOKEN\"?\s*>", installer))
check("installer validates UIDs against the UserNS size",
      "USERNS_SIZE" in installer and "must be below the UserNS size" in installer)
check("installer rejects identical container UIDs",
      "must differ from the nginx UID" in installer)
check("generated config is written owner-only", "umask 077" in installer)

check("updater refuses to run as root", 'id -u' in updater and "must not run as root" in updater)
check("updater parses config as data, never sources it",
      "sed -n" in updater and not re.search(r"^\s*(\.|source)\s+\S*config\.florun", updater, re.M))
check("updater validates SUBPATH", "SUBPATH must be a plain path segment" in updater)
# The install directory IS the checkout: nothing may be written outside it, and
# the updater must never try to assemble a separate webroot (which, when the two
# are the same directory, would delete the checkout's own tracked files).
check("updater builds from the checkout, not a separate webroot",
      'CHECKOUT="$BASE"' in updater)
check("updater does not rm the site directories (would delete tracked files)",
      not re.search(r'rm -rf "\$BASE/(css|js|icons)"', updater))
check("updater no longer clones (the checkout must already exist)",
      "git clone" not in updater)
check("updater requires the install dir to be a git checkout",
      "is not a git checkout" in updater)
check("updater pulls fast-forward only", "pull --ff-only" in updater)
# is-active proves the process started; only a content probe proves the right
# thing is being served. This is what turns a wrong SUBPATH from a silently
# broken site into a failed, rolled-back deploy.
check("updater smoke-tests the served page", "SMOKE TEST FAILED" in updater)
# The 077 that keeps update.log owner-only must not survive into podman build:
# buildah applies the process umask to files it creates during COPY, which can
# leave the web root unreadable by the container's unprivileged UID (403).
# Anchored at line start: the explanatory comment above also contains the
# words "podman build", and a naive .index() finds that instead.
_umask = re.search(r"^umask 022$", updater, re.M)
_build = re.search(r"^podman build\b", updater, re.M)
check("updater restores umask 022 before building",
      bool(_umask and _build and _umask.start() < _build.start()))
check("updater probes the configured subpath",
      'PROBE="/$SUBPATH/"' in updater)
check("updater reports an un-runnable probe as skipped, not passed",
      "smoke test SKIPPED" in updater)
check("updater rolls back a failed smoke test",
      updater.count("Rolling back to the previous image") >= 1 or
      updater.count("rolling back to the previous image") >= 2)
# The subpath question is a yes/no so the common case cannot be fumbled into a
# subdirectory by typing the app's name.
check("installer asks about the domain root as a yes/no",
      "Serve at the domain root?" in installer)
check("config example carries no dead REPO_URL/CHECKOUT_DIR keys",
      not re.search(r"^REPO_URL=", example, re.M) and
      not re.search(r"^CHECKOUT_DIR=", example, re.M))
check("installer defaults the install dir to the checkout",
      'BASE="$REPO_DIR"' in installer)
check("updater rolls back a failed rollout", "rolling back to the previous image" in updater)
check("updater pulls the base image (CVE freshness)", "--pull" in updater)
check("updater prunes only after the new container is up",
      updater.index("podman system prune") > updater.index("is-active"))
check("updater rotates its own log", "update.log.1" in updater or 'mv -f "$LOG"' in updater)

# ── service worker precache ──────────────────────────────────────────

precache = re.search(r"const PRECACHE = \[(.*?)\];", swjs, re.S)
check("sw.js declares a precache list", precache is not None)
check("sw.js has a versioned cache name",
      bool(re.search(r'CACHE\s*=\s*"florun-v\d+"', swjs)))

if precache:
    entries = re.findall(r'"([^"]+)"', precache.group(1))
    # Every precached asset must exist: cache.addAll is atomic, so one 404
    # fails the whole install and no update ever lands.
    for entry in entries:
        if entry in ("./",):
            continue
        check("precached asset exists on disk: " + entry,
              os.path.exists(os.path.join(ROOT, entry)))

    # Every script index.html loads must be precached, or the app breaks
    # offline in a way that only shows up in the field.
    for src in re.findall(r'<script src="([^"]+)"', html):
        check("index.html script is precached: " + src, src in entries)

    # And everything precached must actually ship in the image.
    for entry in entries:
        if entry in ("./", "index.html", "manifest.webmanifest", "sw.js"):
            continue
        top = entry.split("/")[0]
        check("Dockerfile ships " + top + "/ (for " + entry + ")",
              top + "/" in dockerfile)

check("Dockerfile copies index.html", "index.html" in dockerfile)
check("Dockerfile copies the manifest", "manifest.webmanifest" in dockerfile)
check("Dockerfile copies the service worker", "sw.js" in dockerfile)
check("Dockerfile copies nginx.conf", "nginx.conf" in dockerfile)
# COPY-only, no RUN. A RUN step added here to delete the base image's stock
# welcome page broke the deployed image, and every other stack on this host
# builds with COPY alone. The smoke test in the updater covers what that RUN
# was for, and covers strictly more of it.
check("Dockerfile has no RUN step",
      not re.search(r"^\s*RUN\b", dockerfile, re.M))
check("Dockerfile does not switch to USER root",
      not re.search(r"^\s*USER\s+root\b", dockerfile, re.M))

# ── nginx ────────────────────────────────────────────────────────────

check("nginx listens on 8080 (unprivileged)", "listen 8080;" in nginx)
check("nginx allows only GET and HEAD", "if ($request_method !~ ^(GET|HEAD)$)" in nginx)
check("nginx disables absolute redirects", "absolute_redirect off;" in nginx)
check("nginx resolves index inline (no trailing-slash redirect loop)",
      "try_files $uri $uri/index.html" in nginx)
check("nginx hides its version", "server_tokens off;" in nginx)
check("nginx blocks dotfiles", re.search(r"location ~ /\\\.", nginx) is not None)
check("manifest is served as application/manifest+json",
      "application/manifest+json" in nginx)
check("service worker is uncacheable", 'add_header Cache-Control "no-cache"' in nginx)
check("Service-Worker-Allowed is set", "Service-Worker-Allowed" in nginx)

# The trap this exists for: a location-level add_header REPLACES the inherited
# set. Every security header on the server block must be repeated inside the
# /sw.js location, or the most sensitive file in the app ships without them.
server_headers = set()
sw_headers = set()
in_sw = False
depth = 0
for line in nginx.splitlines():
    stripped = line.strip()
    if stripped.startswith("location = /sw.js"):
        in_sw = True
        depth = 0
    if in_sw:
        depth += line.count("{") - line.count("}")
        m = re.match(r"add_header\s+(\S+)", stripped)
        if m:
            sw_headers.add(m.group(1))
        if depth <= 0 and "}" in line:
            in_sw = False
    else:
        m = re.match(r"add_header\s+(\S+)", stripped)
        if m:
            server_headers.add(m.group(1))

security_headers = {
    "Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy",
    "Cross-Origin-Opener-Policy", "Strict-Transport-Security", "Permissions-Policy",
}
for header in sorted(security_headers & server_headers):
    check("/sw.js location repeats " + header + " (add_header replaces, not appends)",
          header in sw_headers)

# ── CSP ──────────────────────────────────────────────────────────────

csp = re.search(r'add_header Content-Security-Policy "([^"]+)"', nginx)
check("nginx sets a CSP", csp is not None)
if csp:
    policy = csp.group(1)
    check("CSP default-src is 'none'", "default-src 'none'" in policy)
    check("CSP forbids inline script", "'unsafe-inline'" not in policy.split("style-src")[0])
    check("CSP forbids eval", "'unsafe-eval'" not in policy)
    check("CSP blocks framing", "frame-ancestors 'none'" in policy)
    check("CSP allows the service worker", "worker-src 'self'" in policy)
    check("CSP allows the manifest", "manifest-src 'self'" in policy)
    # Photos are Blobs shown through object URLs, so blob: belongs in img-src.
    img = re.search(r"img-src ([^;]+)", policy)
    check("CSP allows blob: images (captured photos)", img is not None and "blob:" in img.group(1))
    # ...and must NOT be script-executable.
    script = re.search(r"script-src ([^;]+)", policy)
    check("CSP does NOT allow blob: scripts",
          script is not None and "blob:" not in script.group(1))

# The app must ship no inline scripts or handlers, or the CSP above breaks it.
check("index.html has no inline <script> body",
      not re.search(r"<script(?![^>]*\ssrc=)[^>]*>\s*\S", html))
check("index.html has no inline event handlers",
      not re.search(r"<[^>]+\son(click|load|change|input|submit)\s*=", html, re.I))

# ── CSS invariant ────────────────────────────────────────────────────
# Every sheet, notice and menu is toggled with the hidden attribute, but the
# UA's `[hidden] { display: none }` is a bare attribute selector that ANY class
# rule setting display outranks. Without an explicit override every overlay
# renders at once -- which is exactly what happened the first time this app was
# opened in a browser.
css = read("css", "styles.css") or ""
check("css forces [hidden] to win over class display rules",
      bool(re.search(r"\[hidden\]\s*\{[^}]*display:\s*none\s*!important", css)))
# Anything the UI toggles via `hidden` must therefore be listed here as proof
# the override is actually needed, not decorative.
for cls in (".overlay", ".notice", ".running-pill", ".menu"):
    check("css sets display on " + cls + " (so the [hidden] override matters)",
          bool(re.search(re.escape(cls) + r"[^{]*\{[^}]*display:", css)))

# ── report ───────────────────────────────────────────────────────────

if failures:
    print("  %d checks, %d FAILED" % (checks, len(failures)))
    for f in failures:
        print("  FAIL: " + f)
    sys.exit(1)

print("  %d checks passed" % checks)
sys.exit(0)
