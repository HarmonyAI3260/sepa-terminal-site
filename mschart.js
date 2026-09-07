/* Shared, DOM-free chart model for the published site and the local app.
 *
 * Everything here is arithmetic on bars plus a tiny coordinate adapter, so the
 * same module drives lightweight-charts in the browser and runs headless in the
 * Node harness. Nothing in this file touches document, window or the chart
 * library directly: the caller passes an adapter with timeToCoordinate and
 * priceToCoordinate, exactly the two functions lightweight-charts exposes.
 */
"use strict";
const MSChart = (() => {
  const MSCHART_CONTRACT_VERSION = "mschart-1.0";
  const DRAW_TOOLS = ["trend", "hline", "ray", "rect", "text"];
  const TIMEFRAMES = ["D", "W", "M"];
  /* Every moving average the reader may switch on, per timeframe. The daily set carries
     the 150-day line the SEPA Trend Template reads; the weekly 10/40 pair is the familiar
     view. Display only: no signal, score or gate reads this selection. */
  const MA_PERIODS = { D: [21, 50, 150, 200], W: [10, 40], M: [10] };
  const MA_DEFAULTS = { D: [50, 150, 200], W: [10, 40], M: [10] };
  const MA_STORAGE_KEY = "sepa_ma_periods";
  const MA_COLORS = ["#4da3ff", "#f5a623", "#d678ff", "#2ee6a8"];
  const RS_LOOKBACK = { D: 252, W: 52, M: 12 };
  /* Every overlay the reader may switch off, in the order the toolbar renders them
     (SPEC-AJ §1.1). Display only: a hidden overlay changes nothing about the row it
     came from — no screening predicate, readiness rule, rating or gate reads this. */
  const OVERLAY_STORAGE_KEY = "sepa_overlays";
  const OVERLAYS = [
    { id: "base_band", label: "Base boundaries", default: true },
    { id: "legs", label: "Contraction legs", default: true },
    { id: "rs_events", label: "RS events", default: true },
    { id: "pivot", label: "Pivot", default: true },
    { id: "stop", label: "Stop", default: true },
    { id: "risk_band", label: "Risk-approved band", default: true },
    { id: "extension", label: "5 % extension", default: true },
    { id: "geometry_pivot", label: "Geometry pivot", default: true },
    { id: "reference_52w", label: "52-week lines", default: true },
    { id: "rs_line", label: "RS line", default: true },
    { id: "index", label: "Nifty 50", default: false },
  ];
  const OVERLAY_IDS = OVERLAYS.map((entry) => entry.id);
  /* Scale and window are one stored object, because they are read together on every
     render and both survive a timeframe switch and the next stock. */
  const VIEW_STORAGE_KEY = "sepa_chart_view";
  const SCALES = ["log", "linear"];
  const WINDOW_PRESETS = [
    { id: "6M", label: "6M", bars: { D: 126, W: 26, M: 6 } },
    { id: "1Y", label: "1Y", bars: { D: 252, W: 52, M: 12 } },
    { id: "2Y", label: "2Y", bars: { D: 504, W: 104, M: 24 } },
    // "All" is the loaded history: the chart fits its own content, as it always has.
    { id: "All", label: "All", bars: null },
  ];
  const WINDOW_IDS = WINDOW_PRESETS.map((entry) => entry.id);
  const DEFAULT_VIEW = { scale: "log", window: "All" };
  /* The volume average drawn beside the bars, per timeframe, and the legend that names
     it — so the pane never shows an unlabelled line. */
  const VOLUME_PERIODS = { D: 50, W: 10, M: 10 };
  const VOLUME_UNITS = { D: "session", W: "week", M: "month" };
  // The price/volume split: the volume pane gets the bottom 26 % of the pane instead of
  // the 18 % it had, so a dry-up is legible (SPEC-AJ §1.2).
  const PRICE_SCALE_MARGINS = { top: 0.06, bottom: 0.28 };
  const VOLUME_SCALE_MARGINS = { top: 0.74, bottom: 0 };
  const HIT_TOLERANCE = 6;
  const RAY_EXTENSION = 40;   // the renderer and the hit test must agree on one factor
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const numeric = (value) => (finite(Number(value)) ? Number(value) : null);

  function isoWeekKey(day) {
    const date = new Date(`${day}T00:00:00Z`);
    const target = new Date(date);
    target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
    const start = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((target - start) / 86400000 + 1) / 7);
    return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }

  function monthKey(day) {
    return String(day).slice(0, 7);
  }

  /* Aggregate ascending daily [date, o, h, l, c, v] bars into weeks or months.
     Each period is stamped with its last observed session, so a period never
     claims a date the data does not hold. */
  function aggregate(bars, timeframe) {
    const rows = Array.isArray(bars) ? bars : [];
    if (timeframe === "D" || !timeframe) return rows.map((bar) => bar.slice(0, 6));
    const keyOf = timeframe === "W" ? isoWeekKey : monthKey;
    const out = [];
    let currentKey = null;
    for (const bar of rows) {
      const [day, open, high, low, close, volume] = bar;
      if (![open, high, low, close].every((value) => finite(Number(value)))) continue;
      const key = keyOf(day);
      if (key !== currentKey) {
        currentKey = key;
        out.push([day, Number(open), Number(high), Number(low), Number(close), Number(volume) || 0]);
      } else {
        const period = out[out.length - 1];
        period[0] = day;
        period[2] = Math.max(period[2], Number(high));
        period[3] = Math.min(period[3], Number(low));
        period[4] = Number(close);
        period[5] += Number(volume) || 0;
      }
    }
    return out;
  }

  /* The stored selection for one timeframe: known periods only, ascending; an absent or
     unreadable entry falls back to the documented default set. */
  function maSelection(stored, timeframe) {
    const periods = MA_PERIODS[timeframe] || [];
    const source = stored && typeof stored === "object" ? stored[timeframe] : undefined;
    if (!Array.isArray(source)) return (MA_DEFAULTS[timeframe] || []).slice();
    const chosen = [...new Set(source.map(Number).filter((value) => periods.includes(value)))];
    return chosen.sort((left, right) => left - right);
  }

  function maStore(stored, timeframe, periods) {
    const next = stored && typeof stored === "object" ? { ...stored } : {};
    next[timeframe] = maSelection({ [timeframe]: periods }, timeframe);
    return next;
  }

  function maColor(period, timeframe) {
    const index = (MA_PERIODS[timeframe] || []).indexOf(Number(period));
    return MA_COLORS[index === -1 ? 0 : index % MA_COLORS.length];
  }

  /* The legend text for the periods actually drawn, in the reader's own units. */
  function maLegend(periods, timeframe) {
    const unit = timeframe === "W" ? "w" : timeframe === "M" ? "m" : "d";
    const chosen = (periods || []).slice().sort((left, right) => left - right);
    return chosen.length ? `${chosen.map((period) => `${period}${unit}`).join(" / ")} MA`
      : "no moving average shown";
  }

  /* ── display preferences: overlays, scale, window (SPEC-AJ §1.1/§1.2) ──────
     All three are read from ``localStorage`` and normalised here, so a corrupt or
     hand-edited entry can never do more than fall back to the documented default. */
  function overlayState(stored) {
    const source = stored && typeof stored === "object" ? stored : {};
    const state = {};
    for (const overlay of OVERLAYS) {
      state[overlay.id] = typeof source[overlay.id] === "boolean"
        ? source[overlay.id] : overlay.default;
    }
    return state;
  }

  function overlayStore(stored, id, on) {
    if (!OVERLAY_IDS.includes(id)) return overlayState(stored);
    return { ...overlayState(stored), [id]: Boolean(on) };
  }

  function overlayLabel(id) {
    return (OVERLAYS.find((entry) => entry.id === id) || {}).label || String(id);
  }

  function viewState(stored) {
    const source = stored && typeof stored === "object" ? stored : {};
    return {
      scale: SCALES.includes(source.scale) ? source.scale : DEFAULT_VIEW.scale,
      window: WINDOW_IDS.includes(source.window) ? source.window : DEFAULT_VIEW.window,
    };
  }

  function viewStore(stored, patch) {
    return viewState({ ...viewState(stored), ...(patch && typeof patch === "object" ? patch : {}) });
  }

  /* How many bars a preset shows on one timeframe: 6M = 126 D / 26 W / 6 M and so on.
     ``All`` (and any unknown preset) returns null — the caller fits the content. */
  function windowBars(preset, timeframe) {
    const entry = WINDOW_PRESETS.find((candidate) => candidate.id === preset);
    if (!entry || !entry.bars) return null;
    return entry.bars[timeframe] || null;
  }

  /* The logical range for ``timeScale().setVisibleLogicalRange``. A window longer than
     the loaded history is not a window: the whole history is shown instead, so a young
     listing is never padded with empty space it never traded through. */
  function windowRange(preset, timeframe, barCount) {
    const wanted = windowBars(preset, timeframe);
    const bars = Number(barCount) || 0;
    if (!wanted || bars <= 0 || wanted >= bars) return null;
    return { from: bars - wanted, to: bars - 1 };
  }

  function volumeLegend(timeframe) {
    const period = VOLUME_PERIODS[timeframe] || VOLUME_PERIODS.D;
    return `Volume · ${period}-${VOLUME_UNITS[timeframe] || VOLUME_UNITS.D} average`;
  }

  /* The base as a shaded band: from ``base_start_date`` to the last bar on screen,
     between ``base_low`` and ``base_high``. Read straight from the published base —
     nothing here re-derives a base from the bars. */
  function baseBandModel(band, bars) {
    const source = band && typeof band === "object" ? band : null;
    if (!source || !Array.isArray(bars) || !bars.length) return null;
    // ``numeric`` reads null as 0; a base needs a real high and a real low or no band.
    const level = (value) => (value === null || value === undefined || value === ""
      ? null : numeric(value));
    const high = level(source.high);
    const low = level(source.low);
    const start = source.start_date ? String(source.start_date).slice(0, 10) : null;
    if (high === null || low === null || !start || high <= low) return null;
    const index = bars.findIndex((bar) => String(bar[0]).slice(0, 10) >= start);
    if (index === -1) return null;
    return {
      start: bars[index][0], end: bars[bars.length - 1][0], high, low,
      startDate: start, bars: bars.length - index,
      title: `base ${start} · ₹${low} – ₹${high}`,
    };
  }

  function movingAverage(values, period) {
    let sum = 0;
    return values.map((value, index) => {
      sum += Number(value);
      if (index >= period) sum -= Number(values[index - period]);
      return index >= period - 1 ? sum / period : null;
    });
  }

  /* The relative-strength line: stock close ÷ index close on shared dates,
     rescaled into the lower third of the price pane so it can share one scale.
     Drawing only — the economic event lives in ``rsEvents``, which always reads the
     canonical daily history rather than whatever bars are on screen. */
  function rsLine(bars, indexCloses, options = {}) {
    const map = indexCloses instanceof Map ? indexCloses : new Map(Object.entries(indexCloses || {}));
    const raw = [];
    for (const bar of bars || []) {
      const close = numeric(bar[4]);
      const index = numeric(map.get(String(bar[0])));
      if (close === null || index === null || index <= 0) continue;
      raw.push({ time: bar[0], ratio: close / index });
    }
    if (raw.length < 2) return { points: [], note: "not enough aligned index sessions" };
    const ratios = raw.map((point) => point.ratio);
    const min = Math.min(...ratios);
    const max = Math.max(...ratios);
    const prices = (bars || []).map((bar) => numeric(bar[3])).filter((value) => value !== null);
    const floor = options.floor ?? Math.min(...prices);
    const ceiling = options.ceiling ?? Math.max(...prices);
    const band = (ceiling - floor) / 3;
    const scale = max > min ? band / (max - min) : 0;
    const points = raw.map((point) => ({
      time: point.time,
      value: floor + (point.ratio - min) * scale,
      ratio: point.ratio,
    }));
    return { points, note: `${points.length} aligned sessions` };
  }

  /* A short, deterministic provenance hash (FNV-1a, two offsets → 12 hex). Not a
     cryptographic digest: it only has to change when the inputs change. */
  function fnv1a12(text) {
    let a = 0x811c9dc5;
    let b = 0x01000193;
    const source = String(text || "");
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      a = Math.imul(a ^ code, 0x01000193) >>> 0;
      b = Math.imul(b ^ (code + index), 0x85ebca6b) >>> 0;
    }
    return a.toString(16).padStart(8, "0") + (b & 0xffff).toString(16).padStart(4, "0");
  }

  /* RS-line new highs, the scanner's definition (core/scanner.py _rs_line_signals):
     aligned sessions = stock close > 0 and benchmark close > 0 on the same date;
     an event on day t = ratio_t >= max(ratio over the last `lookback` aligned sessions
     ending at t) AND at least `lookback` aligned sessions exist up to t.

     A short history therefore produces no events at all: a 31-session "high" is not a
     252-session high, and labelling it as one is what the fifth audit caught. Events are
     always computed from the daily history and the daily benchmark closes, whatever
     timeframe the chart is showing. */
  function rsEvents(dailyBars, benchmarkCloses, options = {}) {
    const lookback = Number.isFinite(Number(options.lookback)) ? Number(options.lookback) : RS_LOOKBACK.D;
    const minAligned = Number.isFinite(Number(options.minAligned)) ? Number(options.minAligned) : 200;
    const benchmark = options.benchmark || "NIFTY500";
    const map = benchmarkCloses instanceof Map
      ? benchmarkCloses : new Map(Object.entries(benchmarkCloses || {}));
    const aligned = [];
    for (const bar of dailyBars || []) {
      const close = numeric(bar[4]);
      const index = numeric(map.get(String(bar[0])));
      if (close === null || index === null || close <= 0 || index <= 0) continue;
      aligned.push({ date: String(bar[0]), ratio: close / index });
    }
    const count = aligned.length;
    const hash = fnv1a12(aligned.map((point) => `${point.date}|${point.ratio}`).join("\n"));
    const base = { events: [], aligned: count, benchmark, lookback, minAligned, input_hash: hash };
    if (count < minAligned) {
      return { ...base, status: "insufficient_alignment",
        note: `only ${count} sessions align with ${benchmark} (at least ${minAligned} are needed `
          + "before the RS line is read at all)" };
    }
    if (count < lookback) {
      return { ...base, status: "young_listing",
        note: `${count} aligned ${benchmark} sessions: RS-line markers start after ${lookback} `
          + "aligned sessions, so this listing has none yet" };
    }
    // Sliding-window maximum over the last `lookback` aligned ratios, O(n).
    const events = [];
    const queue = [];
    for (let index = 0; index < count; index += 1) {
      while (queue.length && aligned[queue[queue.length - 1]].ratio <= aligned[index].ratio) queue.pop();
      queue.push(index);
      while (queue[0] <= index - lookback) queue.shift();
      if (index >= lookback - 1 && queue[0] === index) {
        events.push({ date: aligned[index].date, ratio: aligned[index].ratio, lookback,
          observations: lookback, status: "full_history" });
      }
    }
    return { ...base, events, status: "ok",
      note: `${events.length} full-window highs over ${count} aligned ${benchmark} sessions` };
  }

  /* lightweight-charts accepts three time types: ISO strings, {year, month, day}
     BusinessDay objects and epoch seconds/milliseconds. ``readTime`` reads all three and
     answers null for anything else; ``normalizeTime`` is the strict form callers use when
     an unreadable date is a bug rather than a missing marker. Neither ever stringifies an
     object into "[object Object]". */
  function readTime(time) {
    if (time === null || time === undefined) return null;
    if (typeof time === "number" && Number.isFinite(time)) {
      const stamp = new Date(Math.abs(time) < 1e11 ? time * 1000 : time);
      return Number.isNaN(stamp.getTime()) ? null : stamp.toISOString().slice(0, 10);
    }
    if (typeof time === "object") {
      const year = Number(time.year);
      const month = Number(time.month);
      const day = Number(time.day);
      if (![year, month, day].every((value) => Number.isFinite(value))) return null;
      return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    const day = String(time).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  }

  function normalizeTime(time) {
    const day = readTime(time);
    if (day === null) {
      throw new Error(`unsupported chart time value: ${typeof time === "object"
        ? JSON.stringify(time) : String(time)}`);
    }
    return day;
  }

  /* Map RS events onto the bars actually displayed. Documented semantics: a weekly or
     monthly RS marker means at least one session in that period closed the RS line at a
     252-session high; `count` says how many. */
  function eventMarkers(events, bars, timeframe) {
    const list = Array.isArray(events) ? events : (events && events.events) || [];
    const rows = Array.isArray(bars) ? bars : [];
    if (!list.length || !rows.length) return [];
    const keyOf = timeframe === "W" ? isoWeekKey : timeframe === "M" ? monthKey : (day) => String(day);
    const periods = new Map();
    for (const bar of rows) periods.set(keyOf(String(bar[0])), String(bar[0]));
    const counts = new Map();
    for (const event of list) {
      const date = readTime(event && event.date);
      if (!date) continue;
      const time = periods.get(keyOf(date));
      if (!time) continue;
      counts.set(time, (counts.get(time) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([time, count]) => ({ time, position: "belowBar", shape: "circle", color: "#2ee6a8",
        size: 0.6, kind: "rs_event", count }))
      .sort((left, right) => (left.time < right.time ? -1 : left.time > right.time ? 1 : 0));
  }

  const MARKER_PRIORITY = { leg: 0, rs_event: 1, rs_latest: 2 };

  function markerPriority(marker) {
    const kind = marker && marker.kind;
    return Object.prototype.hasOwnProperty.call(MARKER_PRIORITY, kind) ? MARKER_PRIORITY[kind] : 3;
  }

  /* Merge marker groups into the one array lightweight-charts requires: normalised
     times, stable-sorted ascending, same-time markers ordered by kind. Throws rather
     than silently dropping a marker whose time cannot be read. */
  function sortedMarkers(...groups) {
    const flat = [];
    for (const group of groups) {
      for (const marker of group || []) {
        const time = readTime(marker && marker.time);
        if (!time) throw new Error(`marker without a valid date: ${JSON.stringify(marker) || marker}`);
        flat.push({ ...marker, time });
      }
    }
    return flat
      .map((marker, order) => ({ marker, order }))
      .sort((left, right) => (left.marker.time < right.marker.time ? -1
        : left.marker.time > right.marker.time ? 1
        : markerPriority(left.marker) - markerPriority(right.marker) || left.order - right.order))
      .map((entry) => entry.marker);
  }

  /* The guard that runs immediately before every setMarkers call. */
  function assertSortedMarkers(markers) {
    let previous = null;
    for (const marker of markers || []) {
      const time = readTime(marker && marker.time);
      if (!time) throw new Error("marker without a valid date");
      if (previous !== null && time < previous) {
        throw new Error(`marker times are not ascending: ${time} follows ${previous}`);
      }
      previous = time;
    }
    return markers || [];
  }

  function volumeSeries(bars, period = 50) {
    const volumes = (bars || []).map((bar) => Number(bar[5]) || 0);
    const average = movingAverage(volumes, period);
    return (bars || []).map((bar, index) => ({
      time: bar[0], value: volumes[index], average: average[index],
      up: Number(bar[4]) >= Number(bar[1]),
    }));
  }

  /* The extrema of whatever bars are on screen. Useful as a caption, never as a
     named level: it changes with the timeframe and the zoom, so it is deliberately
     not drawn as a price line. The named 52-week levels come from ``referenceModel``. */
  function loadedRange(bars) {
    const highs = (bars || []).map((bar) => numeric(bar[2])).filter((value) => value !== null);
    const lows = (bars || []).map((bar) => numeric(bar[3])).filter((value) => value !== null);
    if (!highs.length || !lows.length) return { high: null, low: null, bars: (bars || []).length };
    return { high: Math.max(...highs), low: Math.min(...lows), bars: bars.length };
  }

  /* The one dated 52-week reference published with the series (SPEC-AG §2.2).
     Every renderer reads this object; nothing recomputes a "52-week" level from the
     bars that happen to be loaded. */
  function referenceModel(reference) {
    const source = reference && typeof reference === "object" ? reference : null;
    const high = source ? numeric(source.high) : null;
    const low = source ? numeric(source.low) : null;
    const observations = source ? numeric(source.observations) : null;
    const expected = source ? numeric(source.expected_observations) : null;
    const status = source ? String(source.status || "unavailable") : "unavailable";
    const available = status !== "unavailable" && high !== null && low !== null;
    const short = status === "insufficient_history" && observations !== null && expected !== null;
    const suffix = short ? ` · ${observations}/${expected} sessions` : "";
    const startDate = source && source.start_date ? String(source.start_date) : null;
    const endDate = source && source.end_date ? String(source.end_date) : null;
    const window = startDate && endDate ? `${startDate} → ${endDate}` : null;
    return {
      available, status, high, low, observations, expected, startDate, endDate, window,
      asOf: source && source.as_of ? String(source.as_of) : null,
      definition: source && source.definition ? String(source.definition) : null,
      inputHash: source && source.input_hash ? String(source.input_hash) : null,
      highTitle: `52w high${suffix}`,
      lowTitle: `52w low${suffix}`,
      note: available
        ? `52-week reference (${status === "complete" ? "complete" : "short history"}): `
          + `${observations === null ? "?" : observations} of ${expected === null ? "?" : expected} `
          + `sessions${window ? `, ${window}` : ""}`
        : "52-week reference unavailable",
    };
  }

  /* True when the newest aggregated bar's period has not closed yet at ``asOf``:
     a weekly bar before Friday, or a monthly bar before the month's last day. Display
     only — no signal reads it. */
  function partialLast(bars, timeframe, asOf) {
    if (!Array.isArray(bars) || !bars.length) return false;
    if (timeframe !== "W" && timeframe !== "M") return false;
    const periods = aggregate(bars, timeframe);
    if (!periods.length) return false;
    const last = String(periods[periods.length - 1][0]);
    const keyOf = timeframe === "W" ? isoWeekKey : monthKey;
    const reference = asOf ? String(asOf).slice(0, 10) : last;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reference)) return false;
    // A later period means this one is closed, however few sessions it holds.
    if (keyOf(reference) !== keyOf(last)) return false;
    if (timeframe === "W") {
      const weekday = new Date(`${reference}T00:00:00Z`).getUTCDay() || 7;
      return weekday < 5;
    }
    const year = Number(reference.slice(0, 4));
    const month = Number(reference.slice(5, 7));
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return Number(reference.slice(8, 10)) < lastDay;
  }

  function partialLastNote(bars, timeframe, asOf) {
    if (!partialLast(bars, timeframe, asOf)) return null;
    const periods = aggregate(bars, timeframe);
    const last = String(periods[periods.length - 1][0]);
    return timeframe === "W"
      ? `last weekly bar is partial (week of ${isoWeekKey(last)}, through ${last})`
      : `last monthly bar is partial (${monthKey(last)}, through ${last})`;
  }

  /* ── drawings ─────────────────────────────────────────────────────────────
     Drawings are stored in time/price space, never in pixels, so they survive a
     reload, a zoom and a timeframe switch. */
  let sequence = 0;
  function createDrawing(tool, points, options = {}) {
    if (!DRAW_TOOLS.includes(tool)) throw new Error(`unknown drawing tool: ${tool}`);
    sequence += 1;
    const stored = (points || []).map((point) => {
      const price = Number(point && point.price);
      if (!Number.isFinite(price)) throw new Error("a drawing point needs a finite price");
      // A horizontal line is a price and nothing else: it must survive a timeframe switch
      // even when its original anchor date is not a bar in the new view. Anything dated is
      // normalised to YYYY-MM-DD here, so no stored point can hold an unreadable time.
      return tool === "hline" ? { price } : { time: normalizeTime(point.time), price };
    });
    return {
      id: options.id || `d${Date.now().toString(36)}${sequence.toString(36)}`,
      tool,
      color: options.color || "#4da3ff",
      text: options.text || "",
      points: stored,
      created: options.created || null,
    };
  }

  /* The displayed bar whose period contains ``time``: on D the last bar on or before the
     date, on W the bar stamped with that ISO week, on M the bar stamped with that month.
     ``null`` when the date precedes the first displayed bar — the drawing is then off
     screen rather than clamped onto the first candle. The drawing keeps its own date. */
  function binTime(time, bars, timeframe) {
    const day = readTime(time);
    const rows = Array.isArray(bars) ? bars : [];
    if (day === null || !rows.length) return null;
    const stamps = rows.map((bar) => String(Array.isArray(bar) ? bar[0] : bar));
    const keyOf = timeframe === "W" ? isoWeekKey : timeframe === "M" ? monthKey : null;
    if (keyOf) {
      const key = keyOf(day);
      const match = stamps.find((stamp) => keyOf(stamp) === key);
      if (match) return match;
    }
    if (day < stamps[0]) return null;
    let found = null;
    for (const stamp of stamps) {
      if (stamp <= day) found = stamp;
      else break;
    }
    return found;
  }

  function snapToClose(price, bars, time) {
    const bar = (bars || []).find((entry) => String(entry[0]) === String(time));
    return bar ? Number(bar[4]) : price;
  }

  /* ``options.bars`` and ``options.timeframe`` bin every dated point onto the bar that is
     actually on screen, so a Monday-anchored trend line still lands on the Friday-stamped
     weekly candle. Without them the stored time is used as-is. */
  function project(drawing, adapter, options = {}) {
    const bars = options.bars || null;
    const timeframe = options.timeframe || "D";
    if (drawing.tool === "hline") {
      const price = Number((drawing.points[0] || {}).price);
      const y = Number.isFinite(price) ? adapter.priceToCoordinate(price) : null;
      if (y === null || y === undefined) return null;
      // Price only: no date is consulted, so the line is drawn on every timeframe.
      return { tool: "hline", y, points: [{ x: null, y }] };
    }
    const points = drawing.points.map((point) => {
      const time = bars ? binTime(point.time, bars, timeframe) : point.time;
      if (time === null || time === undefined) return null;
      const x = adapter.timeToCoordinate(time);
      const y = adapter.priceToCoordinate(point.price);
      return x === null || y === null || x === undefined || y === undefined ? null : { x, y };
    });
    if (points.some((point) => point === null)) return null;
    return { tool: drawing.tool, points };
  }

  /* A ray is drawn from its anchor through the second point and far beyond it; the hit
     test must use the same segment the renderer draws, not just the first leg. */
  function raySegment(a, b) {
    return [a, { x: a.x + (b.x - a.x) * RAY_EXTENSION, y: a.y + (b.y - a.y) * RAY_EXTENSION }];
  }

  function distanceToSegment(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
    let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
  }

  function hitTest(drawings, point, adapter, options = {}) {
    const settings = typeof options === "number" ? { tolerance: options } : (options || {});
    const tolerance = Number.isFinite(settings.tolerance) ? settings.tolerance : HIT_TOLERANCE;
    for (let index = (drawings || []).length - 1; index >= 0; index -= 1) {
      const drawing = drawings[index];
      const projected = project(drawing, adapter, settings);
      if (!projected) continue;
      if (drawing.tool === "hline") {
        if (Math.abs(point.y - projected.y) <= tolerance) return drawing;
        continue;
      }
      if (drawing.tool === "text") {
        const [anchor] = projected.points;
        if (Math.hypot(point.x - anchor.x, point.y - anchor.y) <= tolerance * 2) return drawing;
        continue;
      }
      if (drawing.tool === "rect") {
        const [a, b] = projected.points;
        const inside = point.x >= Math.min(a.x, b.x) - tolerance && point.x <= Math.max(a.x, b.x) + tolerance
          && point.y >= Math.min(a.y, b.y) - tolerance && point.y <= Math.max(a.y, b.y) + tolerance;
        if (inside) return drawing;
        continue;
      }
      const [a, b] = projected.points;
      if (!a || !b) continue;
      const [from, to] = drawing.tool === "ray" ? raySegment(a, b) : [a, b];
      if (distanceToSegment(point, from, to) <= tolerance) return drawing;
    }
    return null;
  }

  /* Move a drawing by whole bars and a price delta. A price-only point (a horizontal
     line) keeps its shape: only its price moves. */
  function moveDrawing(drawing, deltaTimeIndex, deltaPrice, times) {
    const stamps = (times || []).map(String);
    const bars = Number(deltaTimeIndex) || 0;
    const price = Number(deltaPrice) || 0;
    const shifted = drawing.points.map((point) => {
      if (point.time === null || point.time === undefined) return { price: point.price + price };
      const index = stamps.indexOf(String(point.time));
      const target = index === -1 ? -1 : Math.max(0, Math.min(stamps.length - 1, index + bars));
      return { time: target === -1 ? point.time : stamps[target], price: point.price + price };
    });
    return { ...drawing, points: shifted };
  }

  /* One unreadable stored drawing must not take the reader's other drawings with it. */
  function safeDrawing(tool, points, options) {
    try {
      return createDrawing(tool, points, options);
    } catch {
      return null;
    }
  }

  const storageKey = (symbol) => `sepa_drawings:${String(symbol || "").toUpperCase()}`;

  function loadDrawings(symbol, storage) {
    try {
      const raw = storage.getItem(storageKey(symbol));
      const parsed = raw ? JSON.parse(raw) : null;
      const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.drawings) ? parsed.drawings : [];
      return list.filter((entry) => entry && DRAW_TOOLS.includes(entry.tool) && Array.isArray(entry.points))
        .map((entry) => safeDrawing(entry.tool, entry.points, entry))
        .filter((entry) => entry !== null);
    } catch {
      return [];
    }
  }

  function saveDrawings(symbol, drawings, storage) {
    storage.setItem(storageKey(symbol), JSON.stringify({
      version: MSCHART_CONTRACT_VERSION, symbol, drawings,
    }));
    return drawings;
  }

  function exportDrawings(symbol, drawings) {
    return JSON.stringify({ version: MSCHART_CONTRACT_VERSION, symbol, drawings }, null, 1);
  }

  function importDrawings(text) {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : parsed.drawings || [];
    return list.filter((entry) => entry && DRAW_TOOLS.includes(entry.tool))
      .map((entry) => safeDrawing(entry.tool, entry.points || [], entry))
      .filter((entry) => entry !== null);
  }

  /* ── list context and keyboard ──────────────────────────────────────────
     Version 2 (SPEC-AG §4.4): the context carries the *displayed* order, the sort that
     produced it, the build it belongs to, the route each member resolves to and the
     members this snapshot does not carry. Every link producer reads this one object, so
     sorting a list and walking it with the keyboard cannot disagree. */
  const LIST_CONTEXT_VERSION = 2;

  function listSort(sort) {
    return sort && sort.key
      ? { key: String(sort.key), direction: sort.direction === "asc" ? "asc" : "desc" }
      : null;
  }

  function listContext(definition, symbol) {
    const source = definition || {};
    const symbols = (source.symbols || []).map((entry) => String(entry));
    const requested = Number.isInteger(source.index) ? source.index : -1;
    const found = symbols.indexOf(String(symbol || "").toUpperCase());
    const index = found !== -1 ? found : requested >= 0 && requested < symbols.length ? requested : -1;
    const unresolved = (source.unresolved || []).map((entry) => String(entry));
    return {
      version: LIST_CONTEXT_VERSION,
      id: source.id || null,
      title: source.title || null,
      build_id: source.build_id || null,
      symbols,
      index,
      position: index === -1 ? null : `${index + 1} of ${symbols.length}`,
      sort: listSort(source.sort),
      pages: source.pages || null,
      unresolved,
      unresolvedNote: unresolved.length
        ? `${unresolved.length} of ${symbols.length + unresolved.length} list members are not in this snapshot`
        : null,
      fallback: Boolean(source.fallback),
    };
  }

  /* Advance through the list. At either end the move is refused and reported as
     needing confirmation, so a stray space bar never silently wraps. */
  function advance(context, step, options = {}) {
    const symbols = context.symbols || [];
    if (!symbols.length) return { ok: false, reason: "the list context is empty" };
    if (context.index === -1) return { ok: true, index: 0, symbol: symbols[0], wrapped: false };
    const target = context.index + step;
    if (target < 0 || target >= symbols.length) {
      if (!options.confirmWrap) {
        return {
          ok: false, needsConfirmation: true, wrapTo: (target + symbols.length) % symbols.length,
          reason: target < 0 ? "already at the first stock in this list"
            : "already at the last stock in this list",
        };
      }
      const wrapped = (target + symbols.length) % symbols.length;
      return { ok: true, index: wrapped, symbol: symbols[wrapped], wrapped: true };
    }
    return { ok: true, index: target, symbol: symbols[target], wrapped: false };
  }

  const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

  /* Map one keydown to an action name. Typing in a field always wins. */
  function keyAction(event) {
    const target = event && event.target;
    if (target && (TYPING_TAGS.has(target.tagName) || target.isContentEditable)) return null;
    if (event.metaKey || event.ctrlKey || event.altKey) return null;
    const key = event.key;
    if (key === " " || key === "Spacebar" || key === "Space") return event.shiftKey ? "prev" : "next";
    if (key === "ArrowRight") return "next";
    if (key === "ArrowLeft") return "prev";
    if (key === "Home") return "first";
    if (key === "End") return "last";
    if (key === "Escape") return "cancel";
    if (key === "Delete" || key === "Backspace") return "delete";
    const upper = String(key || "").toUpperCase();
    if (TIMEFRAMES.includes(upper)) return `timeframe:${upper}`;
    if (upper === "P") return "panel";
    if (upper === "L") return "list";
    // SPEC-AK §1.4: F opens the full-screen chart workspace from a stock route, and
    // toggles the browser's native full screen inside the workspace itself.
    if (upper === "F") return "fullscreen";
    if (key === "/") return "search";
    if (/^[1-9]$/.test(upper)) return `tab:${Number(upper)}`;
    return null;
  }

  /* ── data panel model ─────────────────────────────────────────────────── */
  function panelValue(label, value, reason, suffix = "") {
    const missing = value === null || value === undefined || value === "";
    return {
      label,
      value: missing ? null : value,
      display: missing ? "n/a" : `${value}${suffix}`,
      reason: missing ? (reason || "not available in this snapshot") : null,
    };
  }

  /* ``99 · partial (no EPS)`` — the composite never appears without its input set. */
  function compositeDisplay(composite) {
    const entry = composite || {};
    if (entry.value === null || entry.value === undefined) return null;
    const missing = (entry.missing || []).map((name) => String(name).toUpperCase());
    return `${entry.value} · ${entry.basis || "unknown basis"}`
      + (missing.length ? ` (no ${missing.join(", ")})` : "");
  }

  function panelModel(payload) {
    const ratings = (payload && payload.ratings) || {};
    const facts = (payload && payload.facts) || {};
    const notes = (payload && payload.facts_notes) || {};
    const group = ratings.group_rank || {};
    const pe = facts.pe_range_5y || null;
    const rating = (key) => (ratings[key] || {});
    const own = (payload && payload.ownership) || {};
    return {
      annual: (payload && payload.annual) || [],
      ratings: [
        panelValue("Composite (custom)", compositeDisplay(rating("composite")),
          rating("composite").coverage_note),
        panelValue("Composite (full-evidence)", rating("composite_full").value,
          rating("composite_full").coverage_note),
        panelValue("EPS Rating", rating("eps_rating").value, rating("eps_rating").coverage_note),
        panelValue("Price Strength", rating("rs_rating").value, rating("rs_rating").coverage_note),
        panelValue("Acc/Dis Rating", rating("ad_rating").value, rating("ad_rating").coverage_note),
        panelValue("Group Rank", group.value === null || group.value === undefined ? null
          : `${group.value} − ${group.of}`, group.coverage_note),
        panelValue("EPS Growth Rate", rating("eps_growth_rate").value,
          rating("eps_growth_rate").coverage_note, "%"),
        panelValue("Earnings Stability", rating("earnings_stability").value,
          rating("earnings_stability").coverage_note),
        panelValue("P/E Ratio", facts.pe, notes.pe),
        panelValue("5-Year P/E Range", pe ? `${pe.low} – ${pe.high}` : null, notes.pe_range_5y),
        panelValue("Return on Equity", facts.roe_pct, notes.roe_pct, "%"),
        panelValue("Cash Flow (₹/share)", facts.cash_flow_per_share, notes.cash_flow_per_share),
      ],
      ratios: [
        panelValue("Yield", facts.dividend_yield_pct, notes.dividend_yield_pct, "%"),
        panelValue("Price/Book", facts.book_value_multiple, notes.book_value_multiple, "×"),
        panelValue("Book value/share (₹, derived)", facts.book_value_per_share,
          notes.book_value_per_share),
        panelValue("U/D Vol Ratio", facts.ud_vol_ratio, notes.ud_vol_ratio),
        panelValue("Debt/Equity (total borrowings)", facts.ltdebt_equity_pct,
          notes.ltdebt_equity_pct, "%"),
        panelValue("Alpha", facts.alpha, notes.alpha, "%"),
        panelValue("Beta", facts.beta, notes.beta),
      ],
      ownership: [
        panelValue("Mgmt %", (own.promoter || {}).latest, "no promoter shareholding row", "%"),
        panelValue("Banks %", null, "banks are not reported separately in our shareholding source"),
        panelValue("Funds %", facts.institutional_pct, notes.institutional_pct, "%"),
        panelValue("No. of Funds", null, "n/a (no fund-holdings feed)"),
      ],
      topRs: (payload && payload.top_rs_in_group) || [],
      quarters: ((payload && payload.quarters) || []).slice(-8).reverse(),
      estimatesNote: "No estimate rows: this build has no estimate feed.",
    };
  }

  return {
    contractVersion: MSCHART_CONTRACT_VERSION, DRAW_TOOLS, TIMEFRAMES, MA_PERIODS, RS_LOOKBACK,
    MA_DEFAULTS, MA_STORAGE_KEY, MA_COLORS, maSelection, maStore, maColor, maLegend,
    OVERLAYS, OVERLAY_IDS, OVERLAY_STORAGE_KEY, overlayState, overlayStore, overlayLabel,
    VIEW_STORAGE_KEY, SCALES, WINDOW_PRESETS, WINDOW_IDS, DEFAULT_VIEW, viewState, viewStore,
    windowBars, windowRange, VOLUME_PERIODS, volumeLegend,
    PRICE_SCALE_MARGINS, VOLUME_SCALE_MARGINS, baseBandModel,
    isoWeekKey, monthKey, aggregate, movingAverage, rsLine, volumeSeries,
    loadedRange, referenceModel, partialLast, partialLastNote,
    fnv1a12, rsEvents, readTime, normalizeTime, eventMarkers, sortedMarkers, assertSortedMarkers,
    createDrawing, snapToClose, project, hitTest, moveDrawing, distanceToSegment,
    binTime, raySegment, RAY_EXTENSION, HIT_TOLERANCE,
    storageKey, loadDrawings, saveDrawings, exportDrawings, importDrawings,
    LIST_CONTEXT_VERSION, listSort, listContext, advance, keyAction, panelModel, panelValue,
    compositeDisplay,
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = MSChart;
