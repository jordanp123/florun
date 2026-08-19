FROM nginxinc/nginx-unprivileged:alpine-slim

# URL path segment the site is served under (config.florun SUBPATH, written into
# the .build quadlet by deploy/install.sh). "." serves at the domain root, which
# is the stock FloRun deployment -- it lives on its own subdomain, so the
# service-worker scope and the manifest start_url are both simply "/".
ARG SUBPATH=.

COPY index.html               /usr/share/nginx/html/${SUBPATH}/index.html
COPY manifest.webmanifest     /usr/share/nginx/html/${SUBPATH}/manifest.webmanifest
COPY sw.js                    /usr/share/nginx/html/${SUBPATH}/sw.js
COPY css/*.css                /usr/share/nginx/html/${SUBPATH}/css/
COPY js/*.js                  /usr/share/nginx/html/${SUBPATH}/js/
COPY icons/*                  /usr/share/nginx/html/${SUBPATH}/icons/
COPY nginx.conf               /etc/nginx/conf.d/default.conf
