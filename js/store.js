/*
 * store.js -- persistence. Mirrors the iOS split:
 *   history  -> localStorage  (was Documents/history.json)
 *   photos   -> IndexedDB     (was Documents/photos/*.jpg)
 *
 * Why split rather than put everything in IndexedDB: the history is a small
 * bounded JSON array (25 records, a few KB) that every screen reads
 * synchronously, and keeping it synchronous removes a whole class of ordering
 * bugs from the UI. Photos are megabyte-scale binaries that have no business in
 * localStorage's string quota, so they live in IndexedDB where blobs belong.
 *
 * The 25-record cap and its photo cleanup are enforced here, exactly as
 * HistoryStore did: prune the oldest on overflow and delete its photo, so
 * storage stays flat forever without the user maintaining anything.
 *
 * Corruption handling matches the iOS quarantine: unparseable history is moved
 * aside under a timestamped key rather than silently overwritten, so a support
 * conversation can still recover it.
 */
(function (root) {
  "use strict";
  const FR = (root.FloRun = root.FloRun || {});

  const HISTORY_KEY = "florun.history";
  const MAX_ITEMS = 25;

  const DB_NAME = "florun";
  const DB_VERSION = 1;
  const PHOTO_STORE = "photos";

  /* ── history (localStorage) ────────────────────────────────────────── */

  let cache = null;

  function ls() {
    try { return root.localStorage; } catch (e) { return null; }
  }

  function load() {
    if (cache) return cache;
    const store = ls();
    if (!store) { cache = []; return cache; }
    const raw = store.getItem(HISTORY_KEY);
    if (!raw) { cache = []; return cache; }
    try {
      const parsed = JSON.parse(raw);
      cache = Array.isArray(parsed) ? parsed.filter(isPlausibleRecord) : [];
    } catch (e) {
      quarantine(raw);
      cache = [];
    }
    return cache;
  }

  /*
   * A record that survived JSON.parse can still be junk (hand-edited storage,
   * a half-written value from a killed tab). Drop anything without the fields
   * every screen assumes, rather than letting it render as NaN downstream.
   */
  function isPlausibleRecord(r) {
    return r && typeof r === "object" &&
      typeof r.id === "string" &&
      typeof r.timestamp === "string" &&
      isFinite(r.gpm) && isFinite(r.gph) && isFinite(r.gpd);
  }

  function quarantine(raw) {
    const store = ls();
    if (!store) return;
    try {
      store.setItem(HISTORY_KEY + ".corrupted-" + Date.now(), raw);
      store.removeItem(HISTORY_KEY);
    } catch (e) { /* out of quota: nothing useful left to do */ }
  }

  function persist() {
    const store = ls();
    if (!store) return false;
    try {
      store.setItem(HISTORY_KEY, JSON.stringify(cache || []));
      return true;
    } catch (e) {
      return false; // quota exceeded / private mode
    }
  }

  function all() { return load().slice(); }

  function newestFirst() {
    return load().slice().sort(function (a, b) {
      return new Date(b.timestamp) - new Date(a.timestamp);
    });
  }

  function get(id) {
    const items = load();
    for (let i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }

  function count() { return load().length; }

  /*
   * Append a record. Returns { saved, pruned } -- `pruned` is true when the cap
   * forced the oldest record out, which the UI surfaces once per install.
   * Photos belonging to pruned records are deleted here, not by the caller.
   */
  function append(record) {
    const items = load();
    items.push(record);
    let pruned = false;
    if (items.length > MAX_ITEMS) {
      // Oldest by timestamp, not by insertion order -- a record saved with an
      // older timestamp should still be the one to go.
      items.sort(function (a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });
      const drop = items.splice(0, items.length - MAX_ITEMS);
      pruned = drop.length > 0;
      drop.forEach(function (r) { if (r.photoId) deletePhoto(r.photoId); });
    }
    cache = items;
    return { saved: persist(), pruned: pruned };
  }

  function update(record) {
    const items = load();
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === record.id) { items[i] = record; cache = items; return persist(); }
    }
    return false;
  }

  function remove(id) {
    const items = load();
    const keep = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === id) {
        if (items[i].photoId) deletePhoto(items[i].photoId);
      } else {
        keep.push(items[i]);
      }
    }
    cache = keep;
    return persist();
  }

  function clearAll() {
    const items = load();
    items.forEach(function (r) { if (r.photoId) deletePhoto(r.photoId); });
    cache = [];
    return persist();
  }

  /* ── photos (IndexedDB) ────────────────────────────────────────────── */

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
      const req = root.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(PHOTO_STORE)) db.createObjectStore(PHOTO_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("IndexedDB open failed")); };
      req.onblocked = function () { reject(new Error("IndexedDB blocked")); };
    });
    return dbPromise;
  }

  function putPhoto(id, blob) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        tx.objectStore(PHOTO_STORE).put(blob, id);
        tx.oncomplete = function () { resolve(id); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("photo write aborted")); };
      });
    });
  }

  function getPhoto(id) {
    if (!id) return Promise.resolve(null);
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(PHOTO_STORE, "readonly");
        const req = tx.objectStore(PHOTO_STORE).get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    }).catch(function () { return null; });   // a missing photo must never break a screen
  }

  /* Fire-and-forget: an orphaned blob is harmless, a thrown error is not. */
  function deletePhoto(id) {
    if (!id) return Promise.resolve();
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        tx.objectStore(PHOTO_STORE).delete(id);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
      });
    }).catch(function () {});
  }

  /*
   * Sweep blobs no record references. The per-delete cleanup above already
   * covers the normal paths; this catches the leftovers from an interrupted
   * save (photo written, then the tab closed before the record landed).
   * Runs once at startup -- the web counterpart of the iOS temp-file sweep.
   */
  function sweepOrphanPhotos() {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        const referenced = {};
        load().forEach(function (r) { if (r.photoId) referenced[r.photoId] = true; });
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        const store = tx.objectStore(PHOTO_STORE);
        const req = store.getAllKeys();
        req.onsuccess = function () {
          (req.result || []).forEach(function (key) {
            if (!referenced[key]) store.delete(key);
          });
        };
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
      });
    }).catch(function () {});
  }

  /* ── preferences (localStorage, tiny scalars) ──────────────────────── */

  function pref(key, fallback) {
    const store = ls();
    if (!store) return fallback;
    const v = store.getItem("florun." + key);
    return v === null ? fallback : v;
  }

  function setPref(key, value) {
    const store = ls();
    if (!store) return;
    try { store.setItem("florun." + key, String(value)); } catch (e) {}
  }

  function removePref(key) {
    const store = ls();
    if (!store) return;
    try { store.removeItem("florun." + key); } catch (e) {}
  }

  /*
   * Ask the browser to keep our data. Without this, iOS Safari may evict a
   * PWA's storage after ~7 days of non-use -- which for a field log means
   * losing measurements. Installing to the Home Screen plus a granted
   * persistence request is the strongest guarantee the platform offers.
   */
  function requestPersistence() {
    if (!root.navigator || !root.navigator.storage || !root.navigator.storage.persist) {
      return Promise.resolve(false);
    }
    return root.navigator.storage.persisted().then(function (already) {
      if (already) return true;
      return root.navigator.storage.persist();
    }).catch(function () { return false; });
  }

  function estimateUsage() {
    if (!root.navigator || !root.navigator.storage || !root.navigator.storage.estimate) {
      return Promise.resolve(null);
    }
    return root.navigator.storage.estimate().catch(function () { return null; });
  }

  FR.store = {
    MAX_ITEMS,
    all, newestFirst, get, count, append, update, remove, clearAll,
    putPhoto, getPhoto, deletePhoto, sweepOrphanPhotos,
    pref, setPref, removePref,
    requestPersistence, estimateUsage,
    // exposed for tests
    _isPlausibleRecord: isPlausibleRecord,
    _reset: function () { cache = null; },
  };
})(typeof self !== "undefined" ? self : this);
