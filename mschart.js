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
  const MA_PERIODS = { D: [21, 50, 200], W: [10, 40], M: [10] };
  const RS_LOOKBACK = { D: 252, W: 52, M: 12 };
  const HIT_TOLERANCE = 6;
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

  function movingAverage(values, period) {
    let sum = 0;
    return values.map((value, index) => {
      sum += Number(value);
      if (index >= period) sum -= Number(values[index - period]);
      return index >= period - 1 ? sum / period : null;
    });
  }

  /* The relative-strength line: stock close ÷ index close on shared dates,
     rescaled into the lower third of the price pane so it can share one scale. */
  function rsLine(bars, indexCloses, options = {}) {
    const map = indexCloses instanceof Map ? indexCloses : new Map(Object.entries(indexCloses || {}));
    const raw = [];
    for (const bar of bars || []) {
      const close = numeric(bar[4]);
      const index = numeric(map.get(String(bar[0])));
      if (close === null || index === null || index <= 0) continue;
      raw.push({ time: bar[0], ratio: close / index });
    }
    if (raw.length < 2) return { points: [], highs: [], note: "not enough aligned index sessions" };
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
    const lookback = options.lookback || RS_LOOKBACK.D;
    const highs = [];
    for (let index = 0; index < raw.length; index += 1) {
      const window = raw.slice(Math.max(0, index - lookback + 1), index + 1);
      if (window.length < Math.min(30, lookback) ) continue;
      if (raw[index].ratio >= Math.max(...window.map((point) => point.ratio))) {
        highs.push(points[index]);
      }
    }
    return { points, highs, note: `${points.length} aligned sessions` };
  }

  function volumeSeries(bars, period = 50) {
    const volumes = (bars || []).map((bar) => Number(bar[5]) || 0);
    const average = movingAverage(volumes, period);
    return (bars || []).map((bar, index) => ({
      time: bar[0], value: volumes[index], average: average[index],
      up: Number(bar[4]) >= Number(bar[1]),
    }));
  }

  function priceLabels(bars) {
    const highs = (bars || []).map((bar) => numeric(bar[2])).filter((value) => value !== null);
    const lows = (bars || []).map((bar) => numeric(bar[3])).filter((value) => value !== null);
    if (!highs.length || !lows.length) return { high: null, low: null };
    return { high: Math.max(...highs), low: Math.min(...lows) };
  }

  /* ── drawings ─────────────────────────────────────────────────────────────
     Drawings are stored in time/price space, never in pixels, so they survive a
     reload, a zoom and a timeframe switch. */
  let sequence = 0;
  function createDrawing(tool, points, options = {}) {
    if (!DRAW_TOOLS.includes(tool)) throw new Error(`unknown drawing tool: ${tool}`);
    sequence += 1;
    return {
      id: options.id || `d${Date.now().toString(36)}${sequence.toString(36)}`,
      tool,
      color: options.color || "#4da3ff",
      text: options.text || "",
      points: (points || []).map((point) => ({ time: String(point.time), price: Number(point.price) })),
      created: options.created || null,
    };
  }

  function snapToClose(price, bars, time) {
    const bar = (bars || []).find((entry) => String(entry[0]) === String(time));
    return bar ? Number(bar[4]) : price;
  }

  function project(drawing, adapter) {
    const points = drawing.points.map((point) => {
      const x = adapter.timeToCoordinate(point.time);
      const y = adapter.priceToCoordinate(point.price);
      return x === null || y === null || x === undefined || y === undefined ? null : { x, y };
    });
    if (points.some((point) => point === null)) return null;
    if (drawing.tool === "hline" && points.length === 1) {
      return { tool: "hline", y: points[0].y, points };
    }
    return { tool: drawing.tool, points };
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

  function hitTest(drawings, point, adapter, tolerance = HIT_TOLERANCE) {
    for (let index = (drawings || []).length - 1; index >= 0; index -= 1) {
      const drawing = drawings[index];
      const projected = project(drawing, adapter);
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
      if (a && b && distanceToSegment(point, a, b) <= tolerance) return drawing;
    }
    return null;
  }

  function moveDrawing(drawing, deltaTimeIndex, deltaPrice, times) {
    const shifted = drawing.points.map((point) => {
      const index = times.indexOf(String(point.time));
      const target = index === -1 ? index : Math.max(0, Math.min(times.length - 1, index + deltaTimeIndex));
      return {
        time: target === -1 ? point.time : times[target],
        price: point.price + deltaPrice,
      };
    });
    return { ...drawing, points: shifted };
  }

  const storageKey = (symbol) => `sepa_drawings:${String(symbol || "").toUpperCase()}`;

  function loadDrawings(symbol, storage) {
    try {
      const raw = storage.getItem(storageKey(symbol));
      const parsed = raw ? JSON.parse(raw) : null;
      const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.drawings) ? parsed.drawings : [];
      return list.filter((entry) => entry && DRAW_TOOLS.includes(entry.tool) && Array.isArray(entry.points))
        .map((entry) => createDrawing(entry.tool, entry.points, entry));
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
      .map((entry) => createDrawing(entry.tool, entry.points || [], entry));
  }

  /* ── list context and keyboard ────────────────────────────────────────── */
  function listContext(definition, symbol) {
    const symbols = (definition && definition.symbols) || [];
    const requested = Number.isInteger(definition && definition.index) ? definition.index : -1;
    const found = symbols.indexOf(String(symbol || "").toUpperCase());
    const index = found !== -1 ? found : requested >= 0 && requested < symbols.length ? requested : -1;
    return {
      id: (definition && definition.id) || null,
      title: (definition && definition.title) || null,
      symbols,
      index,
      position: index === -1 ? null : `${index + 1} of ${symbols.length}`,
      fallback: Boolean(definition && definition.fallback),
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
        panelValue("Composite Score", rating("composite").value, rating("composite").coverage_note),
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
        panelValue("Book Value", facts.book_value_multiple, notes.book_value_multiple, "×"),
        panelValue("U/D Vol Ratio", facts.ud_vol_ratio, notes.ud_vol_ratio),
        panelValue("LT Debt/Equity", facts.ltdebt_equity_pct, notes.ltdebt_equity_pct, "%"),
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
    isoWeekKey, monthKey, aggregate, movingAverage, rsLine, volumeSeries, priceLabels,
    createDrawing, snapToClose, project, hitTest, moveDrawing, distanceToSegment,
    storageKey, loadDrawings, saveDrawings, exportDrawings, importDrawings,
    listContext, advance, keyAction, panelModel, panelValue,
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = MSChart;
