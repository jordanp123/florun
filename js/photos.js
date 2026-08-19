/*
 * photos.js -- capture, downscale and re-encode measurement photos.
 *
 * The camera is reached through <input type="file" accept="image/*"
 * capture="environment">, which on iOS and Android opens the camera directly
 * and on desktop falls back to a file picker. No getUserMedia: we want a still
 * photo, not a video stream, and the file input needs no permission prompt of
 * its own beyond the one the OS shows.
 *
 * Every capture is redrawn through a canvas at a bounded size. Three things
 * follow from that, all of them wanted:
 *   - Size is bounded to ~300-500 KB regardless of what the camera produced.
 *     (The iOS app shipped a bug here for a while: its renderer defaulted to
 *     the 3x display scale, so "downscaling" to 2048 points actually produced a
 *     6144-pixel file. Canvas work in CSS pixels has no such trap.)
 *   - EXIF is dropped, including the camera's embedded GPS. The coordinates we
 *     store are the ones the user explicitly consented to, and nothing else
 *     rides along in the file.
 *   - Orientation is baked in, so a photo taken sideways is upright everywhere
 *     it is later shown -- screen, PDF, or a file the user shares.
 */
(function (root) {
  "use strict";
  const FR = (root.FloRun = root.FloRun || {});

  const MAX_DIMENSION = 2048;   // longest edge, pixels
  const JPEG_QUALITY = 0.78;

  function isSupported() {
    return typeof root.document !== "undefined" &&
      typeof root.FileReader !== "undefined" &&
      !!root.HTMLCanvasElement;
  }

  /*
   * Decode a File/Blob honouring its EXIF orientation.
   * createImageBitmap with imageOrientation "from-image" is the modern path;
   * older Safari needs the <img> fallback, which applies orientation itself
   * for images loaded from a blob URL.
   */
  function decode(file) {
    if (root.createImageBitmap) {
      try {
        return root.createImageBitmap(file, { imageOrientation: "from-image" })
          .catch(function () { return decodeViaImage(file); });
      } catch (e) {
        return decodeViaImage(file);
      }
    }
    return decodeViaImage(file);
  }

  function decodeViaImage(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new root.Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read that image"));
      };
      img.src = url;
    });
  }

  function dimensionsOf(source) {
    return {
      width: source.width || source.naturalWidth || 0,
      height: source.height || source.naturalHeight || 0,
    };
  }

  /*
   * Downscale to MAX_DIMENSION on the longest edge and re-encode as baseline
   * JPEG. Never upscales: a small image is passed through at its own size, so
   * it stays crisp rather than being blown up and blurred.
   */
  function process(file) {
    return decode(file).then(function (source) {
      const dim = dimensionsOf(source);
      if (!(dim.width > 0 && dim.height > 0)) throw new Error("Empty image");

      const longest = Math.max(dim.width, dim.height);
      const scale = Math.min(1, MAX_DIMENSION / longest);
      const w = Math.max(1, Math.round(dim.width * scale));
      const h = Math.max(1, Math.round(dim.height * scale));

      const canvas = root.document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      // White matte: JPEG has no alpha, and an unpainted canvas would encode
      // transparent pixels as black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(source, 0, 0, w, h);
      if (source.close) source.close();   // release the ImageBitmap promptly

      return toBlob(canvas).then(function (blob) {
        return { blob: blob, width: w, height: h };
      });
    });
  }

  function toBlob(canvas) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob); else reject(new Error("JPEG encoding failed"));
        }, "image/jpeg", JPEG_QUALITY);
        return;
      }
      // Very old Safari: dataURL round-trip.
      try {
        const url = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
        resolve(dataURLToBlob(url));
      } catch (e) {
        reject(new Error("JPEG encoding failed"));
      }
    });
  }

  function dataURLToBlob(url) {
    const comma = url.indexOf(",");
    const bin = root.atob(url.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: "image/jpeg" });
  }

  /* Capture -> process -> persist. Resolves with the stored photo id. */
  function captureAndStore(file) {
    return process(file).then(function (result) {
      const id = FR.core.uuid() + ".jpg";
      return FR.store.putPhoto(id, result.blob).then(function () { return id; });
    });
  }

  /* Raw bytes for a stored photo -- what the PDF exporter embeds. */
  function bytesFor(photoId) {
    return FR.store.getPhoto(photoId).then(function (blob) {
      if (!blob) return null;
      if (blob.arrayBuffer) {
        return blob.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
      }
      return new Promise(function (resolve, reject) {
        const reader = new root.FileReader();
        reader.onload = function () { resolve(new Uint8Array(reader.result)); };
        reader.onerror = function () { reject(reader.error); };
        reader.readAsArrayBuffer(blob);
      });
    });
  }

  /*
   * Object URL for display. Callers must revoke when the element goes away --
   * `revoke` is here so they don't have to reach for URL directly.
   */
  function objectURLFor(photoId) {
    return FR.store.getPhoto(photoId).then(function (blob) {
      return blob ? URL.createObjectURL(blob) : null;
    });
  }

  function revoke(url) {
    if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
  }

  FR.photos = {
    MAX_DIMENSION, JPEG_QUALITY,
    isSupported, process, captureAndStore, bytesFor, objectURLFor, revoke,
  };
})(typeof self !== "undefined" ? self : this);
