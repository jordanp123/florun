/*
 * format.js -- number, duration and date formatting. Pure, DOM-free.
 *
 * Ported from the iOS app's Formatters.swift. Two rules carried over verbatim
 * because downstream code and the exports depend on them:
 *   - formatFlow renders 0 as "0", not an em dash: a manual entry of 0 GPM is a
 *     real reading (a stopped flow), and must read back as the value the user
 *     typed. Only negative / non-finite falls back to the dash.
 *   - parseDecimal accepts BOTH "." and "," as the decimal separator, so a
 *     device set to a European locale doesn't silently reject "1,5".
 */
(function (root) {
  "use strict";
  const FR = (root.FloRun = root.FloRun || {});

  const DASH = "—"; // em dash

  // Flow rates: 4 significant digits with thousands separators. Matches the
  // iOS NumberFormatter (usesSignificantDigits, max 4).
  function formatFlow(value) {
    const v = Number(value);
    if (!isFinite(v) || v < 0) return DASH;
    if (v === 0) return "0";
    return groupSignificant(v, 4);
  }

  // Volumes / heights: up to 3 decimal places, trailing zeros trimmed.
  function formatVolume(value) {
    const v = Number(value);
    if (!isFinite(v)) return DASH;
    return groupFixed(v, 3);
  }

  // Derived US gallons: same shape as formatVolume, kept separate so the two
  // can diverge later without hunting call sites (mirrors the iOS formatters).
  function formatGallons(value) {
    const v = Number(value);
    if (!isFinite(v)) return DASH;
    return groupFixed(v, 3);
  }

  /*
   * Round to `digits` significant figures, then group the integer part.
   * Routed through toExponential rather than a log10: it does the rounding
   * and hands back the exponent in one step, with none of the off-by-one
   * risk of `Math.floor(Math.log10(1000))` landing on 2.
   * 999360 at 4 s.f. -> "999,400", matching the iOS NumberFormatter.
   */
  /*
   * Round to `digits` significant figures. Returns [rounded, decimalPlaces].
   * toExponential does the rounding so that Math.floor(Math.log10(1000)) style
   * off-by-ones cannot happen at exact powers of ten.
   */
  function significantParts(v, digits) {
    const es = Number(v).toExponential(Math.max(0, Math.min(100, digits - 1)));
    const exp = parseInt(es.slice(es.indexOf("e") + 1), 10);
    return [Number(es), Math.max(0, Math.min(20, digits - 1 - exp))];
  }

  function groupSignificant(v, digits) {
    if (v === 0) return "0";
    const p = significantParts(v, digits);
    return groupFixed(p[0], p[1]);
  }

  /*
   * Significant-figure rounding as a PLAIN, ungrouped decimal string -- the
   * machine-readable counterpart to groupSignificant, for the CSV.
   *
   * The CSV used to write a fixed number of DECIMALS, which let a value read
   * off a 4-significant-figure chart leave as "6855.0000". Anyone opening that
   * file sees eight significant figures and no reason to doubt them. Exporting
   * exactly the precision the display claims is the honest form.
   */
  function significantPlain(v, digits) {
    const n = Number(v);
    if (!isFinite(n)) return "";
    if (n === 0) return "0";
    const p = significantParts(n, digits);
    let s = p[0].toFixed(p[1]);
    if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }

  /* Fixed decimals with trailing zeros trimmed, integer part comma-grouped. */
  function groupFixed(v, decimals) {
    let s = v.toFixed(Math.max(0, Math.min(20, decimals)));
    if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
    const neg = s.charAt(0) === "-";
    if (neg) s = s.slice(1);
    const parts = s.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + parts.join(".");
  }

  /*
   * Elapsed time for labels and exports: "12.34 s", "2 min 34.50 s",
   * "1 h 02 min 34 s". Identical breakpoints to the iOS version so a PDF
   * exported from either platform reads the same.
   */
  function formatElapsed(seconds) {
    const t = Number(seconds);
    if (!isFinite(t) || t < 0) return DASH;
    if (t < 60) return t.toFixed(2) + " s";
    if (t < 3600) {
      const m = Math.floor(t / 60);
      const rem = t - m * 60;
      return m + " min " + pad2(Math.floor(rem)) + "." + pad2(Math.round((rem % 1) * 100)) + " s";
    }
    const h = Math.floor(t / 3600);
    const rest = t - h * 3600;
    const m = Math.floor(rest / 60);
    const s = Math.floor(rest - m * 60);
    return h + " h " + pad2(m) + " min " + pad2(s) + " s";
  }

  /* Big stopwatch readout: "00:12.34" / "1:23:45.67". Hundredths resolution. */
  function formatStopwatch(seconds) {
    const t = Number(seconds);
    if (!isFinite(t) || t < 0) return "00:00.00";
    const totalHundredths = Math.floor(t * 100);
    const hundredths = totalHundredths % 100;
    const totalSeconds = Math.floor(totalHundredths / 100);
    const s = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const m = totalMinutes % 60;
    const h = Math.floor(totalMinutes / 60);
    if (h > 0) return h + ":" + pad2(m) + ":" + pad2(s) + "." + pad2(hundredths);
    return pad2(m) + ":" + pad2(s) + "." + pad2(hundredths);
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  /*
   * Locale-tolerant decimal parse. Returns null when the string isn't a plain
   * number, so callers can distinguish "empty" from "zero" -- which matters:
   * 0 is a valid manual entry.
   */
  function parseDecimal(str) {
    if (str === null || str === undefined) return null;
    const trimmed = String(str).trim();
    if (!trimmed) return null;
    // Accept one separator of either kind; reject anything else (letters,
    // exponents, multiple dots) so a paste can't smuggle in NaN/Infinity.
    if (!/^-?\d*[.,]?\d*$/.test(trimmed)) return null;
    const normalized = trimmed.replace(",", ".");
    if (normalized === "" || normalized === "." || normalized === "-") return null;
    const n = Number(normalized);
    return isFinite(n) ? n : null;
  }

  /* ISO 8601 with milliseconds -- the CSV timestamp and the storage format. */
  function toISO(date) {
    return new Date(date).toISOString();
  }

  /* "Jan 5, 2026 at 2:34:07 PM" style, for PDFs and the detail screen. */
  function formatTimestampMedium(date) {
    const d = new Date(date);
    if (isNaN(d.getTime())) return DASH;
    try {
      return d.toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", second: "2-digit",
      });
    } catch (e) {
      return d.toISOString();
    }
  }

  /* Compact "1/5/26, 2:34 PM" for the history PDF table. */
  function formatTimestampShort(date) {
    const d = new Date(date);
    if (isNaN(d.getTime())) return DASH;
    try {
      return d.toLocaleString(undefined, {
        year: "2-digit", month: "numeric", day: "numeric",
        hour: "numeric", minute: "2-digit",
      });
    } catch (e) {
      return d.toISOString();
    }
  }

  /* History list rows: "Today at 2:34 PM" when recent, else a dated form. */
  function formatTimestampList(date) {
    const d = new Date(date);
    if (isNaN(d.getTime())) return DASH;
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yesterday = new Date(now.getTime() - 86400000);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    let time;
    try {
      time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch (e) {
      time = d.toISOString().slice(11, 16);
    }
    if (sameDay) return "Today at " + time;
    if (isYesterday) return "Yesterday at " + time;
    try {
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) + " at " + time;
    } catch (e) {
      return d.toISOString().slice(0, 10) + " at " + time;
    }
  }

  /* Filename-safe UTC stamp: 2026-05-04_154200 */
  function fileStamp(date) {
    const d = new Date(date);
    const p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  FR.format = {
    DASH,
    formatFlow, formatVolume, formatGallons, significantPlain,
    formatElapsed, formatStopwatch,
    parseDecimal, toISO,
    formatTimestampMedium, formatTimestampShort, formatTimestampList,
    fileStamp,
  };
})(typeof self !== "undefined" ? self : this);
