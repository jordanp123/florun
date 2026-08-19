/*
 * geo.js -- one-shot location fix, requested only when the user saves.
 *
 * Mirrors the iOS LocationService contract exactly, because the UI depends on
 * it: a single fix with a 5 second ceiling, and EVERY failure path -- denied,
 * timed out, unavailable, no hardware -- resolves with null rather than
 * rejecting. A measurement must always be savable; coordinates are a bonus,
 * never a precondition.
 *
 * Accuracy is requested at the "coarse" tier (enableHighAccuracy false). A
 * field worker standing at an outfall does not need GPS-grade precision to
 * label which outfall it was, and the coarse fix returns faster and costs less
 * battery. It also keeps the recorded precision honest: the exports round
 * coordinates to 4 decimal places (~11 m) to match.
 */
(function (root) {
  "use strict";
  const FR = (root.FloRun = root.FloRun || {});

  const TIMEOUT_MS = 5000;

  let inFlight = false;

  function isSupported() {
    return !!(root.navigator && root.navigator.geolocation);
  }

  /*
   * Whether the browser will prompt. Permissions API is advisory only -- Safari
   * did not support querying geolocation for years -- so "unknown" is a normal
   * answer and callers must not gate on it.
   */
  function permissionState() {
    if (!root.navigator || !root.navigator.permissions || !root.navigator.permissions.query) {
      return Promise.resolve("unknown");
    }
    try {
      return root.navigator.permissions.query({ name: "geolocation" })
        .then(function (status) { return status.state; })
        .catch(function () { return "unknown"; });
    } catch (e) {
      return Promise.resolve("unknown");
    }
  }

  /*
   * Resolve with { latitude, longitude, accuracy } or null. Never rejects.
   * A second concurrent call returns null immediately rather than racing the
   * first -- the same guard the iOS service needed after two rapid Save taps
   * could strand a continuation.
   */
  function requestSingleFix(timeoutMs) {
    const limit = timeoutMs || TIMEOUT_MS;
    if (!isSupported()) return Promise.resolve(null);
    if (inFlight) return Promise.resolve(null);
    inFlight = true;

    return new Promise(function (resolve) {
      let settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        inFlight = false;
        clearTimeout(timer);
        resolve(value);
      }

      // Our own timer as well as the platform's: some browsers honour the
      // `timeout` option loosely, and a Save that hangs is worse than a Save
      // without coordinates.
      const timer = setTimeout(function () { finish(null); }, limit + 250);

      try {
        root.navigator.geolocation.getCurrentPosition(
          function (pos) {
            const c = pos && pos.coords;
            if (!c || !isFinite(c.latitude) || !isFinite(c.longitude)) { finish(null); return; }
            finish({
              latitude: c.latitude,
              longitude: c.longitude,
              accuracy: isFinite(c.accuracy) ? c.accuracy : null,
            });
          },
          function () { finish(null); },
          { enableHighAccuracy: false, timeout: limit, maximumAge: 30000 }
        );
      } catch (e) {
        finish(null);
      }
    });
  }

  /* Let a cancelled save stop waiting on a fix that is still outstanding. */
  function cancelInFlight() { inFlight = false; }

  FR.geo = { TIMEOUT_MS, isSupported, permissionState, requestSingleFix, cancelInFlight };
})(typeof self !== "undefined" ? self : this);
