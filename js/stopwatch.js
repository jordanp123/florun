/*
 * stopwatch.js -- the timing engine.
 *
 * Two clocks, deliberately:
 *   - performance.now() is MONOTONIC and immune to the device clock changing
 *     under us (DST, NTP correction, the user setting the time). It is the
 *     source of truth while the page stays loaded.
 *   - Date.now() is the only clock that survives a reload, so it is persisted
 *     and used as the fallback after the page comes back.
 * This is the web equivalent of the iOS systemUptime/wallclock pair, and it
 * exists for the same reason: a field measurement that silently gains an hour
 * because DST started is worse than one that fails loudly.
 *
 * Both a RUNNING timer and a STOPPED-but-unsaved reading are persisted. The
 * second case matters more than it looks: a worker taps Stop, gets interrupted,
 * the tab is discarded to reclaim memory, and without persistence the reading
 * is simply gone.
 */
(function (root) {
  "use strict";
  const FR = (root.FloRun = root.FloRun || {});

  const KEY_START_WALL = "stopwatch.startWall";
  const KEY_COMMITTED = "stopwatch.committedElapsed";

  const STATE = { idle: "idle", running: "running", stopped: "stopped" };

  function nowPerf() {
    return (root.performance && root.performance.now) ? root.performance.now() : Date.now();
  }

  function create() {
    let state = STATE.idle;
    let startWall = null;     // ms since epoch, persisted
    let startPerf = null;     // monotonic origin, this page session only
    let committed = null;     // seconds, set on stop
    let recoveredUnconfirmed = false;
    let wakeLock = null;
    const listeners = [];

    /* ── persistence ─────────────────────────────────────────────────── */

    function restore() {
      const store = FR.store;
      const w = store.pref(KEY_START_WALL, null);
      if (w !== null && isFinite(Number(w))) {
        startWall = Number(w);
        startPerf = null;                 // different page session: no monotonic origin
        state = STATE.running;
        recoveredUnconfirmed = true;      // the UI asks what to do about it, once
        acquireWakeLock();
        return;
      }
      const c = store.pref(KEY_COMMITTED, null);
      if (c !== null && isFinite(Number(c)) && Number(c) > 0) {
        // Stopped but never saved or reset. Restore it silently -- there is
        // nothing to decide, the reading simply reappears.
        committed = Number(c);
        state = STATE.stopped;
      }
    }

    /* ── elapsed ─────────────────────────────────────────────────────── */

    function elapsedNow() {
      if (state === STATE.idle) return 0;
      if (state === STATE.stopped) return committed || 0;
      if (startPerf !== null) {
        return Math.max(0, (nowPerf() - startPerf) / 1000);
      }
      if (startWall !== null) {
        // Recovered run: wallclock is all we have. Clamp so a backwards clock
        // change reads as 0 rather than a negative duration.
        return Math.max(0, (Date.now() - startWall) / 1000);
      }
      return 0;
    }

    function isValidElapsed() {
      const e = elapsedNow();
      return isFinite(e) && e > 0;
    }

    /* ── wake lock ───────────────────────────────────────────────────── */

    /*
     * Keep the screen alive while timing -- the equivalent of iOS's
     * isIdleTimerDisabled. Unsupported browsers simply don't get it; there is
     * no fallback worth the battery (the old trick of looping a muted video
     * is not something a measuring tool should do to someone's phone).
     */
    function acquireWakeLock() {
      if (!root.navigator || !root.navigator.wakeLock || wakeLock) return;
      try {
        root.navigator.wakeLock.request("screen").then(function (lock) {
          wakeLock = lock;
          lock.addEventListener("release", function () { wakeLock = null; });
        }).catch(function () { wakeLock = null; });
      } catch (e) { wakeLock = null; }
    }

    function releaseWakeLock() {
      if (!wakeLock) return;
      try { wakeLock.release(); } catch (e) {}
      wakeLock = null;
    }

    // The OS drops the lock whenever the page is hidden; take it back on return.
    if (root.document && root.document.addEventListener) {
      root.document.addEventListener("visibilitychange", function () {
        if (root.document.visibilityState === "visible" && state === STATE.running) {
          acquireWakeLock();
        }
      });
    }

    /* ── transitions ─────────────────────────────────────────────────── */

    function start() {
      startWall = Date.now();
      startPerf = nowPerf();
      committed = null;
      state = STATE.running;
      recoveredUnconfirmed = false;
      FR.store.setPref(KEY_START_WALL, startWall);
      FR.store.removePref(KEY_COMMITTED);
      acquireWakeLock();
      emit();
    }

    function stop() {
      if (state !== STATE.running) return;
      committed = elapsedNow();
      state = STATE.stopped;
      recoveredUnconfirmed = false;
      startPerf = null;
      startWall = null;
      FR.store.removePref(KEY_START_WALL);
      FR.store.setPref(KEY_COMMITTED, committed);
      releaseWakeLock();
      emit();
    }

    function reset() {
      state = STATE.idle;
      startWall = null;
      startPerf = null;
      committed = null;
      recoveredUnconfirmed = false;
      FR.store.removePref(KEY_START_WALL);
      FR.store.removePref(KEY_COMMITTED);
      releaseWakeLock();
      emit();
    }

    /* "Continue timing" on the recovery prompt: keep running, stop asking. */
    function acknowledgeRecovered() {
      recoveredUnconfirmed = false;
      // Adopt a monotonic origin now that we are live again, derived from the
      // elapsed time we just recovered.
      if (state === STATE.running && startPerf === null) {
        startPerf = nowPerf() - elapsedNow() * 1000;
      }
      emit();
    }

    function discardRecovered() { reset(); }

    /* ── observation ─────────────────────────────────────────────────── */

    function onChange(fn) { listeners.push(fn); return function () {
      const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1);
    }; }

    function emit() { listeners.slice().forEach(function (fn) { try { fn(); } catch (e) {} }); }

    restore();

    return {
      STATE: STATE,
      get state() { return state; },
      get startWall() { return startWall; },
      get hasUnconfirmedRecoveredRun() { return recoveredUnconfirmed; },
      elapsedNow, isValidElapsed,
      start, stop, reset,
      acknowledgeRecovered, discardRecovered,
      onChange,
    };
  }

  FR.stopwatch = { STATE, create };
})(typeof self !== "undefined" ? self : this);
