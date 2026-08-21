/*
 * bucket-chart.js -- height-to-volume lookup for a standard 5-gallon bucket.
 * Pure, DOM-free.
 *
 * The relationship is NON-linear: the pail tapers, so each inch of water column
 * holds a different volume. Anything between two entries is linearly
 * interpolated.
 *
 * PROVENANCE. These values are COMPUTED, not measured and not transcribed from
 * a manufacturer's datasheet -- an earlier comment here claimed the latter and
 * was wrong. They fit the volume integral of a right circular frustum to within
 * 0.01% across all 58 rows, which is what identifies them as a geometric model.
 * The dimensions that model implies are published as MODEL below.
 *
 * WHAT THAT COSTS. Volume goes as the square of the radius, so small
 * dimensional differences produce disproportionate volume error, and real
 * pails vary by more than "a few percent": against typical 5-gallon HDPE
 * geometry this model reads roughly 6-8% low, and against a wider pail 10-12%
 * low. It sits at the SMALL end of the range, so where it is wrong it tends to
 * under-report volume, and therefore under-report flow.
 *
 * This is why MODEL is exported and shown in the UI. Telling someone to "verify
 * against your specific bucket" is not actionable unless they are also told
 * what they are verifying against.
 */
(function (root) {
  "use strict";
  const FR = (root.FloRun = root.FloRun || {});

  // [height in inches, US gallons] -- sorted ascending by height.
  const ENTRIES = [
    [0.000, 0.0],
    [0.250, 0.0851931169290715],
    [0.500, 0.170773913345133],
    [0.750, 0.256743706392521],
    [1.000, 0.343103813215573],
    [1.250, 0.429855550958625],
    [1.500, 0.517000236766012],
    [1.750, 0.604539187782078],
    [2.000, 0.692473721151153],
    [2.250, 0.780805154017572],
    [2.500, 0.869534803525678],
    [2.750, 0.958663986819803],
    [3.000, 1.04819402104429],
    [3.250, 1.13812622334347],
    [3.500, 1.22846191086167],
    [3.750, 1.31920240074325],
    [4.000, 1.41034901013254],
    [4.250, 1.50190305617386],
    [4.500, 1.59386585601156],
    [4.750, 1.68623872678998],
    [5.000, 1.77902298565345],
    [5.250, 1.87221994974631],
    [5.500, 1.96583093621289],
    [5.750, 2.05985726219754],
    [6.000, 2.15430024484458],
    [6.250, 2.24916120129837],
    [6.500, 2.34444144870322],
    [6.750, 2.44014230420349],
    [6.875, 2.488150871597],      // the "half bucket" mark on most pails
    [7.000, 2.5362650849435],
    [7.250, 2.63281110806759],
    [7.500, 2.7297816907201],
    [7.750, 2.82717815004537],
    [8.000, 2.92500180318774],
    [8.250, 3.02325396729153],
    [8.500, 3.12193595950109],
    [8.750, 3.22104909696075],
    [8.824, 3.25046947610986],
    [9.000, 3.32059469681486],
    [9.250, 3.42057407620774],
    [9.500, 3.52098855228374],
    [9.750, 3.62183944218718],
    [10.000, 3.72312806306242],
    [10.250, 3.82485573205377],
    [10.500, 3.92702376630559],
    [10.750, 4.02963348296222],
    [11.000, 4.13268619916797],
    [11.250, 4.23618323206719],
    [11.500, 4.34012589880422],
    [11.750, 4.44451551652342],
    [12.000, 4.54935340236906],
    [12.250, 4.65464087348555],
    [12.500, 4.7603792470172],
    [12.750, 4.86656984010832],
    [13.000, 4.97321396990326],
    [13.250, 5.08031295354638],   // the "5 gallon" mark on most pails
    [13.500, 5.18786810818199],
    [13.750, 5.29588075095447],
  ];

  const MAX_HEIGHT = ENTRIES[ENTRIES.length - 1][0];
  const MAX_GALLONS = ENTRIES[ENTRIES.length - 1][1];

  /*
   * The pail this table describes, recovered from the data by fitting the
   * frustum volume integral. Inside diameters. Quoted so a user can hold a tape
   * to their own bucket and know whether this chart applies to it.
   */
  const MODEL = {
    baseDiameterInches: 10.0,
    topDiameterInches: 11.3,
    heightInches: MAX_HEIGHT,
    brimGallons: MAX_GALLONS,
    summary: "10.0 in base, 11.3 in top, 13.75 in tall",
  };

  /*
   * Convert a water-column height (inches) to US gallons.
   * Non-positive or non-finite input returns 0; heights above the charted
   * maximum clamp to the maximum volume (the UI warns separately).
   */
  function gallonsForHeight(inches) {
    const h = Number(inches);
    if (!isFinite(h) || h <= 0) return 0;
    if (h >= MAX_HEIGHT) return MAX_GALLONS;

    // Binary search for the bracketing pair.
    let lo = 0, hi = ENTRIES.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ENTRIES[mid][0] <= h) lo = mid; else hi = mid;
    }
    const lower = ENTRIES[lo], upper = ENTRIES[hi];
    const span = upper[0] - lower[0];
    if (span <= 0) return lower[1];
    const t = (h - lower[0]) / span;
    return lower[1] + t * (upper[1] - lower[1]);
  }

  function isInRange(inches) {
    const h = Number(inches);
    return isFinite(h) && h >= 0 && h <= MAX_HEIGHT;
  }

  FR.bucket = { ENTRIES, MAX_HEIGHT, MAX_GALLONS, MODEL, gallonsForHeight, isInRange };
})(typeof self !== "undefined" ? self : this);
