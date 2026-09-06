/* Shared, DOM-free list model for the published list pages and the local app.
 *
 * The published list JSON carries the compact rows straight from screener.json,
 * so the card view, the table view, the sort order and the CSV export all read
 * one source. Formatting lives here so the Python renderer and the browser can
 * be compared cell by cell.
 */
"use strict";
const Lists = (() => {
  const LISTS_CONTRACT_VERSION = "lists-contract-1.0";
  const PAGE_SIZE = 50;
  const PERCENT_COLUMNS = new Set(["chg_pct", "off_high", "pct_from_pivot", "pct_to_pivot",
    "eps_yoy", "dividend_yield", "rs_line_drawdown", "risk_pct"]);
  const SIGNED_COLUMNS = new Set(["chg_pct", "off_high", "group_rank_change"]);
  const RUPEE_COLUMNS = new Set(["market_cap_cr", "avg_rupee_volume_cr"]);
  const PRICE_COLUMNS = new Set(["close", "pivot", "buy_limit", "stop"]);
  const INTEGER_COLUMNS = new Set(["composite", "eps_rating", "rs_rating", "group_rank", "tt"]);
  const TEXT_COLUMNS = new Set(["symbol", "name", "group", "base_status", "stage", "entry_state",
    "ad_rating", "included_in", "surveillance", "last_date"]);
  const ASCENDING_DEFAULT = new Set(["symbol", "name", "group", "group_rank", "pct_to_pivot"]);

  const finite = (value) => typeof value === "number" && Number.isFinite(value);

  function cellValue(row, key, extras = {}) {
    const ratings = row.ratings || {};
    const facts = row.facts || {};
    const group = row.group || {};
    const base = row.base || {};
    const qualification = row.qualification || {};
    switch (key) {
      case "symbol": return row.symbol;
      case "name": return row.name;
      case "close": return row.close;
      case "chg_pct": return row.chg_pct;
      case "composite": return ratings.composite;
      case "eps_rating": return ratings.eps;
      case "rs_rating": return ratings.rs;
      case "ad_rating": return ratings.ad;
      case "group": return group.name;
      case "market_cap_cr": return facts.market_cap_cr;
      case "avg_rupee_volume_cr": return facts.avg_rupee_volume_cr;
      case "base_status": return String(base.status || "none").replace(/_/g, " ");
      case "off_high": return row.pct_off_high;
      case "pct_from_pivot": return row.pct_below_pivot;
      case "pct_to_pivot": return row.pct_to_pivot;
      case "vol_rel": return facts.rel_volume;
      case "eps_yoy": return (row.fund || {}).eps_yoy;
      case "dividend_yield": return facts.dividend_yield_pct;
      case "group_rank": return group.rank;
      case "group_rank_change":
        return finite(group.rank) && finite(group.rank_last_week) ? group.rank_last_week - group.rank : null;
      case "tt": return (row.tt || {}).passed;
      case "stage": return row.stage;
      case "entry_state": return qualification.entry_state;
      case "surveillance": return row.surveillance_text;
      case "rs_line_drawdown": return facts.rs_line_drawdown_pct;
      case "last_date": return row.last_date;
      case "included_in": return (extras.included_in || []).join(", ") || null;
      case "pivot": return (qualification.pattern || {}).pivot;
      case "buy_limit": return (qualification.pattern || {}).buy_zone_high;
      case "stop": return (qualification.pattern || {}).stop;
      case "risk_pct": return (qualification.pattern || {}).risk_pct;
      default: return null;
    }
  }

  function formatCell(row, key, extras = {}) {
    const value = cellValue(row, key, extras);
    if (value === null || value === undefined || value === "") return "–";
    if (TEXT_COLUMNS.has(key)) return String(value);
    if (!finite(Number(value))) return String(value);
    const number = Number(value);
    const sign = SIGNED_COLUMNS.has(key) && number > 0 ? "+" : "";
    if (PERCENT_COLUMNS.has(key)) return `${sign}${number.toFixed(1)}%`;
    if (RUPEE_COLUMNS.has(key)) return `₹${number.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
    if (PRICE_COLUMNS.has(key)) return `₹${number.toFixed(2)}`;
    if (INTEGER_COLUMNS.has(key)) return String(Math.round(number));
    return `${sign}${number.toFixed(2)}`;
  }

  function compare(a, b, direction) {
    const missingA = a === null || a === undefined || a === "";
    const missingB = b === null || b === undefined || b === "";
    if (missingA && missingB) return 0;
    if (missingA) return 1;   // unknown values always sink, whichever way we sort
    if (missingB) return -1;
    const numberA = Number(a);
    const numberB = Number(b);
    const both = finite(numberA) && finite(numberB);
    const result = both ? numberA - numberB : String(a).localeCompare(String(b));
    return direction === "asc" ? result : -result;
  }

  function sortRows(rows, key, direction, extrasFor = () => ({})) {
    return [...(rows || [])].sort((a, b) =>
      compare(cellValue(a, key, extrasFor(a)), cellValue(b, key, extrasFor(b)), direction)
      || String(a.symbol).localeCompare(String(b.symbol)));
  }

  function defaultDirection(key) {
    return ASCENDING_DEFAULT.has(key) ? "asc" : "desc";
  }

  function sortOptions(payload) {
    return (payload.columns || []).map((key) => ({
      key, label: (payload.column_labels || {})[key] || key, direction: defaultDirection(key),
    }));
  }

  /* Mini-chart geometry for a card: an SVG polyline over the weekly closes. */
  function sparkPath(values, width = 160, height = 44) {
    const points = (values || []).filter((value) => finite(Number(value))).map(Number);
    if (points.length < 2) return null;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    const step = width / (points.length - 1);
    return points.map((value, index) =>
      `${(index * step).toFixed(1)},${(height - ((value - min) / span) * height).toFixed(1)}`).join(" ");
  }

  function cardModel(row, spark, extras = {}) {
    return {
      symbol: row.symbol,
      name: row.name,
      href: row.has_page ? `/s/${row.symbol}.html` : "/#screener",
      close: formatCell(row, "close"),
      change: formatCell(row, "chg_pct"),
      changeClass: finite(row.chg_pct) ? (row.chg_pct > 0 ? "positive" : row.chg_pct < 0 ? "negative" : "muted") : "muted",
      ratings: [
        { label: "Composite", value: formatCell(row, "composite") },
        { label: "RS", value: formatCell(row, "rs_rating") },
        { label: "EPS", value: formatCell(row, "eps_rating") },
        { label: "A/D", value: formatCell(row, "ad_rating") },
      ],
      spark: sparkPath(spark),
      sparkPoints: (spark || []).length,
      includedIn: extras.included_in || [],
    };
  }

  /* Identical rule to Screener.csvCell: only a *text* cell can be turned into a
     spreadsheet formula, so a negative number is exported as a number. */
  function csvCell(value) {
    if (value === null || value === undefined) return "";
    let text = String(value);
    if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function csv(payload, rows) {
    const columns = payload.columns || [];
    const labels = payload.column_labels || {};
    const included = payload.included_in || {};
    const header = [`# ${payload.title}`, `# ${payload.description}`,
      `# list ${payload.id} · ${payload.count} rows · data as of ${payload.as_of || "unknown"}`,
      `# build ${payload.build_id || "unknown"}`];
    const lines = [...header, columns.map((key) => csvCell(labels[key] || key)).join(",")];
    for (const row of rows || payload.rows || []) {
      const extras = { included_in: included[row.symbol] };
      lines.push(columns.map((key) => csvCell(cellValue(row, key, extras))).join(","));
    }
    return `${lines.join("\n")}\n`;
  }

  function page(rows, size = PAGE_SIZE, index = 1) {
    const limit = Math.max(1, size) * Math.max(1, index);
    return { rows: (rows || []).slice(0, limit), more: (rows || []).length > limit, shown: Math.min(limit, (rows || []).length) };
  }

  function listLink(listId, symbols, symbol, basePath = "") {
    const index = (symbols || []).indexOf(symbol);
    const query = index === -1 ? "" : `?list=${encodeURIComponent(listId)}&i=${index}`;
    return `${basePath}/s/${symbol}.html${query}`;
  }

  return {
    contractVersion: LISTS_CONTRACT_VERSION, PAGE_SIZE, cellValue, formatCell, compare, sortRows,
    defaultDirection, sortOptions, sparkPath, cardModel, csvCell, csv, page, listLink,
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = Lists;
