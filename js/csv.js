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
      fixed(rec.gpm, 4),
      fixed(rec.gph, 3),
      fixed(rec.gpd, 2),
      rec.siteLabel || "",
      rec.notes || "",
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

  FR.csv = { HEADERS, escapeField, build, rowFor };
})(typeof self !== "undefined" ? self : this);
