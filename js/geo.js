/*
 * geo.js -- one-shot location fix.
 *
 * The contract the UI depends on: this NEVER rejects and never blocks a save.
 * A measurement must always be savable; coordinates are a bonus.
 *
 * Two things differ from the iOS original, both learned the hard way on the
 * web:
 *
 *   1. The timeout is 20s, not 5s. On the web the PERMISSION PROMPT happens
 *      inside the request, so a 5s budget expired while the user was still
 *      reading the dialog and every first-ever save recorded "unavailable".
 *      Native CoreLocation does not charge the prompt against the request.
 *
 *   2. Failures are distinguished rather than collapsed into null. "You denied
 *      permission", "the device could not get a fix" and "it took too long"
 *      need different words in front of a field worker -- only the first is
 *      the user's to fix, and only the last is worth retrying on the spot.
 *
 * Callers should start this EARLY (when the save sheet opens) rather than at
 * the moment of saving, so acquisition overlaps with the user typing a site
 * label instead of making them wait.
 */
(function (root) {
  "use strict";
  const FR = (root.FloRun = root.FloRun || {});

  const TIMEOUT_MS = 20000;
  // A fix from the last half-minute is the same place for our purposes (we
  // record ~100m accuracy anyway) and returns instantly, but is short enough
  // that walking to the next outfall gets a fresh one.
  const MAX_AGE_MS = 30000;

  const STATUS = {
    ok: "ok",
    denied: "denied",
    unavailable: "unavailable",
    timeout: "timeout",
    unsupported: "unsupported",
    busy: "busy",
  };

  let inFlight = false;

  function isSupported() {
    return !!(root.navigator && root.navigator.geolocation);
  }

  /*
   * Advisory only -- Safari lacked geolocation permission queries for years, so
   * "unknown" is a normal answer and callers must not gate on it.
   */
  function permissionState() {
    if (!root.navigator || !root.navigator.permissions || !root.navigator.permissions.query) {
      return Promise.resolve("unknown");
    }
    try {
      return root.navigator.permissions.query({ name: "geolocation" })
        .then(function (s) { return s.state; })
        .catch(function () { return "unknown"; });
    } catch (e) {
      return Promise.resolve("unknown");
    }
  }

  function result(status, extra) {
    const r = { status: status, ok: status === STATUS.ok };
    if (extra) for (const k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) r[k] = extra[k];
    return r;
  }

  /* Human-readable, and honest about whose problem it is. */
  function describe(res) {
    if (!res) return "Location unavailable — saving without coordinates";
    switch (res.status) {
      case STATUS.ok:
        return null;
      case STATUS.denied:
        return "Location permission denied — saving without coordinates. " +
          "Enable it for this site in your browser settings, then reopen this screen.";
      case STATUS.unavailable:
        return "Your device could not get a position — saving without coordinates. " +
          "Moving into the open usually helps.";
      case STATUS.timeout:
        return "Location is taking too long — saving without coordinates. Tap Retry to try again.";
      case STATUS.unsupported:
        return "This browser does not provide location — saving without coordinates.";
      case STATUS.busy:
        return "A location request is already running.";
      default:
        return "Location unavailable — saving without coordinates.";
    }
  }

  /*
   * Resolve with a result object; never rejects. A second concurrent call
   * returns `busy` immediately rather than racing the first.
   */
  function requestSingleFix(timeoutMs) {
    const limit = timeoutMs || TIMEOUT_MS;
    if (!isSupported()) return Promise.resolve(result(STATUS.unsupported));
    if (inFlight) return Promise.resolve(result(STATUS.busy));
    inFlight = true;

    return new Promise(function (resolve) {
      let settled = false;
      function finish(res) {
        if (settled) return;
        settled = true;
        inFlight = false;
        clearTimeout(timer);
        resolve(res);
      }

      // Our own backstop as well as the platform's: some browsers honour the
      // `timeout` option loosely, and a save that hangs is worse than one
      // without coordinates. Generous margin so this only fires when the
      // platform's own timeout has failed to.
      const timer = setTimeout(function () { finish(result(STATUS.timeout)); }, limit + 2000);

      try {
        root.navigator.geolocation.getCurrentPosition(
          function (pos) {
            const c = pos && pos.coords;
            if (!c || !isFinite(c.latitude) || !isFinite(c.longitude)) {
              finish(result(STATUS.unavailable));
              return;
            }
            finish(result(STATUS.ok, {
              latitude: c.latitude,
              longitude: c.longitude,
              accuracy: isFinite(c.accuracy) ? c.accuracy : null,
            }));
          },
          function (err) {
            // 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
            const code = err && err.code;
            if (code === 1) finish(result(STATUS.denied));
            else if (code === 3) finish(result(STATUS.timeout));
            else finish(result(STATUS.unavailable));
          },
          { enableHighAccuracy: false, timeout: limit, maximumAge: MAX_AGE_MS }
        );
      } catch (e) {
        finish(result(STATUS.unavailable));
      }
    });
  }

  /* Let a cancelled save stop waiting on a fix that is still outstanding. */
  function cancelInFlight() { inFlight = false; }

  FR.geo = {
    TIMEOUT_MS, MAX_AGE_MS, STATUS,
    isSupported, permissionState, requestSingleFix, cancelInFlight, describe,
  };
})(typeof self !== "undefined" ? self : this);
