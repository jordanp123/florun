/*
 * pdf.js -- a minimal PDF 1.4 writer. Pure, DOM-free, zero dependencies.
 *
 * Exists because the web has no UIGraphicsPDFRenderer and pulling in a PDF
 * library would break both the no-dependency rule and the strict CSP. We need
 * exactly four primitives -- text, lines, filled rectangles and JPEG images --
 * which is a few hundred lines rather than a few hundred kilobytes.
 *
 * Two things make this small:
 *   1. The 14 standard PDF fonts (Helvetica and friends) need no embedding, so
 *      there is no font subsetting to do. We ship their ASCII width tables to
 *      measure text for wrapping and right-alignment.
 *   2. PDF's DCTDecode filter takes raw JPEG bytes verbatim, so a photo the
 *      browser already encoded as JPEG is embedded LOSSLESSLY and without
 *      re-compression -- we only parse its header for the dimensions.
 *
 * Coordinates: callers work in TOP-DOWN points (y grows downward from the page
 * top), which is how the layout code reads naturally and how the iOS exporter
 * was written. The conversion to PDF's bottom-up space happens at draw time.
 *
 * Text is encoded as WinAnsi. Every string stays one byte per character, which
 * is what keeps the xref byte offsets exact.
 */
(function (root) {
  "use strict";
  const FR = (root.FloRun = root.FloRun || {});

  /* ── Standard-14 font metrics (1000 units per em, ASCII 32..126) ───── */

  const W_HELV = [
    278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
    556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
    1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
    667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
    333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
    556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,
  ];
  const W_HELV_BOLD = [
    278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
    556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
    975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
    667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
    333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
    611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,
  ];

  const FONTS = {
    regular: { res: "F1", base: "Helvetica",         widths: W_HELV },
    bold:    { res: "F2", base: "Helvetica-Bold",    widths: W_HELV_BOLD },
    italic:  { res: "F3", base: "Helvetica-Oblique", widths: W_HELV },
  };

  function fontFor(opts) {
    if (opts && opts.italic) return FONTS.italic;
    if (opts && opts.bold) return FONTS.bold;
    return FONTS.regular;
  }

  /*
   * Unicode -> WinAnsi for the punctuation we actually emit (em dash, degree
   * sign, middle dot, plus-minus). 0xA0-0xFF already matches Latin-1, so only
   * the 0x80-0x9F block and a few typographic characters need mapping.
   * Anything unmappable becomes "?" rather than corrupting the byte stream.
   */
  const WINANSI = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F,
  };

  function toWinAnsi(str) {
    let out = "";
    const s = String(str == null ? "" : str);
    for (let i = 0; i < s.length; i++) {
      const cp = s.charCodeAt(i);
      if (cp < 0x100) { out += String.fromCharCode(cp); continue; }
      const mapped = WINANSI[cp];
      out += String.fromCharCode(mapped === undefined ? 0x3F : mapped);
    }
    return out;
  }

  /* PDF string literal: escape the three characters that end/nest a string. */
  function escapeString(str) {
    return toWinAnsi(str).replace(/[\\()]/g, function (m) { return "\\" + m; });
  }

  /* Width of a string in points at a given size. */
  function measure(str, size, opts) {
    const widths = fontFor(opts).widths;
    const s = toWinAnsi(str);
    let total = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      total += (c >= 32 && c <= 126) ? widths[c - 32] : 556;
    }
    return total * size / 1000;
  }

  /* Greedy word wrap to a pixel width. Long unbreakable words are hard-split. */
  function wrapText(str, size, maxWidth, opts) {
    const paragraphs = String(str == null ? "" : str).split(/\r\n|\r|\n/);
    const lines = [];
    for (let p = 0; p < paragraphs.length; p++) {
      const words = paragraphs[p].split(/\s+/).filter(function (w) { return w.length; });
      if (!words.length) { lines.push(""); continue; }
      let line = "";
      for (let i = 0; i < words.length; i++) {
        const candidate = line ? line + " " + words[i] : words[i];
        if (measure(candidate, size, opts) <= maxWidth || !line) {
          // A single word wider than the column still has to go somewhere:
          // break it character-wise rather than overflow the page.
          if (!line && measure(candidate, size, opts) > maxWidth) {
            let chunk = "";
            for (let c = 0; c < words[i].length; c++) {
              const next = chunk + words[i].charAt(c);
              if (measure(next, size, opts) > maxWidth && chunk) { lines.push(chunk); chunk = words[i].charAt(c); }
              else { chunk = next; }
            }
            line = chunk;
          } else {
            line = candidate;
          }
        } else {
          lines.push(line);
          line = words[i];
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  /* ── JPEG header parsing (for DCTDecode embedding) ─────────────────── */

  /*
   * Pull dimensions and colour model out of a baseline JPEG. Returns null for
   * anything we can't embed, so callers degrade to "no photo" instead of
   * writing a corrupt PDF. Progressive JPEGs are rejected: DCTDecode support
   * for them is not dependable, and the browser's canvas encoder emits
   * baseline anyway.
   */
  function parseJPEG(bytes) {
    if (!bytes || bytes.length < 4) return null;
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xFF) { i++; continue; }
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) { i += 2; continue; }
      if (marker === 0xD9 || marker === 0xDA) break; // EOI / start of scan
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2) return null;
      const isSOF = marker >= 0xC0 && marker <= 0xCF &&
        marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
      if (isSOF) {
        if (marker === 0xC2) return null; // progressive
        const info = {
          bits: bytes[i + 4],
          height: (bytes[i + 5] << 8) | bytes[i + 6],
          width: (bytes[i + 7] << 8) | bytes[i + 8],
          components: bytes[i + 9],
        };
        if (!(info.width > 0 && info.height > 0)) return null;
        if (info.components !== 1 && info.components !== 3 && info.components !== 4) return null;
        return info;
      }
      i += 2 + len;
    }
    return null;
  }

  /* ── Document ──────────────────────────────────────────────────────── */

  const LETTER = { width: 612, height: 792 };

  function createDocument(options) {
    const opts = options || {};
    const pageW = opts.width || LETTER.width;
    const pageH = opts.height || LETTER.height;

    const pages = [];      // { ops: [] , images: {resName: objIndex} }
    const images = [];     // { bytes, info }
    let current = null;

    function y2pdf(yTop) { return pageH - yTop; }
    function fmt(n) {
      // Trim float noise; PDF operands don't need 17 digits.
      const r = Math.round(n * 1000) / 1000;
      return String(r);
    }
    function colorOps(c, stroke) {
      const col = c || [0, 0, 0];
      return fmt(col[0]) + " " + fmt(col[1]) + " " + fmt(col[2]) + (stroke ? " RG" : " rg");
    }

    const api = {
      pageWidth: pageW,
      pageHeight: pageH,

      addPage: function () {
        current = { ops: [], images: [] };
        pages.push(current);
        return api;
      },

      /*
       * Draw a single line of text. `align` may be left (default), right or
       * center; right/center need `width`, measured from `x`.
       */
      text: function (str, x, yTop, o) {
        if (!current) api.addPage();
        const op = o || {};
        const size = op.size || 11;
        const font = fontFor(op);
        let drawX = x;
        if (op.align === "right" || op.align === "center") {
          const w = measure(str, size, op);
          const box = op.width || 0;
          drawX = op.align === "right" ? x + box - w : x + (box - w) / 2;
        }
        // yTop is the TOP of the text box; PDF places the baseline, so drop by
        // the ascent (0.72 em is the Helvetica cap/ascender area in practice).
        const baseline = y2pdf(yTop + size * 0.78);
        current.ops.push(
          colorOps(op.color, false),
          "BT /" + font.res + " " + fmt(size) + " Tf 1 0 0 1 " + fmt(drawX) + " " + fmt(baseline) + " Tm (" +
            escapeString(str) + ") Tj ET"
        );
        return api;
      },

      /*
       * Wrapped paragraph. Returns the height consumed so the caller can
       * advance its cursor.
       */
      textBlock: function (str, x, yTop, width, o) {
        const op = o || {};
        const size = op.size || 11;
        const leading = op.leading || size * 1.25;
        const lines = wrapText(str, size, width, op);
        for (let i = 0; i < lines.length; i++) {
          api.text(lines[i], x, yTop + i * leading, op);
        }
        return lines.length * leading;
      },

      measureBlock: function (str, width, o) {
        const op = o || {};
        const size = op.size || 11;
        const leading = op.leading || size * 1.25;
        return wrapText(str, size, width, op).length * leading;
      },

      line: function (x1, y1Top, x2, y2Top, o) {
        if (!current) api.addPage();
        const op = o || {};
        current.ops.push(
          colorOps(op.color || [0.8, 0.8, 0.8], true),
          fmt(op.width || 0.5) + " w " +
          fmt(x1) + " " + fmt(y2pdf(y1Top)) + " m " + fmt(x2) + " " + fmt(y2pdf(y2Top)) + " l S"
        );
        return api;
      },

      rect: function (x, yTop, w, h, o) {
        if (!current) api.addPage();
        const op = o || {};
        current.ops.push(
          colorOps(op.fill || [0.95, 0.95, 0.95], false),
          fmt(x) + " " + fmt(y2pdf(yTop + h)) + " " + fmt(w) + " " + fmt(h) + " re f"
        );
        return api;
      },

      /*
       * Place a JPEG. Returns false (drawing nothing) if the bytes aren't an
       * embeddable baseline JPEG, so a damaged photo can't take down an export.
       */
      image: function (jpegBytes, x, yTop, w, h) {
        if (!current) api.addPage();
        const info = parseJPEG(jpegBytes);
        if (!info) return false;
        images.push({ bytes: jpegBytes, info: info });
        const resName = "Im" + images.length;
        current.images.push({ res: resName, index: images.length - 1 });
        current.ops.push(
          "q " + fmt(w) + " 0 0 " + fmt(h) + " " + fmt(x) + " " + fmt(y2pdf(yTop + h)) + " cm /" + resName + " Do Q"
        );
        return true;
      },

      measure: function (str, size, o) { return measure(str, size, o); },
      wrap: function (str, size, width, o) { return wrapText(str, size, width, o); },

      /* Serialize to a Uint8Array. */
      build: function () { return serialize(); },
    };

    function serialize() {
      // Object numbering: 1 catalog, 2 pages, 3-5 fonts, then images, then a
      // (page, content) pair per page.
      const objects = [];   // 1-based: objects[n-1] is object n
      function reserve() { objects.push(null); return objects.length; }
      function put(num, chunks) { objects[num - 1] = chunks; }

      const catalogNum = reserve();
      const pagesNum = reserve();
      const fontNums = {};
      ["regular", "bold", "italic"].forEach(function (k) {
        const n = reserve();
        fontNums[k] = n;
        put(n, ["<< /Type /Font /Subtype /Type1 /BaseFont /" + FONTS[k].base +
          " /Encoding /WinAnsiEncoding >>"]);
      });

      const imageNums = images.map(function (img) {
        const n = reserve();
        const cs = img.info.components === 1 ? "/DeviceGray"
          : img.info.components === 4 ? "/DeviceCMYK" : "/DeviceRGB";
        const header = "<< /Type /XObject /Subtype /Image /Width " + img.info.width +
          " /Height " + img.info.height + " /ColorSpace " + cs +
          " /BitsPerComponent " + (img.info.bits || 8) +
          " /Filter /DCTDecode /Length " + img.bytes.length + " >>\nstream\n";
        put(n, [header, img.bytes, "\nendstream"]);
        return n;
      });

      const pageNums = [];
      pages.forEach(function (page) {
        const pageNum = reserve();
        const contentNum = reserve();
        pageNums.push(pageNum);

        const stream = page.ops.join("\n");
        put(contentNum, ["<< /Length " + byteLen(stream) + " >>\nstream\n", stream, "\nendstream"]);

        let xobj = "";
        if (page.images.length) {
          const seen = {};
          const parts = [];
          page.images.forEach(function (ref) {
            if (seen[ref.res]) return;
            seen[ref.res] = 1;
            parts.push("/" + ref.res + " " + imageNums[ref.index] + " 0 R");
          });
          xobj = " /XObject << " + parts.join(" ") + " >>";
        }
        put(pageNum, ["<< /Type /Page /Parent " + pagesNum + " 0 R /MediaBox [0 0 " +
          pageW + " " + pageH + "] /Resources << /Font << " +
          "/F1 " + fontNums.regular + " 0 R /F2 " + fontNums.bold + " 0 R /F3 " + fontNums.italic + " 0 R" +
          " >>" + xobj + " >> /Contents " + contentNum + " 0 R >>"]);
      });

      put(catalogNum, ["<< /Type /Catalog /Pages " + pagesNum + " 0 R >>"]);
      put(pagesNum, ["<< /Type /Pages /Kids [" +
        pageNums.map(function (n) { return n + " 0 R"; }).join(" ") +
        "] /Count " + pageNums.length + " >>"]);

      // Emit, tracking byte offsets for the xref table.
      const out = [];
      let offset = 0;
      function push(chunk) { out.push(chunk); offset += byteLen(chunk); }

      push("%PDF-1.4\n");
      // A binary comment marks the file as containing binary data (photos).
      push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

      const offsets = new Array(objects.length + 1);
      for (let n = 1; n <= objects.length; n++) {
        offsets[n] = offset;
        push(n + " 0 obj\n");
        const chunks = objects[n - 1] || ["<< >>"];
        for (let c = 0; c < chunks.length; c++) push(chunks[c]);
        push("\nendobj\n");
      }

      const xrefOffset = offset;
      let xref = "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
      for (let n = 1; n <= objects.length; n++) {
        xref += pad10(offsets[n]) + " 00000 n \n";
      }
      push(xref);
      push("trailer\n<< /Size " + (objects.length + 1) + " /Root " + catalogNum + " 0 R >>\n" +
        "startxref\n" + xrefOffset + "\n%%EOF\n");

      return concat(out, offset);
    }

    return api;
  }

  /* ── byte helpers ──────────────────────────────────────────────────── */

  // Strings here are latin1 by construction (toWinAnsi guarantees <= 0xFF),
  // so one character is exactly one byte and offsets stay exact.
  function byteLen(chunk) {
    return typeof chunk === "string" ? chunk.length : chunk.length;
  }

  function concat(chunks, total) {
    const out = new Uint8Array(total);
    let p = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (typeof c === "string") {
        for (let j = 0; j < c.length; j++) out[p++] = c.charCodeAt(j) & 0xFF;
      } else {
        out.set(c, p);
        p += c.length;
      }
    }
    return out;
  }

  function pad10(n) {
    let s = String(n);
    while (s.length < 10) s = "0" + s;
    return s;
  }

  FR.pdf = {
    LETTER, createDocument, parseJPEG,
    measure, wrapText, escapeString, toWinAnsi,
    FONTS,
  };
})(typeof self !== "undefined" ? self : this);
