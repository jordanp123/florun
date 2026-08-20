FROM nginxinc/nginx-unprivileged:alpine-slim

# URL path segment the site is served under (config.florun SUBPATH, written into
# the .build quadlet by deploy/install.sh). "." serves at the domain root, which
# is the stock FloRun deployment -- it lives on its own subdomain, so the
# service-worker scope and the manifest start_url are both simply "/".
ARG SUBPATH=.

# Deliberately COPY-only, with no RUN step.
#
# An earlier version added `USER root` + `RUN rm -f` here to delete the base
# image's stock welcome page, so that a wrong SUBPATH would 404 loudly instead
# of quietly serving "Welcome to nginx!". It broke the build in a way this file
# is the wrong place to fight: the deployed image stopped serving index.html at
# the root at all. Every other stack on the same host builds with COPY only,
# and this is the one that grew a RUN and the one that broke.
#
# The job that change was doing is now done properly by the smoke test in
# deploy/bin/florun-update.sh, which fetches the real page after the restart,
# requires FloRun to be in the response, reports the HTTP status, and rolls
# back if it is wrong. That catches strictly more than deleting a file did --
# including the case where the site is missing for some entirely different
# reason -- so there is nothing left for a RUN step to add.
COPY index.html               /usr/share/nginx/html/${SUBPATH}/index.html
COPY manifest.webmanifest     /usr/share/nginx/html/${SUBPATH}/manifest.webmanifest
COPY sw.js                    /usr/share/nginx/html/${SUBPATH}/sw.js
COPY css/*.css                /usr/share/nginx/html/${SUBPATH}/css/
COPY js/*.js                  /usr/share/nginx/html/${SUBPATH}/js/
COPY icons/*                  /usr/share/nginx/html/${SUBPATH}/icons/
COPY nginx.conf               /etc/nginx/conf.d/default.conf
