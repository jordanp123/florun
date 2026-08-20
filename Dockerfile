FROM nginxinc/nginx-unprivileged:alpine-slim

# URL path segment the site is served under (config.florun SUBPATH, written into
# the .build quadlet by deploy/install.sh). "." serves at the domain root, which
# is the stock FloRun deployment -- it lives on its own subdomain, so the
# service-worker scope and the manifest start_url are both simply "/".
ARG SUBPATH=.

# Delete the stock nginx welcome page BEFORE copying ours in.
#
# The base image ships /usr/share/nginx/html/index.html, and our COPY only
# overwrites it when SUBPATH is ".". With any other SUBPATH -- or if the build
# arg fails to reach the build at all -- the domain root would quietly serve
# nginx's "Welcome to nginx!" page instead of FloRun, which looks like a
# working deployment and is the least useful possible symptom. Removing it
# turns that failure into an obvious 404.
#
# USER root is needed because the unprivileged base image drops to uid 101
# before this point; the final USER is restored below. (COPY is unaffected --
# it always writes as root unless --chown is given.)
USER root
RUN rm -f /usr/share/nginx/html/index.html /usr/share/nginx/html/50x.html

COPY index.html               /usr/share/nginx/html/${SUBPATH}/index.html
COPY manifest.webmanifest     /usr/share/nginx/html/${SUBPATH}/manifest.webmanifest
COPY sw.js                    /usr/share/nginx/html/${SUBPATH}/sw.js
COPY css/*.css                /usr/share/nginx/html/${SUBPATH}/css/
COPY js/*.js                  /usr/share/nginx/html/${SUBPATH}/js/
COPY icons/*                  /usr/share/nginx/html/${SUBPATH}/icons/
COPY nginx.conf               /etc/nginx/conf.d/default.conf

# Restore the base image's unprivileged user. The quadlet also pins the runtime
# UID (User= from config.florun), so this is belt-and-braces: the image is never
# root-by-default even if run outside the unit.
USER 101
