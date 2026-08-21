/*
 * test_core.js -- the numbers that matter. Charts, conversions, flow math,
 * formatting and CSV escaping.
 *
 * Expected values are the ones verified against the source charts during the
 * iOS build: exact table points must come back EXACTLY (no floating-point
 * drift), interpolated points must land on the arithmetic midpoint, and
 * out-of-range input must clamp or zero rather than extrapolate.
 */
"use strict";
(function () {
  let pass = 0, fail = 0;
  const failures = [];

  function ok(label, cond) {
    if (cond) { pass++; } else { fail++; failures.push(label); }
  }
  function eq(label, actual, expected) {
    ok(label + "  (got " + actual + ", want " + expected + ")", actual === expected);
  }
  function near(label, actual, expected, tol) {
    const t = tol === undefined ? 1e-9 : tol;
    const d = Math.abs(actual - expected);
    ok(label + "  (got " + actual + ", want " + expected + ", diff " + d + ")", d <= t);
  }

  const F = self.FloRun;
  const bucket = F.bucket, weir = F.weir, core = F.core, fmt = F.format;

  /* ── Bucket chart ──────────────────────────────────────────────────── */

  // Exact table points must round-trip bit-for-bit.
  near("bucket h=0",       bucket.gallonsForHeight(0),      0, 0);
  near("bucket h=0.25",    bucket.gallonsForHeight(0.25),   0.0851931169290715, 0);
  near("bucket h=6.875",   bucket.gallonsForHeight(6.875),  2.488150871597, 0);
  near("bucket h=8.824",   bucket.gallonsForHeight(8.824),  3.25046947610986, 0);
  near("bucket h=13.25",   bucket.gallonsForHeight(13.25),  5.08031295354638, 0);
  near("bucket h=13.75",   bucket.gallonsForHeight(13.75),  5.29588075095447, 0);

  // Midpoint between 6.500 and 6.750 interpolates to the arithmetic mean.
  near("bucket h=6.625 interpolated",
    bucket.gallonsForHeight(6.625),
    (2.34444144870322 + 2.44014230420349) / 2, 1e-12);

  // Out of range: clamp above, zero at/below zero. Never extrapolate.
  near("bucket h=14 clamps",   bucket.gallonsForHeight(14),   5.29588075095447, 0);
  near("bucket h=100 clamps",  bucket.gallonsForHeight(100),  5.29588075095447, 0);
  near("bucket h=-1 -> 0",     bucket.gallonsForHeight(-1),   0, 0);
  eq("bucket isInRange(13.75)", bucket.isInRange(13.75), true);
  eq("bucket isInRange(14)",    bucket.isInRange(14), false);

  // The table must be monotonically increasing -- a dip would mean more water
  // reads as less volume, which is how the weir chart typo was caught.
  (function () {
    let mono = true;
    for (let i = 1; i < bucket.ENTRIES.length; i++) {
      if (bucket.ENTRIES[i][0] <= bucket.ENTRIES[i - 1][0]) mono = false;
      if (bucket.ENTRIES[i][1] <= bucket.ENTRIES[i - 1][1]) mono = false;
    }
    ok("bucket table strictly increasing in both axes", mono);
  })();

  /* ── Weir charts ───────────────────────────────────────────────────── */

  near("weir 90 h=1",    weir.gpm(1, "v90"),    2.19, 0);
  near("weir 90 h=2",    weir.gpm(2, "v90"),    12.4, 0);
  near("weir 90 h=10",   weir.gpm(10, "v90"),   694, 0);
  near("weir 90 h=22.5", weir.gpm(22.5, "v90"), 5268, 0);
  near("weir 90 h=25",   weir.gpm(25, "v90"),   6855, 0);

  // 10.25 sits midway between the 10.00 (694) and 10.50 (784) rows.
  near("weir 90 h=10.25 interpolated", weir.gpm(10.25, "v90"), (694 + 784) / 2, 1e-12);

  // Below the published minimum is NO FLOW, not an extrapolation.
  near("weir 90 h=0.5 below chart -> 0", weir.gpm(0.5, "v90"), 0, 0);
  near("weir 90 h=30 clamps",            weir.gpm(30, "v90"),  6855, 0);
  near("weir 90 h=-1 -> 0",              weir.gpm(-1, "v90"),  0, 0);

  near("weir 60 h=1",  weir.gpm(1, "v60"),  1.27, 0);
  near("weir 60 h=2.5", weir.gpm(2.5, "v60"), 12.5, 0);
  near("weir 60 h=10", weir.gpm(10, "v60"), 401, 0);
  near("weir 60 h=20", weir.gpm(20, "v60"), 2266, 0);
  near("weir 60 h=25", weir.gpm(25, "v60"), 3953, 0);

  // The 23-inch 90-degree row was a transcription typo in the source chart
  // (4565, breaking the curve). Pin the corrected value so it can't regress.
  near("weir 90 h=23 (corrected from 4565)", weir.gpm(23, "v90"), 5565, 0);

  // Both tables must be strictly increasing: discharge cannot fall as head
  // rises. This is the invariant that exposed the typo above.
  ["v90", "v60"].forEach(function (id) {
    const t = weir.TYPES[id].entries;
    let mono = true;
    for (let i = 1; i < t.length; i++) {
      if (t[i][0] <= t[i - 1][0] || t[i][1] <= t[i - 1][1]) mono = false;
    }
    ok("weir " + id + " table strictly increasing", mono);
  });

  // V-notch discharge follows Q proportional to H^2.5; doubling the head
  // should multiply flow by ~5.657. Confirms the tables are physically sane.
  near("weir 90 H^2.5 ratio 20/10in", weir.gpm(20, "v90") / weir.gpm(10, "v90"), Math.pow(2, 2.5), 0.02);
  near("weir 60 H^2.5 ratio 20/10in", weir.gpm(20, "v60") / weir.gpm(10, "v60"), Math.pow(2, 2.5), 0.02);
  // 60/90 at equal head tracks tan(30)/tan(45).
  near("weir 60/90 ratio at h=10", weir.gpm(10, "v60") / weir.gpm(10, "v90"), Math.tan(Math.PI / 6), 0.01);

  // flowRate derives the hour/day figures from the per-minute one.
  (function () {
    const r = weir.flowRate(10, "v90");
    near("weir flowRate gpm", r.gpm, 694, 0);
    near("weir flowRate gph", r.gph, 694 * 60, 1e-9);
    near("weir flowRate gpd", r.gpd, 694 * 1440, 1e-9);
  })();

  /* ── Unit conversions (exact NIST definitions) ─────────────────────── */

  near("1 US gal -> 1 gal",   core.toUSGallons(1, "usGal"), 1, 0);
  near("128 fl oz -> 1 gal",  core.toUSGallons(128, "flOz"), 1, 1e-15);
  near("3785.411784 mL -> 1 gal", core.toUSGallons(3785.411784, "mL"), 1, 1e-12);
  near("3.785411784 L -> 1 gal",  core.toUSGallons(3.785411784, "L"), 1, 1e-12);
  near("1 L -> 0.2641720523 gal", core.toUSGallons(1, "L"), 0.264172052358148, 0);
  // The bucket unit routes through the chart, not a multiplier.
  near("bucket unit uses chart", core.toUSGallons(13.25, "bucket5"), 5.08031295354638, 0);

  /* ── Flow calculation ──────────────────────────────────────────────── */

  (function () {
    // 5 US gal in 10 s = 30 GPM.
    const r = core.calculate(5, "usGal", 10);
    near("5 gal /10s -> 30 GPM", r.gpm, 30, 1e-12);
    near("5 gal /10s -> 1800 GPH", r.gph, 1800, 1e-9);
    near("5 gal /10s -> 43200 GPD", r.gpd, 43200, 1e-9);
  })();

  near("1000 mL /10s -> ~1.585 GPM", core.calculate(1000, "mL", 10).gpm, 1.585032314, 1e-6);

  (function () {
    // Bucket filled to the 5-gal mark in 10 s.
    const r = core.calculate(13.25, "bucket5", 10);
    near("bucket 13.25in /10s", r.gpm, 5.08031295354638 * 6, 1e-9);
  })();

  // Guards: no NaN or Infinity may escape into a record.
  eq("zero seconds -> zero rate",  core.calculate(5, "usGal", 0).gpm, 0);
  eq("zero volume -> zero rate",   core.calculate(0, "usGal", 10).gpm, 0);
  eq("negative volume -> zero",    core.calculate(-5, "usGal", 10).gpm, 0);
  eq("NaN volume -> zero",         core.calculate(NaN, "usGal", 10).gpm, 0);
  eq("Infinity seconds -> zero",   core.calculate(5, "usGal", Infinity).gpm, 0);

  /* ── Manual entry ──────────────────────────────────────────────────── */

  (function () {
    const r = core.rateFromGPM(30);
    near("manual 30 -> 30 GPM", r.gpm, 30, 0);
    near("manual 30 -> 1800 GPH", r.gph, 1800, 0);
    near("manual 30 -> 43200 GPD", r.gpd, 43200, 0);
  })();

  // Zero is a REAL manual reading (a stopped flow) and must survive intact.
  (function () {
    const r = core.rateFromGPM(0);
    eq("manual 0 -> gpm 0", r.gpm, 0);
    eq("manual 0 -> gph 0", r.gph, 0);
    eq("manual 0 -> gpd 0", r.gpd, 0);
    eq("manual 0 formats as '0' not a dash", fmt.formatFlow(0), "0");
  })();

  eq("manual negative -> zero", core.rateFromGPM(-5).gpm, 0);
  eq("manual NaN -> zero",      core.rateFromGPM(NaN).gpm, 0);

  // rateIsValid gates saving for timed/weir; a zero rate is not "valid" there.
  eq("rateIsValid(zero) false", core.rateIsValid({ gpm: 0, gph: 0, gpd: 0 }), false);
  eq("rateIsValid(30) true",    core.rateIsValid(core.rateFromGPM(30)), true);
  eq("rateIsValid(Infinity) false", core.rateIsValid({ gpm: Infinity, gph: Infinity, gpd: Infinity }), false);

  /* ── Formatting ────────────────────────────────────────────────────── */

  eq("formatFlow 0",        fmt.formatFlow(0), "0");
  eq("formatFlow 30",       fmt.formatFlow(30), "30");
  eq("formatFlow 43200",    fmt.formatFlow(43200), "43,200");
  eq("formatFlow 999360",   fmt.formatFlow(999360), "999,400"); // 4 significant digits
  eq("formatFlow 1.585032", fmt.formatFlow(1.585032), "1.585");
  eq("formatFlow negative", fmt.formatFlow(-1), fmt.DASH);
  eq("formatFlow NaN",      fmt.formatFlow(NaN), fmt.DASH);
  eq("formatFlow Infinity", fmt.formatFlow(Infinity), fmt.DASH);

  eq("formatStopwatch 0",       fmt.formatStopwatch(0), "00:00.00");
  eq("formatStopwatch 12.34",   fmt.formatStopwatch(12.34), "00:12.34");
  eq("formatStopwatch 83.45",   fmt.formatStopwatch(83.45), "01:23.45");
  eq("formatStopwatch 3661.5",  fmt.formatStopwatch(3661.5), "1:01:01.50");
  eq("formatStopwatch negative", fmt.formatStopwatch(-1), "00:00.00");

  eq("formatElapsed 12.34", fmt.formatElapsed(12.34), "12.34 s");
  eq("formatElapsed 3600",  fmt.formatElapsed(3600), "1 h 00 min 00 s");

  // Locale-tolerant parsing: both separators, and a clean null for junk so
  // "empty" stays distinguishable from "zero".
  eq("parseDecimal '1.5'",  fmt.parseDecimal("1.5"), 1.5);
  eq("parseDecimal '1,5'",  fmt.parseDecimal("1,5"), 1.5);
  eq("parseDecimal '0'",    fmt.parseDecimal("0"), 0);
  eq("parseDecimal ' 42 '", fmt.parseDecimal(" 42 "), 42);
  eq("parseDecimal ''",     fmt.parseDecimal(""), null);
  eq("parseDecimal 'abc'",  fmt.parseDecimal("abc"), null);
  eq("parseDecimal '1e9'",  fmt.parseDecimal("1e9"), null);   // no exponent smuggling
  eq("parseDecimal '1.2.3'", fmt.parseDecimal("1.2.3"), null);
  eq("parseDecimal '.'",    fmt.parseDecimal("."), null);

  /* ── Records ───────────────────────────────────────────────────────── */

  (function () {
    const r = core.makeRecord({
      mode: core.MODES.manualEntry.id,
      rate: core.rateFromGPM(30),
    });
    eq("record has id", typeof r.id === "string" && r.id.length >= 32, true);
    eq("record mode", r.mode, "manualEntry");
    eq("record gpm", r.gpm, 30);
    eq("record has no photo", core.recordHasPhoto(r), false);
    eq("record has no location", core.recordHasLocation(r), false);
    eq("manual record volume in gal is 0", core.recordVolumeInUSGallons(r), 0);
  })();

  (function () {
    const r = core.makeRecord({
      mode: core.MODES.timedVolume.id,
      rate: core.calculate(13.25, "bucket5", 10),
      elapsedSeconds: 10, volume: 13.25, volumeUnit: "bucket5",
      latitude: 39.7392, longitude: -104.9903, locationAccuracyMeters: 5,
    });
    eq("timed record has location", core.recordHasLocation(r), true);
    near("timed record gallons via chart", core.recordVolumeInUSGallons(r), 5.08031295354638, 1e-12);
  })();

  // Two records must never collide on id.
  (function () {
    const seen = {};
    let dup = false;
    for (let i = 0; i < 500; i++) {
      const id = core.uuid();
      if (seen[id]) dup = true;
      seen[id] = 1;
    }
    ok("500 generated ids are unique", !dup);
  })();

  /* ── CSV escaping (RFC 4180) ───────────────────────────────────────── */

  const csv = F.csv;
  eq("csv plain",        csv.escapeField("hello"), "hello");
  eq("csv with comma",   csv.escapeField("Outfall 3, North Pond"), '"Outfall 3, North Pond"');
  eq("csv with quote",   csv.escapeField('He said "big flow"'), '"He said ""big flow"""');
  eq("csv with newline", csv.escapeField("line1\nline2"), '"line1\nline2"');
  eq("csv with CR",      csv.escapeField("a\rb"), '"a\rb"');
  eq("csv empty",        csv.escapeField(""), "");
  eq("csv null",         csv.escapeField(null), "");

  // A full row must keep its column count even when fields contain commas.
  (function () {
    const rows = [core.makeRecord({
      mode: core.MODES.manualEntry.id,
      rate: core.rateFromGPM(30),
      siteLabel: "Outfall 3, North Pond",
      notes: "Steady flow,\nlight rain.",
    })];
    const text = csv.build(rows);
    const lines = text.split("\r\n");
    eq("csv ends with CRLF", text.slice(-2), "\r\n");
    ok("csv has a BOM", text.charCodeAt(0) === 0xFEFF);
    // Header column count is the contract other tools rely on.
    eq("csv header column count", lines[0].split(",").length, csv.HEADERS.length);
    ok("csv quotes the comma-bearing site label", text.indexOf('"Outfall 3, North Pond"') > 0);
    ok("csv method column is the mode id", text.indexOf("manualEntry") > 0);
  })();

  /* ── Audit fixes: range status, CSV safety, precision (A1-A5, S1) ──── */

  (function () {
    const core = F.core, csv = F.csv, fmt = F.format;

    // A2. Chart lookups clamp, so a reading past the end of a table produces a
    // real-looking number. Status is DERIVED from stored fields, so records
    // written before the field existed still report correctly.
    const weirOver = core.makeRecord({
      mode: "weir", weirType: "v90", headInches: 30,
      rate: F.weir.flowRate(30, "v90") });
    const weirAt = core.makeRecord({
      mode: "weir", weirType: "v90", headInches: 25,
      rate: F.weir.flowRate(25, "v90") });
    const weirUnder = core.makeRecord({
      mode: "weir", weirType: "v90", headInches: 0.5,
      rate: F.weir.flowRate(0.5, "v90") });
    const weirOk = core.makeRecord({
      mode: "weir", weirType: "v90", headInches: 13,
      rate: F.weir.flowRate(13, "v90") });

    eq("range: head above chart", core.rangeStatusFor(weirOver), core.RANGE.above);
    eq("range: head at the limit is in range", core.rangeStatusFor(weirAt), core.RANGE.ok);
    eq("range: head below minimum", core.rangeStatusFor(weirUnder), core.RANGE.below);
    eq("range: head mid-table", core.rangeStatusFor(weirOk), core.RANGE.ok);
    ok("range: clamped predicate agrees", core.rangeWasClamped(weirOver) &&
       !core.rangeWasClamped(weirOk));

    // The exact confusion this exists to remove: two different heads, one flow.
    eq("clamped and limit readings are numerically identical", weirOver.gpm, weirAt.gpm);
    ok("...but are distinguishable in export",
       core.rangeStatusFor(weirOver) !== core.rangeStatusFor(weirAt));

    const bucketOver = core.makeRecord({
      mode: "timedVolume", volume: 20, volumeUnit: "bucket5", elapsedSeconds: 30,
      rate: core.calculate(20, "bucket5", 30) });
    const bucketOk = core.makeRecord({
      mode: "timedVolume", volume: 6, volumeUnit: "bucket5", elapsedSeconds: 30,
      rate: core.calculate(6, "bucket5", 30) });
    const litres = core.makeRecord({
      mode: "timedVolume", volume: 4, volumeUnit: "L", elapsedSeconds: 30,
      rate: core.calculate(4, "L", 30) });
    eq("range: bucket above chart", core.rangeStatusFor(bucketOver), core.RANGE.above);
    eq("range: bucket in chart", core.rangeStatusFor(bucketOk), core.RANGE.ok);
    eq("range: exact units involve no chart", core.rangeStatusFor(litres), core.RANGE.na);
    eq("range: manual entry involves no chart",
       core.rangeStatusFor(core.makeRecord({ mode: "manualEntry", rate: core.rateFromGPM(5) })),
       core.RANGE.na);

    // S1. Spreadsheet formula injection (CWE-1236). RFC 4180 quoting does not
    // prevent it -- the quotes are stripped on parse and the formula evaluates.
    eq("deFormula neutralizes =",  csv.deFormula("=1+1"), "'=1+1");
    eq("deFormula neutralizes +",  csv.deFormula("+1"), "'+1");
    eq("deFormula neutralizes -",  csv.deFormula("-2 in below crest"), "'-2 in below crest");
    eq("deFormula neutralizes @",  csv.deFormula("@SUM(1)"), "'@SUM(1)");
    eq("deFormula neutralizes tab", csv.deFormula("\tx"), "'\tx");
    eq("deFormula leaves ordinary text alone", csv.deFormula("Outfall 3"), "Outfall 3");
    eq("deFormula leaves an interior = alone", csv.deFormula("pH=7"), "pH=7");

    const evil = core.makeRecord({
      mode: "manualEntry", rate: core.rateFromGPM(5),
      notes: "=HYPERLINK(\"http://x.tld\",\"go\")", siteLabel: "=cmd" });
    const evilRow = csv.rowFor(evil);
    ok("csv row escapes a formula in notes",
       evilRow[csv.HEADERS.indexOf("Notes")].charAt(0) === "'");
    ok("csv row escapes a formula in the site label",
       evilRow[csv.HEADERS.indexOf("Site Label")].charAt(0) === "'");

    // The guard must NOT touch numeric columns: a southern latitude and a
    // western longitude both begin with "-", and quoting those corrupts data.
    const southwest = core.makeRecord({
      mode: "manualEntry", rate: core.rateFromGPM(5),
      latitude: -33.8688, longitude: -151.2093 });
    const swRow = csv.rowFor(southwest);
    eq("negative latitude survives intact",
       swRow[csv.HEADERS.indexOf("Latitude")], "-33.868800");
    eq("negative longitude survives intact",
       swRow[csv.HEADERS.indexOf("Longitude")], "-151.209300");

    // A3. CSV precision must match the four significant figures the UI claims,
    // not a fixed decimal count that turns a 4-figure chart value into 8.
    eq("significantPlain rounds to 4 s.f.", fmt.significantPlain(1337.4567, 4), "1337");
    eq("significantPlain trims trailing zeros", fmt.significantPlain(6855, 4), "6855");
    eq("significantPlain handles small values", fmt.significantPlain(4.86215, 4), "4.862");
    eq("significantPlain is ungrouped", fmt.significantPlain(999360, 4).indexOf(","), -1);
    eq("significantPlain zero", fmt.significantPlain(0, 4), "0");
    eq("csv gpm carries no invented precision",
       csv.rowFor(weirOk)[csv.HEADERS.indexOf("GPM")], "1337");

    // A2, export side.
    eq("csv carries the range column",
       csv.rowFor(weirOver)[csv.HEADERS.indexOf("Chart Range")], core.RANGE.above);
    ok("Chart Range is a real column", csv.HEADERS.indexOf("Chart Range") > 0);

    // Column count pinned to a literal: comparing against HEADERS.length is
    // self-referential and cannot notice a column being added or dropped.
    eq("csv column count", csv.HEADERS.length, 19);

    // A1. The bucket model's dimensions are published so "verify against your
    // own bucket" is an instruction someone can actually follow.
    ok("bucket model is published", !!F.bucket.MODEL);
    eq("bucket model height matches the chart", F.bucket.MODEL.heightInches, F.bucket.MAX_HEIGHT);
    eq("bucket model brim matches the chart", F.bucket.MODEL.brimGallons, F.bucket.MAX_GALLONS);
    ok("bucket model summary names all three dimensions",
       /10\.0 in.*11\.3 in.*13\.75 in/.test(F.bucket.MODEL.summary));
  })();

  /* ── Report ────────────────────────────────────────────────────────── */

  console.log("  " + pass + " passed, " + fail + " failed");
  if (fail) {
    failures.forEach(function (f) { console.log("  FAIL: " + f); });
    throw new Error(fail + " assertion(s) failed");
  }
})();
