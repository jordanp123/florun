/*
 * weir-chart.js -- discharge from triangular notch weirs with end contractions.
 * Pure, DOM-free.
 *
 * Unlike the bucket (a depth-to-VOLUME table needing a stopwatch), these tables
 * map head height directly to a FLOW RATE in US gallons per minute. No timing
 * is involved: read the head, read the flow.
 *
 * Values between charted heads are linearly interpolated. Heads below the first
 * charted entry read as no flow -- the published table starts at 1 inch and an
 * extrapolation below it would be invention, not measurement.
 *
 * The tables assume a correctly installed weir (sharp crest, free discharge,
 * head measured 3-4x max-head upstream, adequate approach pool, end
 * contractions, level crest). See the support page for the full conditions.
 */
(function (root) {
  "use strict";
  const FR = (root.FloRun = root.FloRun || {});

  // 90 degree V-notch: [head inches, GPM]
  const ENTRIES_90 = [
    [1.00, 2.19], [1.25, 3.83], [1.50, 6.05], [1.75, 8.89],
    [2.00, 12.4], [2.25, 16.7], [2.50, 21.7], [2.75, 27.5],
    [3.00, 34.2], [3.25, 41.8], [3.50, 50.3], [3.75, 59.7],
    [4.00, 70.2], [4.25, 81.7], [4.50, 94.2], [4.75, 108],
    [5.00, 123], [5.25, 139], [5.50, 156], [5.75, 174],
    [6.00, 193], [6.25, 214], [6.50, 236], [6.75, 260],
    [7.00, 284], [7.25, 310], [7.50, 338], [7.75, 367],
    [8.00, 397], [8.25, 429], [8.50, 462], [8.75, 498],
    [9.00, 533], [9.25, 571], [9.50, 610], [9.75, 651],
    [10.00, 694], [10.50, 784],
    [11.00, 880], [11.50, 984],
    [12.00, 1094], [12.50, 1212],
    [13.00, 1337], [13.50, 1469],
    [14.00, 1609], [14.50, 1756],
    [15.00, 1912], [15.50, 2073],
    [16.00, 2246], [16.50, 2426],
    [17.00, 2614], [17.50, 2810],
    [18.00, 3016], [18.50, 3229],
    [19.00, 3452], [19.50, 3684],
    [20.00, 3924], [20.50, 4174],
    [21.00, 4433], [21.50, 4702],
    [22.00, 4980], [22.50, 5268],
    [23.00, 5565], [23.50, 5873],
    [24.00, 6190], [24.50, 6518],
    [25.00, 6855],
  ];

  // 60 degree V-notch: [head inches, GPM]
  const ENTRIES_60 = [
    [1.00, 1.27], [1.25, 2.21], [1.50, 3.49], [1.75, 5.13],
    [2.00, 7.16], [2.25, 9.62], [2.50, 12.5], [2.75, 15.9],
    [3.00, 19.7], [3.25, 24.1], [3.50, 29], [3.75, 34.5],
    [4.00, 40.5], [4.25, 47.2], [4.50, 54.4], [4.75, 62.3],
    [5.00, 70.8], [5.25, 80], [5.50, 89.9], [5.75, 100],
    [6.00, 112], [6.25, 124], [6.50, 136], [6.75, 150],
    [7.00, 164], [7.25, 179], [7.50, 195], [7.75, 212],
    [8.00, 229], [8.25, 248], [8.50, 267], [8.75, 287],
    [9.00, 308], [9.25, 330], [9.50, 352], [9.75, 376],
    [10.00, 401], [10.50, 452],
    [11.00, 508], [11.50, 568],
    [12.00, 632], [12.50, 700],
    [13.00, 772], [13.50, 848],
    [14.00, 929], [14.50, 1014],
    [15.00, 1104], [15.50, 1197],
    [16.00, 1297], [16.50, 1401],
    [17.00, 1509], [17.50, 1623],
    [18.00, 1741], [18.50, 1864],
    [19.00, 1993], [19.50, 2127],
    [20.00, 2266], [20.50, 2410],
    [21.00, 2560], [21.50, 2715],
    [22.00, 2875], [22.50, 3041],
    [23.00, 3213], [23.50, 3391],
    [24.00, 3574], [24.50, 3763],
    [25.00, 3953],
  ];

  const TYPES = {
    v90: { id: "v90", displayName: "V-notch 90°", shortLabel: "90°", entries: ENTRIES_90 },
    v60: { id: "v60", displayName: "V-notch 60°", shortLabel: "60°", entries: ENTRIES_60 },
  };

  function typeFor(id) { return TYPES[id] || TYPES.v90; }
  function entriesFor(id) { return typeFor(id).entries; }

  function minHead(id) { const e = entriesFor(id); return e[0][0]; }
  function maxHead(id) { const e = entriesFor(id); return e[e.length - 1][0]; }

  function isInRange(inches, id) {
    const h = Number(inches);
    return isFinite(h) && h >= minHead(id) && h <= maxHead(id);
  }

  /*
   * GPM for a head height. Below the chart minimum returns 0 (treated as no
   * flow); above the maximum clamps to the last charted value.
   */
  function gpm(inches, id) {
    const table = entriesFor(id);
    const h = Number(inches);
    if (!isFinite(h) || h <= 0) return 0;
    if (h < table[0][0]) return 0;
    if (h >= table[table.length - 1][0]) return table[table.length - 1][1];

    let lo = 0, hi = table.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (table[mid][0] <= h) lo = mid; else hi = mid;
    }
    const lower = table[lo], upper = table[hi];
    const span = upper[0] - lower[0];
    if (span <= 0) return lower[1];
    const t = (h - lower[0]) / span;
    return lower[1] + t * (upper[1] - lower[1]);
  }

  /* Full rate triple from a head reading. */
  function flowRate(inches, id) {
    const perMinute = gpm(inches, id);
    if (!(perMinute > 0)) return { gpm: 0, gph: 0, gpd: 0 };
    return { gpm: perMinute, gph: perMinute * 60, gpd: perMinute * 1440 };
  }

  FR.weir = { TYPES, typeFor, minHead, maxHead, isInRange, gpm, flowRate };
})(typeof self !== "undefined" ? self : this);
