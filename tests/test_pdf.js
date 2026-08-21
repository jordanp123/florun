/*
 * test_pdf.js -- the PDF writer.
 *
 * The assertion that matters most is the xref table: every entry must be the
 * exact byte offset of its object. Get that wrong by one and most viewers
 * either refuse the file or silently repair it, so the test parses the emitted
 * bytes back and checks each offset actually lands on "N 0 obj".
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
    const d = Math.abs(actual - expected);
    ok(label + "  (got " + actual + ", want " + expected + ")", d <= (tol === undefined ? 1e-9 : tol));
  }

  const pdf = self.FloRun.pdf;

  /* Read a Uint8Array back as a latin1 string for structural inspection. */
  function toStr(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /* ── WinAnsi encoding ──────────────────────────────────────────────── */

  eq("winansi ascii passthrough", pdf.toWinAnsi("Flow 30 GPM"), "Flow 30 GPM");
  eq("winansi degree sign", pdf.toWinAnsi("90°").charCodeAt(2), 0xB0);
  eq("winansi em dash", pdf.toWinAnsi("a—b").charCodeAt(1), 0x97);
  eq("winansi middle dot", pdf.toWinAnsi("a·b").charCodeAt(1), 0xB7);
  eq("winansi plus-minus", pdf.toWinAnsi("±5 m").charCodeAt(0), 0xB1);
  eq("winansi curly quote", pdf.toWinAnsi("“x”").charCodeAt(0), 0x93);
  // Anything unmappable must degrade to '?', never emit a multi-byte sequence
  // that would desynchronise every xref offset after it.
  eq("winansi unmappable -> ?", pdf.toWinAnsi("中"), "?");
  (function () {
    const s = pdf.toWinAnsi("中日°");
    let allSingleByte = true;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xFF) allSingleByte = false;
    ok("winansi output is always <= 0xFF per char", allSingleByte);
  })();

  /* ── String escaping ───────────────────────────────────────────────── */

  eq("escape paren open",  pdf.escapeString("a(b"), "a\\(b");
  eq("escape paren close", pdf.escapeString("a)b"), "a\\)b");
  eq("escape backslash",   pdf.escapeString("a\\b"), "a\\\\b");
  eq("escape plain",       pdf.escapeString("Outfall 3"), "Outfall 3");

  /* ── Text measurement ──────────────────────────────────────────────── */

  // Helvetica space is 278/1000 em; at 10pt that is 2.78pt.
  near("measure single space at 10pt", pdf.measure(" ", 10), 2.78, 1e-9);
  // "AAA" = 3 x 667 = 2001/1000 em; at 12pt = 24.012pt.
  near("measure AAA at 12pt", pdf.measure("AAA", 12), 2001 * 12 / 1000, 1e-9);
  eq("measure empty string", pdf.measure("", 12), 0);
  // Pin individual AFM widths rather than asserting "bold is wider" -- several
  // glyphs (notably 'a', 556 in both faces) are identical between Helvetica and
  // Helvetica-Bold, so a naive wider-than check picks the wrong probe.
  near("Helvetica 'a' is 556/1000", pdf.measure("a", 1000), 556, 1e-9);
  near("Helvetica-Bold 'a' is also 556/1000", pdf.measure("a", 1000, { bold: true }), 556, 1e-9);
  near("Helvetica 'b' is 556/1000", pdf.measure("b", 1000), 556, 1e-9);
  near("Helvetica-Bold 'b' is 611/1000", pdf.measure("b", 1000, { bold: true }), 611, 1e-9);
  near("Helvetica 'I' is 278/1000", pdf.measure("I", 1000), 278, 1e-9);
  near("Helvetica 'W' is 944/1000", pdf.measure("W", 1000), 944, 1e-9);
  ok("bold is wider for a real sentence",
    pdf.measure("Gallons Per Minute", 12, { bold: true }) > pdf.measure("Gallons Per Minute", 12));
  // Oblique shares Helvetica's metrics by definition.
  near("italic reuses regular metrics",
    pdf.measure("Notes", 12, { italic: true }), pdf.measure("Notes", 12), 1e-12);

  /* ── Word wrap ─────────────────────────────────────────────────────── */

  (function () {
    const lines = pdf.wrapText("one two three four five six seven", 10, 60);
    ok("wrap produces multiple lines", lines.length > 1);
    let fits = true;
    lines.forEach(function (l) { if (pdf.measure(l, 10) > 60.001) fits = false; });
    ok("every wrapped line fits the column", fits);
    eq("wrap preserves all words",
      lines.join(" ").replace(/\s+/g, " ").trim(), "one two three four five six seven");
  })();

  (function () {
    // A single word wider than the column must be split, not overflow.
    const lines = pdf.wrapText("supercalifragilisticexpialidocious", 10, 40);
    let fits = true;
    lines.forEach(function (l) { if (pdf.measure(l, 10) > 40.001) fits = false; });
    ok("over-long word is hard-split to fit", fits && lines.length > 1);
  })();

  eq("wrap keeps explicit newlines", pdf.wrapText("a\nb", 10, 500).length, 2);

  /* ── JPEG header parsing ───────────────────────────────────────────── */

  /* Minimal synthetic JPEG: SOI + SOF0(precision, h, w, components) + EOI. */
  function makeJPEG(w, h, comps, sofMarker) {
    return new Uint8Array([
      0xFF, 0xD8,
      0xFF, (sofMarker === undefined ? 0xC0 : sofMarker), 0x00, 0x11, 0x08,
      (h >> 8) & 0xFF, h & 0xFF,
      (w >> 8) & 0xFF, w & 0xFF,
      comps, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
      0xFF, 0xD9,
    ]);
  }

  (function () {
    const info = pdf.parseJPEG(makeJPEG(1024, 768, 3));
    ok("jpeg parsed", !!info);
    eq("jpeg width", info.width, 1024);
    eq("jpeg height", info.height, 768);
    eq("jpeg components", info.components, 3);
    eq("jpeg bits", info.bits, 8);
  })();

  eq("grayscale jpeg accepted", pdf.parseJPEG(makeJPEG(10, 10, 1)).components, 1);
  eq("progressive jpeg rejected", pdf.parseJPEG(makeJPEG(10, 10, 3, 0xC2)), null);
  eq("non-jpeg rejected", pdf.parseJPEG(new Uint8Array([1, 2, 3, 4])), null);
  eq("empty rejected", pdf.parseJPEG(new Uint8Array(0)), null);
  eq("null rejected", pdf.parseJPEG(null), null);
  // A JPEG carrying an APP0/JFIF segment before the SOF must still parse: the
  // scanner has to skip segments by length, not assume SOF comes first.
  (function () {
    const withApp0 = new Uint8Array([
      0xFF, 0xD8,
      0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
      0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xFF, 0xC0, 0x00, 0x11, 0x08, 0x02, 0x00, 0x03, 0x00, 0x03,
      0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
      0xFF, 0xD9,
    ]);
    const info = pdf.parseJPEG(withApp0);
    ok("jpeg with APP0 segment parsed", !!info);
    if (info) { eq("APP0 jpeg width", info.width, 768); eq("APP0 jpeg height", info.height, 512); }
  })();

  /* ── Document structure ────────────────────────────────────────────── */

  (function () {
    const doc = pdf.createDocument();
    doc.addPage();
    doc.text("FloRun Flow Measurement", 36, 36, { size: 22, bold: true });
    doc.line(36, 70, 576, 70);
    doc.rect(36, 80, 540, 18, { fill: [0.9, 0.9, 0.9] });
    doc.text("Right aligned", 36, 100, { size: 10, align: "right", width: 540 });
    doc.addPage();
    doc.text("Page two", 36, 36, { size: 12 });
    const bytes = doc.build();
    const s = toStr(bytes);

    ok("starts with PDF header", s.indexOf("%PDF-1.4") === 0);
    ok("ends with EOF marker", /%%EOF\n?$/.test(s));
    ok("has an xref table", s.indexOf("\nxref\n") > 0 || s.indexOf("xref\n") > 0);
    ok("has a trailer with a Root", /trailer\s*<<[^>]*\/Root \d+ 0 R/.test(s));
    ok("declares two pages", s.indexOf("/Count 2") > 0);
    ok("uses WinAnsiEncoding", s.indexOf("/WinAnsiEncoding") > 0);
    ok("emits the drawn text", s.indexOf("(FloRun Flow Measurement) Tj") > 0);
    ok("emits a fill for the rect", s.indexOf(" re f") > 0);
    ok("emits a stroke for the line", s.indexOf(" l S") > 0);

    /* The critical check: every xref offset must land exactly on its object. */
    const startxref = /startxref\s+(\d+)/.exec(s);
    ok("startxref present", !!startxref);
    if (startxref) {
      const xrefPos = Number(startxref[1]);
      eq("startxref points at the xref keyword", s.slice(xrefPos, xrefPos + 4), "xref");
      const header = /^xref\n0 (\d+)\n/.exec(s.slice(xrefPos));
      ok("xref subsection header parses", !!header);
      if (header) {
        const count = Number(header[1]);
        // The subsection starts at object 0, whose entry is the mandatory
        // free-list head; real objects begin one 20-byte entry later.
        const freeEntry = s.substr(xrefPos + header[0].length, 20);
        eq("object 0 is the free-list head", freeEntry, "0000000000 65535 f \n");

        let cursor = xrefPos + header[0].length + 20;
        let allGood = true, checked = 0, firstBad = "";
        for (let n = 1; n < count; n++) {
          const entry = s.substr(cursor, 20);           // "0000000015 00000 n \n"
          if (!/^\d{10} 00000 n \n$/.test(entry)) {
            allGood = false;
            if (!firstBad) firstBad = "malformed entry " + n + ": " + JSON.stringify(entry);
          }
          const off = Number(entry.slice(0, 10));
          const expected = n + " 0 obj";
          if (s.substr(off, expected.length) !== expected) {
            allGood = false;
            if (!firstBad) firstBad = "obj " + n + " offset " + off + " -> " + JSON.stringify(s.substr(off, 12));
          }
          cursor += 20;
          checked++;
        }
        eq("xref entry count matches object count", checked, count - 1);
        ok("every xref offset lands on its object header" + (firstBad ? " [" + firstBad + "]" : ""), allGood);
        eq("trailer /Size matches xref count", /\/Size (\d+)/.exec(s)[1], String(count));
      }
    }
  })();

  /* ── Image embedding ───────────────────────────────────────────────── */

  (function () {
    const doc = pdf.createDocument();
    doc.addPage();
    const jpeg = makeJPEG(640, 480, 3);
    const placed = doc.image(jpeg, 36, 100, 300, 225);
    eq("image reports success", placed, true);
    const bytes = doc.build();
    const s = toStr(bytes);
    ok("image XObject declared", s.indexOf("/Subtype /Image") > 0);
    ok("image uses DCTDecode (lossless embed)", s.indexOf("/Filter /DCTDecode") > 0);
    ok("image dimensions written", s.indexOf("/Width 640") > 0 && s.indexOf("/Height 480") > 0);
    ok("image colorspace RGB", s.indexOf("/DeviceRGB") > 0);
    ok("page resources reference the image", /\/XObject << \/Im1 \d+ 0 R >>/.test(s));
    ok("content stream draws the image", s.indexOf("/Im1 Do") > 0);
    // The raw JPEG bytes must appear verbatim -- that is what "lossless" means.
    ok("raw jpeg bytes embedded verbatim", s.indexOf(toStr(jpeg)) > 0);
  })();

  (function () {
    const doc = pdf.createDocument();
    doc.addPage();
    eq("bad image is skipped, not fatal", doc.image(new Uint8Array([0, 1, 2]), 0, 0, 10, 10), false);
    const s = toStr(doc.build());
    ok("no XObject emitted for a rejected image", s.indexOf("/Subtype /Image") < 0);
    ok("document still builds after a rejected image", s.indexOf("%%EOF") > 0);
  })();

  /* Text containing PDF metacharacters must not corrupt the stream. */
  (function () {
    const doc = pdf.createDocument();
    doc.addPage();
    doc.text("Site (north) \\ 90° — done", 36, 36, { size: 10 });
    const s = toStr(doc.build());
    ok("parens escaped in output", s.indexOf("Site \\(north\\)") > 0);
    const startxref = Number(/startxref\s+(\d+)/.exec(s)[1]);
    eq("offsets still exact with escaped + high-byte text", s.slice(startxref, startxref + 4), "xref");
  })();

  /* ── Exported PDFs disclose clamping and basis (A2, A5) ───────────── */

  (function () {
    const F = self.FloRun, core = self.FloRun.core;
    function pdfText(rec) { return toStr(F.exporter.buildSinglePDF(rec, null)); }

    const clamped = core.makeRecord({
      mode: "weir", weirType: "v90", headInches: 30,
      rate: F.weir.flowRate(30, "v90") });
    const inRange = core.makeRecord({
      mode: "weir", weirType: "v90", headInches: 13,
      rate: F.weir.flowRate(13, "v90") });

    const clampedTxt = pdfText(clamped), inRangeTxt = pdfText(inRange);

    ok("clamped measurement PDF says so", clampedTxt.indexOf("ABOVE CHART") > 0);
    ok("in-range measurement PDF does not", inRangeTxt.indexOf("ABOVE CHART") < 0);
    ok("clamped PDF is still structurally valid",
       clampedTxt.slice(0, 5) === "%PDF-" && clampedTxt.indexOf("%%EOF") > 0 &&
       clampedTxt.indexOf("xref") > 0);

    ok("measurement PDF states its basis", clampedTxt.indexOf("Basis:") > 0);
    ok("weir basis names the discharge table", clampedTxt.indexOf("discharge table") > 0);

    const bucketTxt = pdfText(core.makeRecord({
      mode: "timedVolume", volume: 6, volumeUnit: "bucket5", elapsedSeconds: 30,
      rate: core.calculate(6, "bucket5", 30) }));
    ok("bucket basis names the pail model and its spread",
       bucketTxt.indexOf("generic 5-gallon pail") > 0 && bucketTxt.indexOf("5-10%") > 0);

    // History table: the marker, and a footnote that explains it.
    const hist = toStr(F.exporter.buildHistoryPDF([clamped, inRange]));
    ok("history PDF footnotes the clamp marker", hist.indexOf("outside the chart") > 0);
    ok("history footnote counts affected rows", hist.indexOf("1 row is affected") > 0);
    ok("history PDF omits the footnote when nothing is clamped",
       toStr(F.exporter.buildHistoryPDF([inRange])).indexOf("outside the chart") < 0);
    ok("history PDF is structurally valid",
       hist.slice(0, 5) === "%PDF-" && hist.indexOf("%%EOF") > 0);
  })();

  console.log("  " + pass + " passed, " + fail + " failed");
  if (fail) {
    failures.forEach(function (f) { console.log("  FAIL: " + f); });
    throw new Error(fail + " assertion(s) failed");
  }
})();
