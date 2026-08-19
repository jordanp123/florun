/*
 * ui.js -- view wiring. Everything user-facing lives here; the modules below it
 * stay pure and testable.
 *
 * No inline handlers anywhere (the CSP forbids them), so every control is bound
 * with addEventListener. State is deliberately plain: a handful of variables and
 * explicit render functions, rather than a framework or a reactive layer. At
 * this size that is less code and far less to go wrong offline.
 */
(function (root) {
  "use strict";
  const FR = root.FloRun;
  const doc = root.document;

  const fmt = FR.format, core = FR.core, store = FR.store;

  /* ── state ─────────────────────────────────────────────────────────── */

  let mode = store.pref("mode", core.MODES.timedVolume.id);
  let unitId = store.pref("lastVolumeUnit", "usGal");
  let weirTypeId = store.pref("lastWeirType", "v90");
  let stopwatch = null;
  let tickHandle = null;
  let currentDetailId = null;
  let detailPhotoURL = null;
  let pendingPhoto = null;       // { blob, url } held until Save is confirmed
  let saveInFlight = false;
  let commitTimer = null;

  if (!core.MODES[mode]) mode = core.MODES.timedVolume.id;
  if (!core.UNITS[unitId]) unitId = "usGal";

  const $ = function (id) { return doc.getElementById(id); };

  /* ── boot ──────────────────────────────────────────────────────────── */

  function boot() {
    stopwatch = FR.stopwatch.create();
    stopwatch.onChange(function () { renderStopwatch(); renderResult(); renderActions(); });

    buildUnitOptions();
    wire();

    if (store.pref("disclaimerAck", "") === "yes") {
      showApp();
    } else {
      $("disclaimer").hidden = false;
    }

    setMode(mode, true);
    renderAll();
    startTicking();

    // Housekeeping that must not block first paint.
    root.setTimeout(function () {
      store.sweepOrphanPhotos();
      store.requestPersistence();
    }, 1200);

    registerServiceWorker();
    maybeOfferRecovery();
  }

  function showApp() {
    $("disclaimer").hidden = true;
    $("app").hidden = false;
  }

  /* ── wiring ────────────────────────────────────────────────────────── */

  function wire() {
    $("acknowledgeBtn").addEventListener("click", function () {
      store.setPref("disclaimerAck", "yes");
      showApp();
      renderAll();
    });

    // Mode + view switching
    each($("modeTabs").querySelectorAll("button"), function (b) {
      b.addEventListener("click", function () { setMode(b.getAttribute("data-mode")); });
    });
    each($("weirTabs").querySelectorAll("button"), function (b) {
      b.addEventListener("click", function () {
        weirTypeId = b.getAttribute("data-weir");
        store.setPref("lastWeirType", weirTypeId);
        renderWeirTabs(); renderResult(); renderActions(); renderWarnings();
      });
    });
    each(doc.querySelectorAll(".tabbar button"), function (b) {
      b.addEventListener("click", function () { setView(b.getAttribute("data-view")); });
    });

    // Stopwatch
    $("stopwatchBtn").addEventListener("click", onStopwatchButton);

    // Inputs
    $("volumeInput").addEventListener("input", onInput);
    $("headInput").addEventListener("input", onInput);
    $("manualInput").addEventListener("input", onInput);
    $("unitSelect").addEventListener("change", function () {
      unitId = $("unitSelect").value;
      store.setPref("lastVolumeUnit", unitId);
      renderVolumeField(); renderResult(); renderActions(); renderWarnings();
    });

    // Primary actions
    $("saveBtn").addEventListener("click", openSaveSheet);
    $("exportBtn").addEventListener("click", exportCurrent);
    $("clearBtn").addEventListener("click", clearCurrentMode);
    $("runningPill").addEventListener("click", function () {
      setMode(core.MODES.timedVolume.id);
    });

    // Save sheet
    $("saveCancel").addEventListener("click", closeSaveSheet);
    $("saveConfirm").addEventListener("click", confirmSave);
    $("photoBtn").addEventListener("click", function () { $("photoInput").click(); });
    $("photoRetake").addEventListener("click", function () { $("photoInput").click(); });
    $("photoRemove").addEventListener("click", clearPendingPhoto);
    $("photoInput").addEventListener("change", onPhotoChosen);

    // History
    $("exportAllBtn").addEventListener("click", toggleExportMenu);
    $("exportAllPdf").addEventListener("click", function () {
      closeExportMenu();
      FR.exporter.exportHistoryPDF(store.all());
      toast("PDF exported");
    });
    $("exportAllCsv").addEventListener("click", function () {
      closeExportMenu();
      FR.exporter.exportHistoryCSV(store.all());
      toast("CSV exported");
    });
    doc.addEventListener("click", function (e) {
      if (!$("exportMenu").hidden && !$("exportMenu").parentNode.contains(e.target)) closeExportMenu();
    });

    // Detail
    $("detailBack").addEventListener("click", function () { setView("history"); });
    $("detailSite").addEventListener("input", scheduleCommit);
    $("detailNotes").addEventListener("input", scheduleCommit);
    $("detailExport").addEventListener("click", exportDetail);
    $("detailDelete").addEventListener("click", deleteDetail);

    // About
    $("aboutBtn").addEventListener("click", openAbout);
    $("aboutClose").addEventListener("click", function () { $("aboutSheet").hidden = true; });

    // Flush a pending notes edit if the page goes away mid-typing.
    root.addEventListener("pagehide", flushCommit);
    doc.addEventListener("visibilitychange", function () {
      if (doc.visibilityState === "hidden") flushCommit();
    });
  }

  function each(nodes, fn) { Array.prototype.forEach.call(nodes, fn); }

  /* ── mode / view ───────────────────────────────────────────────────── */

  function setMode(next, silent) {
    if (!core.MODES[next]) return;
    mode = next;
    store.setPref("mode", mode);
    each($("modeTabs").querySelectorAll("button"), function (b) {
      const on = b.getAttribute("data-mode") === mode;
      b.classList.toggle("seg-on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    core.MODE_ORDER.forEach(function (id) {
      const pane = $("pane-" + id);
      if (pane) pane.hidden = id !== mode;
    });
    if (!silent) { renderAll(); }
  }

  function setView(view) {
    ["measure", "history", "detail"].forEach(function (v) {
      $("view-" + v).hidden = v !== view;
    });
    each(doc.querySelectorAll(".tabbar button"), function (b) {
      b.classList.toggle("tab-on", b.getAttribute("data-view") === view);
    });
    if (view === "history") renderHistory();
    if (view !== "detail") releaseDetailPhoto();
  }

  /* ── stopwatch ─────────────────────────────────────────────────────── */

  function onStopwatchButton() {
    const S = FR.stopwatch.STATE;
    if (stopwatch.state === S.idle) { stopwatch.start(); }
    else if (stopwatch.state === S.running) { stopwatch.stop(); }
    else { stopwatch.reset(); $("volumeInput").value = ""; }
    renderAll();
  }

  /*
   * One rAF loop drives the display. It only repaints while a timer is actually
   * running, and throttles to ~30fps -- enough for a smooth hundredths digit,
   * far less work than repainting every frame.
   */
  function startTicking() {
    let last = 0;
    function frame(ts) {
      tickHandle = root.requestAnimationFrame(frame);
      if (stopwatch.state !== FR.stopwatch.STATE.running) return;
      if (ts - last < 33) return;
      last = ts;
      renderStopwatch();
      renderRunningPill();
    }
    if (root.requestAnimationFrame) tickHandle = root.requestAnimationFrame(frame);
    else root.setInterval(function () { renderStopwatch(); renderRunningPill(); }, 100);
  }

  /*
   * A run recovered from a previous session needs a decision, exactly once.
   * After ~6 hours the elapsed time is almost certainly meaningless, so the
   * wording pushes towards discarding rather than saving something bogus.
   */
  function maybeOfferRecovery() {
    if (!stopwatch.hasUnconfirmedRecoveredRun) return;
    const elapsed = stopwatch.elapsedNow();
    const long = elapsed > 6 * 3600;
    const message = long
      ? "A timer was running when FloRun last closed, started " + fmt.formatElapsed(elapsed) +
        " ago. That is far longer than a typical measurement, so any volume you captured is " +
        "unlikely to still be meaningful. Discarding is recommended."
      : "A timer was running when FloRun last closed, started " + fmt.formatElapsed(elapsed) +
        " ago. Continue timing, stop now to lock in the elapsed time, or discard the run.";

    choose("Timer Was Running", message, [
      { id: "continue", label: "Continue Timing" },
      { id: "stop", label: "Stop Now" },
      { id: "discard", label: "Discard", danger: true },
    ]).then(function (answer) {
      if (answer === "stop") stopwatch.stop();
      else if (answer === "discard") stopwatch.discardRecovered();
      else stopwatch.acknowledgeRecovered();
      renderAll();
    });
  }

  /* ── input ─────────────────────────────────────────────────────────── */

  function onInput() { renderResult(); renderActions(); renderWarnings(); }

  function volumeNumber() { return fmt.parseDecimal($("volumeInput").value); }
  function headNumber() { return fmt.parseDecimal($("headInput").value); }
  function manualNumber() { return fmt.parseDecimal($("manualInput").value); }

  function elapsedForCalc() {
    return stopwatch.state === FR.stopwatch.STATE.stopped ? stopwatch.elapsedNow() : 0;
  }

  function liveRate() {
    if (mode === core.MODES.timedVolume.id) {
      const v = volumeNumber();
      if (v === null || !(v > 0) || !(elapsedForCalc() > 0)) return core.ZERO_RATE;
      return core.calculate(v, unitId, elapsedForCalc());
    }
    if (mode === core.MODES.weir.id) {
      const h = headNumber();
      if (h === null || !(h > 0)) return core.ZERO_RATE;
      return FR.weir.flowRate(h, weirTypeId);
    }
    const g = manualNumber();
    if (g === null || g < 0) return core.ZERO_RATE;
    return core.rateFromGPM(g);
  }

  /* Manual entry may legitimately be zero; the other modes may not. */
  function canSave() {
    const rate = liveRate();
    if (mode === core.MODES.manualEntry.id) {
      const g = manualNumber();
      return g !== null && g >= 0 && isFinite(g) &&
        isFinite(rate.gpm) && isFinite(rate.gph) && isFinite(rate.gpd);
    }
    if (mode === core.MODES.timedVolume.id) {
      const v = volumeNumber();
      return v !== null && v > 0 &&
        stopwatch.state === FR.stopwatch.STATE.stopped &&
        stopwatch.isValidElapsed() && core.rateIsValid(rate);
    }
    const h = headNumber();
    return h !== null && h > 0 && core.rateIsValid(rate);
  }

  function resultIsShowable() {
    if (mode === core.MODES.manualEntry.id) {
      const g = manualNumber();
      return g !== null && g >= 0 && isFinite(g);
    }
    return core.rateIsValid(liveRate());
  }

  function clearCurrentMode() {
    if (mode === core.MODES.timedVolume.id) { stopwatch.reset(); $("volumeInput").value = ""; }
    else if (mode === core.MODES.weir.id) { $("headInput").value = ""; }
    else { $("manualInput").value = ""; }
    renderAll();
  }

  /* ── rendering ─────────────────────────────────────────────────────── */

  function renderAll() {
    renderStopwatch();
    renderVolumeField();
    renderWeirTabs();
    renderResult();
    renderActions();
    renderWarnings();
    renderRunningPill();
  }

  function renderStopwatch() {
    const el = $("stopwatchDisplay");
    const S = FR.stopwatch.STATE;
    el.textContent = fmt.formatStopwatch(stopwatch.elapsedNow());
    el.classList.toggle("live", stopwatch.state !== S.idle);

    const btn = $("stopwatchBtn");
    btn.classList.remove("btn-start", "btn-stop", "btn-reset");
    if (stopwatch.state === S.idle) { btn.textContent = "Start"; btn.classList.add("btn-start"); }
    else if (stopwatch.state === S.running) { btn.textContent = "Stop"; btn.classList.add("btn-stop"); }
    else { btn.textContent = "Reset"; btn.classList.add("btn-reset"); }

    // Volume entry only makes sense once a run has been committed.
    $("volumeInput").disabled = stopwatch.state !== S.stopped;
    $("unitSelect").disabled = stopwatch.state !== S.stopped;
  }

  function buildUnitOptions() {
    const sel = $("unitSelect");
    sel.innerHTML = "";
    core.UNIT_ORDER.forEach(function (id) {
      const opt = doc.createElement("option");
      opt.value = id;
      opt.textContent = core.UNITS[id].displayName;
      sel.appendChild(opt);
    });
    sel.value = unitId;
  }

  function renderVolumeField() {
    const unit = core.unitFor(unitId);
    $("unitSelect").value = unitId;
    $("volumeLabel").textContent = unit.isDirectVolume ? "Volume Captured" : "Water Column Height";
    $("volumeInput").placeholder = unit.isDirectVolume ? "0.00" : "Inches";
    $("volumeHint").hidden = unit.isDirectVolume;
    $("bucketNote").hidden = unit.isDirectVolume;
  }

  function renderWeirTabs() {
    each($("weirTabs").querySelectorAll("button"), function (b) {
      const on = b.getAttribute("data-weir") === weirTypeId;
      b.classList.toggle("seg-on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  function renderResult() {
    const rate = liveRate();
    const show = resultIsShowable();
    setValue("valGPM", show ? fmt.formatFlow(rate.gpm) : "—", show);
    setValue("valGPH", show ? fmt.formatFlow(rate.gph) : "—", show);
    setValue("valGPD", show ? fmt.formatFlow(rate.gpd) : "—", show);
    $("aidFooter").hidden = !show;
  }

  function setValue(id, text, live) {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle("idle", !live);
  }

  function renderActions() {
    const enabled = canSave();
    $("saveBtn").disabled = !enabled;
    $("exportBtn").disabled = !enabled;
    let showClear;
    if (mode === core.MODES.timedVolume.id) {
      showClear = stopwatch.state !== FR.stopwatch.STATE.idle || $("volumeInput").value !== "";
    } else if (mode === core.MODES.weir.id) {
      showClear = $("headInput").value !== "";
    } else {
      showClear = $("manualInput").value !== "";
    }
    $("clearBtn").hidden = !showClear;
  }

  /* Range and sanity warnings, one per mode. */
  function renderWarnings() {
    // Bucket height above the charted maximum.
    const unit = core.unitFor(unitId);
    const v = volumeNumber();
    let volWarn = null;
    if (!unit.isDirectVolume && v !== null && v > FR.bucket.MAX_HEIGHT) {
      volWarn = "Above chart range (max " + fmt.formatVolume(FR.bucket.MAX_HEIGHT) + " in / " +
        fmt.formatVolume(FR.bucket.MAX_GALLONS) + " gal). Result clamped.";
    } else if (unit.isDirectVolume && v !== null && v > 0 &&
               core.toUSGallons(v, unitId) > 50) {
      volWarn = "That converts to about " + fmt.formatVolume(core.toUSGallons(v, unitId)) +
        " US gal — much larger than a typical field capture. Double-check the value and unit.";
    }
    setWarning("volumeWarning", volWarn);

    // Weir head outside the published table.
    const h = headNumber();
    let headWarn = null;
    if (h !== null && h > 0) {
      const min = FR.weir.minHead(weirTypeId), max = FR.weir.maxHead(weirTypeId);
      if (h > max) headWarn = "Head exceeds chart range (max " + fmt.formatVolume(max) + " in). Result clamped.";
      else if (h < min) headWarn = "Head below chart minimum (" + fmt.formatVolume(min) + " in). Treated as no flow.";
    }
    setWarning("headWarning", headWarn);

    // Implausible manual entry.
    const g = manualNumber();
    setWarning("manualWarning", (g !== null && g > 1000000)
      ? "That is far above any normal field flow rate. Double-check the value before saving."
      : null);
  }

  function setWarning(id, text) {
    const el = $(id);
    if (text) { el.textContent = text; el.hidden = false; }
    else { el.textContent = ""; el.hidden = true; }
  }

  /*
   * The stopwatch keeps running when the user switches to weir or manual mode,
   * where its display is hidden. Without this pill a forgotten timer would keep
   * the screen awake and quietly accumulate hours.
   */
  function renderRunningPill() {
    const show = mode !== core.MODES.timedVolume.id &&
      stopwatch.state === FR.stopwatch.STATE.running;
    const pill = $("runningPill");
    pill.hidden = !show;
    if (show) {
      $("runningPillText").textContent = "Timer running · " + fmt.formatElapsed(stopwatch.elapsedNow());
    }
  }

  /* ── save flow ─────────────────────────────────────────────────────── */

  function summaryRows() {
    const rows = [];
    const rate = liveRate();
    if (mode === core.MODES.timedVolume.id) {
      const unit = core.unitFor(unitId);
      const v = volumeNumber() || 0;
      rows.push(["Method", "Timed volume"]);
      rows.push(["Elapsed", fmt.formatElapsed(elapsedForCalc())]);
      rows.push([unit.isDirectVolume ? "Volume" : "Bucket Height",
        fmt.formatVolume(v) + " " + unit.inputSuffix]);
      if (!unit.isDirectVolume) {
        rows.push(["Bucket Type", unit.displayName]);
        rows.push(["US Gallons", fmt.formatGallons(core.toUSGallons(v, unitId))]);
      }
    } else if (mode === core.MODES.weir.id) {
      rows.push(["Method", "V-notch weir"]);
      rows.push(["Notch", FR.weir.typeFor(weirTypeId).shortLabel]);
      rows.push(["Head Height", fmt.formatVolume(headNumber() || 0) + " in"]);
    } else {
      rows.push(["Method", "Manual flow rate"]);
    }
    rows.push(["GPM", fmt.formatFlow(rate.gpm)]);
    rows.push(["GPH", fmt.formatFlow(rate.gph)]);
    rows.push(["GPD", fmt.formatFlow(rate.gpd)]);
    return rows;
  }

  function openSaveSheet() {
    if (!canSave()) return;
    $("saveSite").value = "";
    $("saveNotes").value = "";
    clearPendingPhoto();
    setPhotoError(null);
    $("locationStatus").innerHTML = "";
    $("locationStatus").textContent = FR.geo.isSupported()
      ? "◎ Will be captured on Save"
      : "◎ Location unavailable on this device";
    $("photoBtn").hidden = false;
    $("photoField").hidden = !FR.photos.isSupported();

    const box = $("saveSummary");
    box.innerHTML = "";
    summaryRows().forEach(function (pair) {
      const row = doc.createElement("div");
      row.className = "kv-row";
      const k = doc.createElement("span"); k.className = "k"; k.textContent = pair[0];
      const val = doc.createElement("span"); val.className = "v"; val.textContent = pair[1];
      row.appendChild(k); row.appendChild(val);
      box.appendChild(row);
    });

    saveInFlight = false;
    $("saveConfirm").disabled = false;
    $("saveSheet").hidden = false;
  }

  function closeSaveSheet() {
    if (saveInFlight) FR.geo.cancelInFlight();
    saveInFlight = false;
    clearPendingPhoto();
    $("saveSheet").hidden = true;
  }

  function onPhotoChosen(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";                 // let the same file be picked again
    if (!file) return;
    setPhotoError(null);
    $("photoBtn").disabled = true;
    FR.photos.process(file).then(function (result) {
      clearPendingPhoto();
      pendingPhoto = { blob: result.blob, url: URL.createObjectURL(result.blob) };
      $("photoImg").src = pendingPhoto.url;
      $("photoPreview").hidden = false;
      $("photoBtn").hidden = true;
    }).catch(function () {
      setPhotoError("Could not use that photo. Try again, or save without one.");
    }).then(function () {
      $("photoBtn").disabled = false;
    });
  }

  function clearPendingPhoto() {
    if (pendingPhoto) { FR.photos.revoke(pendingPhoto.url); pendingPhoto = null; }
    $("photoImg").removeAttribute("src");
    $("photoPreview").hidden = true;
    $("photoBtn").hidden = false;
  }

  function setPhotoError(text) {
    const el = $("photoError");
    if (text) { el.textContent = text; el.hidden = false; } else { el.hidden = true; }
  }

  function confirmSave() {
    if (saveInFlight || !canSave()) return;
    saveInFlight = true;
    $("saveConfirm").disabled = true;
    $("locationStatus").textContent = "◎ Capturing location…";

    FR.geo.requestSingleFix().then(function (fix) {
      $("locationStatus").textContent = fix
        ? "◎ " + fix.latitude.toFixed(4) + ", " + fix.longitude.toFixed(4)
        : "◎ Location unavailable — saved without coordinates";

      // The photo is written only after every guard has passed, so an aborted
      // save can never strand an orphaned blob.
      const photoPromise = pendingPhoto
        ? store.putPhoto(core.uuid() + ".jpg", pendingPhoto.blob).catch(function () { return null; })
        : Promise.resolve(null);

      return photoPromise.then(function (photoId) {
        const rate = liveRate();
        const fields = {
          mode: mode,
          rate: rate,
          siteLabel: trimOrNull($("saveSite").value),
          notes: trimOrNull($("saveNotes").value),
          latitude: fix ? fix.latitude : null,
          longitude: fix ? fix.longitude : null,
          locationAccuracyMeters: fix ? fix.accuracy : null,
          photoId: photoId,
        };
        if (mode === core.MODES.timedVolume.id) {
          fields.elapsedSeconds = elapsedForCalc();
          fields.volume = volumeNumber();
          fields.volumeUnit = unitId;
        } else if (mode === core.MODES.weir.id) {
          fields.weirType = weirTypeId;
          fields.headInches = headNumber();
        }

        const result = store.append(core.makeRecord(fields));
        saveInFlight = false;
        $("saveSheet").hidden = true;
        clearPendingPhoto();

        if (!result.saved) {
          toast("Could not save — device storage is full");
          return;
        }
        if (result.pruned && store.pref("pruneNoticeSeen", "") !== "yes") {
          store.setPref("pruneNoticeSeen", "yes");
          $("pruneNotice").hidden = false;
          root.setTimeout(function () { $("pruneNotice").hidden = true; }, 8000);
        }
        vibrate(12);
        toast("Measurement saved");
        clearCurrentMode();
      });
    }).catch(function () {
      saveInFlight = false;
      $("saveConfirm").disabled = false;
      toast("Could not save that measurement");
    });
  }

  function trimOrNull(s) {
    const t = String(s || "").trim();
    return t.length ? t : null;
  }

  /* ── exports ───────────────────────────────────────────────────────── */

  function currentRecord() {
    const fields = { mode: mode, rate: liveRate() };
    if (mode === core.MODES.timedVolume.id) {
      fields.elapsedSeconds = elapsedForCalc();
      fields.volume = volumeNumber();
      fields.volumeUnit = unitId;
    } else if (mode === core.MODES.weir.id) {
      fields.weirType = weirTypeId;
      fields.headInches = headNumber();
    }
    return core.makeRecord(fields);
  }

  function exportCurrent() {
    if (!canSave()) return;
    FR.exporter.exportSingle(currentRecord()).then(function () { toast("PDF exported"); });
  }

  function toggleExportMenu() {
    const menu = $("exportMenu");
    const open = menu.hidden;
    menu.hidden = !open;
    $("exportAllBtn").setAttribute("aria-expanded", open ? "true" : "false");
  }
  function closeExportMenu() {
    $("exportMenu").hidden = true;
    $("exportAllBtn").setAttribute("aria-expanded", "false");
  }

  /* ── history ───────────────────────────────────────────────────────── */

  function renderHistory() {
    const items = store.newestFirst();
    const list = $("historyList");
    list.innerHTML = "";
    $("historyEmpty").hidden = items.length > 0;
    $("exportAllBtn").disabled = items.length === 0;
    $("historyCount").textContent = items.length
      ? items.length + " of " + store.MAX_ITEMS + " saved"
      : "";

    items.forEach(function (rec) {
      const li = doc.createElement("li");
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "row-btn";

      const main = doc.createElement("div");
      main.className = "row-main";

      const when = doc.createElement("div");
      when.className = "row-when";
      when.textContent = fmt.formatTimestampList(rec.timestamp);
      if (rec.photoId) {
        const flag = doc.createElement("span");
        flag.className = "photo-flag";
        flag.textContent = "▣";
        flag.setAttribute("aria-label", "Photo attached");
        when.appendChild(flag);
      }
      main.appendChild(when);

      if (rec.siteLabel) {
        const site = doc.createElement("div");
        site.className = "row-site";
        site.textContent = rec.siteLabel;
        main.appendChild(site);
      }

      const sub = doc.createElement("div");
      sub.className = "row-sub";
      sub.textContent = describeRecord(rec);
      main.appendChild(sub);

      const rate = doc.createElement("div");
      rate.className = "row-rate";
      const n = doc.createElement("span"); n.className = "n"; n.textContent = fmt.formatFlow(rec.gpm);
      const u = doc.createElement("span"); u.className = "u"; u.textContent = "GPM";
      rate.appendChild(n); rate.appendChild(u);

      btn.appendChild(main); btn.appendChild(rate);
      btn.addEventListener("click", function () { openDetail(rec.id); });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  function describeRecord(rec) {
    if (rec.mode === core.MODES.weir.id) {
      const t = FR.weir.typeFor(rec.weirType);
      return t.shortLabel + " weir · " + fmt.formatVolume(rec.headInches) + " in head";
    }
    if (rec.mode === core.MODES.manualEntry.id) return "Manual entry";
    return "Elapsed " + fmt.formatElapsed(rec.elapsedSeconds);
  }

  /* ── detail ────────────────────────────────────────────────────────── */

  function openDetail(id) {
    const rec = store.get(id);
    if (!rec) { setView("history"); return; }
    currentDetailId = id;
    setView("detail");

    $("detailTitle").textContent = fmt.formatTimestampList(rec.timestamp);
    $("detailSite").value = rec.siteLabel || "";
    $("detailNotes").value = rec.notes || "";

    const box = $("detailFields");
    box.innerHTML = "";
    const kv = doc.createElement("div");
    kv.className = "kv";
    detailRows(rec).forEach(function (pair) {
      const row = doc.createElement("div");
      row.className = "kv-row";
      const k = doc.createElement("span"); k.className = "k"; k.textContent = pair[0];
      const v = doc.createElement("span"); v.className = "v"; v.textContent = pair[1];
      row.appendChild(k); row.appendChild(v);
      kv.appendChild(row);
    });
    box.appendChild(kv);

    releaseDetailPhoto();
    $("detailPhotoWrap").hidden = true;
    if (rec.photoId) {
      FR.photos.objectURLFor(rec.photoId).then(function (url) {
        if (!url || currentDetailId !== id) { FR.photos.revoke(url); return; }
        detailPhotoURL = url;
        $("detailPhoto").src = url;
        $("detailPhotoWrap").hidden = false;
      });
    }
  }

  function detailRows(rec) {
    const rows = [["Recorded", fmt.formatTimestampMedium(rec.timestamp)]];
    if (rec.mode === core.MODES.weir.id) {
      rows.push(["Method", "V-notch weir"]);
      rows.push(["Notch", FR.weir.typeFor(rec.weirType).displayName]);
      rows.push(["Head Height", fmt.formatVolume(rec.headInches) + " in"]);
    } else if (rec.mode === core.MODES.manualEntry.id) {
      rows.push(["Method", "Manual flow rate"]);
    } else {
      const unit = core.unitFor(rec.volumeUnit);
      rows.push(["Method", "Timed volume"]);
      rows.push(["Elapsed", fmt.formatElapsed(rec.elapsedSeconds)]);
      rows.push([unit.isDirectVolume ? "Volume" : "Bucket Height",
        fmt.formatVolume(rec.volume) + " " + unit.inputSuffix]);
      if (!unit.isDirectVolume) rows.push(["Bucket Type", unit.displayName]);
      rows.push(["US Gallons", fmt.formatGallons(core.recordVolumeInUSGallons(rec))]);
    }
    rows.push(["GPM", fmt.formatFlow(rec.gpm)]);
    rows.push(["GPH", fmt.formatFlow(rec.gph)]);
    rows.push(["GPD", fmt.formatFlow(rec.gpd)]);
    if (core.recordHasLocation(rec)) {
      rows.push(["Coordinates", rec.latitude.toFixed(4) + ", " + rec.longitude.toFixed(4)]);
      rows.push(["Accuracy", (rec.locationAccuracyMeters != null && rec.locationAccuracyMeters > 0)
        ? "±" + Math.round(rec.locationAccuracyMeters) + " m"
        : "unspecified"]);
    }
    return rows;
  }

  /* Notes edits debounce, then flush on leave -- no write per keystroke. */
  function scheduleCommit() {
    if (commitTimer) root.clearTimeout(commitTimer);
    commitTimer = root.setTimeout(flushCommit, 600);
  }

  function flushCommit() {
    if (commitTimer) { root.clearTimeout(commitTimer); commitTimer = null; }
    if (!currentDetailId) return;
    const rec = store.get(currentDetailId);
    if (!rec) return;
    const site = trimOrNull($("detailSite").value);
    const notes = trimOrNull($("detailNotes").value);
    if (rec.siteLabel === site && rec.notes === notes) return;   // nothing changed
    rec.siteLabel = site;
    rec.notes = notes;
    store.update(rec);
  }

  function exportDetail() {
    const rec = store.get(currentDetailId);
    if (!rec) return;
    flushCommit();
    FR.exporter.exportSingle(store.get(currentDetailId) || rec).then(function () {
      toast("PDF exported");
    });
  }

  function deleteDetail() {
    const rec = store.get(currentDetailId);
    if (!rec) return;
    choose("Delete this measurement?", "This cannot be undone.", [
      { id: "delete", label: "Delete", danger: true },
      { id: "cancel", label: "Cancel" },
    ]).then(function (answer) {
      if (answer !== "delete") return;
      if (commitTimer) { root.clearTimeout(commitTimer); commitTimer = null; }
      store.remove(rec.id);
      currentDetailId = null;
      releaseDetailPhoto();
      setView("history");
      toast("Measurement deleted");
    });
  }

  function releaseDetailPhoto() {
    if (detailPhotoURL) { FR.photos.revoke(detailPhotoURL); detailPhotoURL = null; }
    $("detailPhoto").removeAttribute("src");
  }

  /* ── about ─────────────────────────────────────────────────────────── */

  function openAbout() {
    $("versionLine").textContent = "FloRun " + FR.exporter.APP_VERSION + " (web)";
    $("aboutSheet").hidden = false;
    store.estimateUsage().then(function (est) {
      if (!est || !est.usage) { $("storageStatus").textContent = ""; return; }
      $("storageStatus").textContent = "Using about " + formatBytes(est.usage) +
        " of on-device storage for " + store.count() + " saved measurement" +
        (store.count() === 1 ? "" : "s") + ".";
    });
    if (root.navigator && root.navigator.storage && root.navigator.storage.persisted) {
      root.navigator.storage.persisted().then(function (p) {
        $("persistWarning").hidden = !!p;
      }).catch(function () {});
    }
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  /* ── shared chrome ─────────────────────────────────────────────────── */

  let toastTimer = null;
  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.hidden = false;
    if (toastTimer) root.clearTimeout(toastTimer);
    toastTimer = root.setTimeout(function () { el.hidden = true; }, 2600);
  }

  function vibrate(ms) {
    // Not supported on iOS Safari; harmless elsewhere.
    if (root.navigator && root.navigator.vibrate) {
      try { root.navigator.vibrate(ms); } catch (e) {}
    }
  }

  /*
   * Minimal modal used for the recovery prompt and delete confirmation.
   * Built in JS rather than markup because both are rare and each needs a
   * different set of buttons.
   */
  function choose(title, message, buttons) {
    return new Promise(function (resolve) {
      const overlay = doc.createElement("div");
      overlay.className = "overlay modal";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");

      const card = doc.createElement("div");
      card.className = "modal-card";

      const h = doc.createElement("h2");
      h.textContent = title;
      const p = doc.createElement("p");
      p.textContent = message;
      card.appendChild(h);
      card.appendChild(p);

      buttons.forEach(function (spec) {
        const b = doc.createElement("button");
        b.type = "button";
        b.className = "btn btn-block" + (spec.danger ? " btn-danger" : "");
        b.textContent = spec.label;
        b.addEventListener("click", function () {
          doc.body.removeChild(overlay);
          resolve(spec.id);
        });
        card.appendChild(b);
      });

      overlay.appendChild(card);
      doc.body.appendChild(overlay);
      const first = card.querySelector("button");
      if (first) first.focus();
    });
  }

  /* ── service worker ────────────────────────────────────────────────── */

  function registerServiceWorker() {
    if (!root.navigator || !root.navigator.serviceWorker) return;
    // Registered relative to this document, so the same files work whether the
    // app is served from a domain root or a subpath.
    root.navigator.serviceWorker.register("sw.js").catch(function () {
      // Offline support is an enhancement; failing to register is not fatal.
    });
  }

  /* ── go ────────────────────────────────────────────────────────────── */

  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(typeof self !== "undefined" ? self : this);
