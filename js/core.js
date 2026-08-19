/*
 * core.js -- volume units, flow-rate math and the record shape. Pure, DOM-free.
 *
 * Conversion factors are the exact NIST definitions (1 US gal = 3.785411784 L
 * exactly, 1 US gal = 128 fl oz exactly), carried over from the iOS app where
 * they were verified to 15 significant digits.
 *
 * Units come in two flavours and the distinction drives real UI behaviour:
 *   - DIRECT volume (mL, L, fl oz, US gal): a constant multiplier.
 *   - LOOKUP (5-gal bucket inches): a depth converted through a chart.
 * `isDirectVolume` is what the entry screen keys its labels and warnings off.
 */
(function (root) {
  "use strict";
  const FR = (root.FloRun = root.FloRun || {});

  /* ── Volume units ──────────────────────────────────────────────────── */

  const UNITS = {
    mL:      { id: "mL",     displayName: "mL",                inputSuffix: "mL",    isDirectVolume: true,  factor: 0.000264172052358148 },
    L:       { id: "L",      displayName: "L",                 inputSuffix: "L",     isDirectVolume: true,  factor: 0.264172052358148 },
    flOz:    { id: "flOz",   displayName: "fl oz",             inputSuffix: "fl oz", isDirectVolume: true,  factor: 1 / 128 },
    usGal:   { id: "usGal",  displayName: "US gal",            inputSuffix: "gal",   isDirectVolume: true,  factor: 1 },
    bucket5: { id: "bucket5", displayName: "5-gal bucket (in)", inputSuffix: "in",   isDirectVolume: false, factor: null },
  };

  const UNIT_ORDER = ["mL", "L", "flOz", "usGal", "bucket5"];

  function unitFor(id) { return UNITS[id] || UNITS.usGal; }

  /* Convert a value in the given unit to US gallons. */
  function toUSGallons(value, unitId) {
    const v = Number(value);
    if (!isFinite(v)) return 0;
    const unit = unitFor(unitId);
    if (!unit.isDirectVolume) return FR.bucket.gallonsForHeight(v);
    return v * unit.factor;
  }

  /* ── Measurement modes ─────────────────────────────────────────────── */

  const MODES = {
    timedVolume: { id: "timedVolume", displayName: "Timed Volume" },
    weir:        { id: "weir",        displayName: "V-Notch Weir" },
    manualEntry: { id: "manualEntry", displayName: "Manual Entry" },
  };
  const MODE_ORDER = ["timedVolume", "weir", "manualEntry"];

  /* ── Flow rate ─────────────────────────────────────────────────────── */

  const ZERO_RATE = { gpm: 0, gph: 0, gpd: 0 };

  function rateIsValid(rate) {
    return !!rate && isFinite(rate.gpm) && isFinite(rate.gph) && isFinite(rate.gpd) && rate.gpm > 0;
  }

  /*
   * Timed-volume flow: captured volume over elapsed seconds.
   * Guards mirror the iOS FlowCalculator -- any non-positive or non-finite
   * input yields a zero rate rather than NaN/Infinity leaking into a record.
   */
  function calculate(volume, unitId, seconds) {
    const v = Number(volume), s = Number(seconds);
    if (!(s > 0) || !(v > 0) || !isFinite(v) || !isFinite(s)) return { gpm: 0, gph: 0, gpd: 0 };
    const perSecondGallons = toUSGallons(v, unitId) / s;
    return {
      gpm: perSecondGallons * 60,
      gph: perSecondGallons * 3600,
      gpd: perSecondGallons * 86400,
    };
  }

  /* Manual entry: the user types GPM; the rest is arithmetic. 0 is allowed. */
  function rateFromGPM(gpm) {
    const g = Number(gpm);
    if (!isFinite(g) || g < 0) return { gpm: 0, gph: 0, gpd: 0 };
    return { gpm: g, gph: g * 60, gpd: g * 1440 };
  }

  /* ── Records ───────────────────────────────────────────────────────── */

  /*
   * A saved measurement. One shape covers all three modes; `mode` is the
   * discriminator and irrelevant fields stay null. Kept flat and JSON-native
   * so the whole history round-trips through localStorage unchanged.
   */
  function makeRecord(fields) {
    const f = fields || {};
    const rate = f.rate || ZERO_RATE;
    return {
      id: f.id || uuid(),
      timestamp: f.timestamp || new Date().toISOString(),
      mode: f.mode || MODES.timedVolume.id,
      gpm: num(rate.gpm), gph: num(rate.gph), gpd: num(rate.gpd),
      // timed-volume only
      elapsedSeconds: f.elapsedSeconds != null ? num(f.elapsedSeconds) : null,
      volume: f.volume != null ? num(f.volume) : null,
      volumeUnit: f.volumeUnit || null,
      // weir only
      weirType: f.weirType || null,
      headInches: f.headInches != null ? num(f.headInches) : null,
      // optional metadata (any mode)
      siteLabel: f.siteLabel || null,
      notes: f.notes || null,
      latitude: f.latitude != null ? num(f.latitude) : null,
      longitude: f.longitude != null ? num(f.longitude) : null,
      locationAccuracyMeters: f.locationAccuracyMeters != null ? num(f.locationAccuracyMeters) : null,
      photoId: f.photoId || null,
    };
  }

  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

  function recordHasLocation(r) { return r && r.latitude != null && r.longitude != null; }
  function recordHasPhoto(r) { return !!(r && r.photoId); }

  /* Volume in US gallons for a timed-volume record (0 for other modes). */
  function recordVolumeInUSGallons(r) {
    if (!r || r.mode !== MODES.timedVolume.id) return 0;
    return toUSGallons(r.volume, r.volumeUnit);
  }

  /*
   * RFC 4122 v4 identifier. crypto.randomUUID isn't available on every iOS
   * Safari we care about, so fall back to getRandomValues, and to Math.random
   * only in a headless test shim (never in a browser).
   */
  function uuid() {
    const c = root.crypto || root.msCrypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    const b = new Uint8Array(16);
    if (c && typeof c.getRandomValues === "function") {
      c.getRandomValues(b);
    } else {
      for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [];
    for (let i = 0; i < 16; i++) hex.push((b[i] + 0x100).toString(16).slice(1));
    return hex.slice(0, 4).join("") + "-" + hex.slice(4, 6).join("") + "-" +
      hex.slice(6, 8).join("") + "-" + hex.slice(8, 10).join("") + "-" + hex.slice(10, 16).join("");
  }

  FR.core = {
    UNITS, UNIT_ORDER, unitFor, toUSGallons,
    MODES, MODE_ORDER,
    ZERO_RATE, rateIsValid, calculate, rateFromGPM,
    makeRecord, recordHasLocation, recordHasPhoto, recordVolumeInUSGallons,
    uuid,
  };
})(typeof self !== "undefined" ? self : this);
