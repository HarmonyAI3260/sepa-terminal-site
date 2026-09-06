/* SEPA Terminal standalone static site */
"use strict";

const $ = (id) => document.getElementById(id);
const fmt = (value, digits = 1) => value === null || value === undefined || Number.isNaN(Number(value))
  ? "–"
  : Number(value).toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const signed = (value, suffix = "%") => value === null || value === undefined
  ? "–"
  : `${Number(value) > 0 ? "+" : ""}${fmt(value)}${suffix}`;
const cls = (value) => value === null || value === undefined
  ? "muted" : Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "muted";
const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
})[character]);

function siteUrl(path) {
  if (!String(path).startsWith("/")) return path;
  const basePath = document.documentElement.dataset.basePath || "";
  return `${basePath}${path}`;
}

const REFRESH_OWNER = "sepa_refresh_owner";

function initRefresh() {
  // The refresh console lives on the trigger's origin; the site only links to it.
  // Visitors don't see the link: it appears when the page is opened at #refresh
  // (remembered in this browser) so a shared link stays clean.
  const control = $("refresh-control");
  if (!control) return;
  let owner = false;
  try {
    if (window.location.hash === "#refresh") localStorage.setItem(REFRESH_OWNER, "1");
    owner = localStorage.getItem(REFRESH_OWNER) === "1";
  } catch {}
  control.hidden = !owner;
}

const FILTER_DEFAULTS = Screener.defaults;
const FILTER_KEY = "sepa_screener_filters";
const SEPA_LABELS = {
  trend: "Trend", fundamentals: "Fundamentals", catalyst: "Catalyst", entry: "Entry", exit: "Exit",
};
let scanData = null;
let visibleRows = [];
const PAGE_SIZE = 100;
let scanPage = 0;
let scanLoadPromise = null;
let turnoverWasSaved = false;
let filters = loadFilters();

function loadFilters() {
  let saved = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(FILTER_KEY) || "null");
    if (parsed && typeof parsed === "object") saved = parsed;
  } catch {}
  turnoverWasSaved = Object.prototype.hasOwnProperty.call(saved, "turnover");
  const loaded = Screener.normalize(saved);
  if (!["8/8", "≥7", "≥6", "All"].includes(loaded.tier)) loaded.tier = "8/8";
  const sortKeys = ["symbol", "close", "chg_pct", "rs", "tt", "stage", "pct_off_high", "pct_above_low", "turnover_cr", "fund", "sepa", "base", "pivot"];
  if (!sortKeys.includes(loaded.sortKey)) loaded.sortKey = "tt";
  if (!["asc", "desc"].includes(loaded.sortDir)) loaded.sortDir = "desc";
  loaded.stages = Array.isArray(loaded.stages)
    ? loaded.stages.map(String).filter((value) => ["1", "2", "3", "4"].includes(value))
    : ["2"];
  return loaded;
}

function saveFilters() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(Screener.normalize(filters))); } catch {}
}

function baseStatus(base) {
  const explicit = String(base?.status || "");
  if (["forming", "near_pivot", "breakout", "extended", "failed"].includes(explicit)) return explicit;
  if (!base?.in_base) return "none";
  const below = base.pct_below_pivot;
  return below !== null && below !== undefined && below >= 0 && below <= 5 ? "near_pivot" : "forming";
}

function stageNumber(row) {
  const match = String(row.stage || "").match(/Stage (\d)/);
  return match ? Number(match[1]) : null;
}

function shortStage(stage) {
  const text = String(stage || "");
  const match = text.match(/Stage (\d)/);
  return match ? match[1] + (/early/i.test(text) ? " early" : "") : "–";
}

function rankDelta(value) {
  if (value === null || value === undefined) return "–";
  return `${value > 0 ? "+" : ""}${Number(value).toFixed(0)}`;
}

function renderFilterControls() {
  $("scan-ready").title = Screener.readyExplanation;
  $("scan-accelerating").title = Screener.predicateLabels.accelerating;
  document.querySelectorAll(".playbook-presets button[data-preset]").forEach((button) =>
    button.classList.toggle("active", Screener.activePreset(filters, button.dataset.preset, scanData?.meta || {})));
  document.querySelectorAll("#scan-tier button[data-tier]").forEach((button) =>
    button.classList.toggle("active", button.dataset.tier === filters.tier));
  document.querySelectorAll("#scan-stages button[data-stage]").forEach((button) =>
    button.classList.toggle("active", filters.stages.includes(button.dataset.stage)));
  $("scan-rs").value = filters.rs ?? 0;
  $("scan-turnover").value = filters.turnover ?? "";
  $("scan-in-base").checked = Boolean(filters.inBase);
  $("scan-near-pivot").checked = Boolean(filters.nearPivot);
  $("scan-breakout").checked = Boolean(filters.breakout);
  $("scan-recent-breakout").checked = Boolean(filters.recentBreakout);
  $("scan-power-play").checked = Boolean(filters.powerPlay);

  $("scan-tightening").checked = Boolean(filters.tightening);
  $("scan-sales-yoy").value = filters.salesYoy ?? "";
  $("scan-pat-yoy").value = filters.patYoy ?? "";
  $("scan-accelerating").checked = Boolean(filters.accelerating);
  [["scan-proper-vcp", "properVcp"], ["scan-ready", "ready"], ["scan-forming", "forming"],
    ["scan-current-only", "currentOnly"], ["scan-unknown-rs", "includeUnknownRs"]].forEach(([id, key]) => $(id).checked = Boolean(filters[key]));
  $("scan-min-history").value = filters.minHistory ?? "";
  document.querySelectorAll('input[name="scan-growth"]').forEach(input => {
    input.checked = input.value === filters.growthMode;
    if (input.value === "code33") input.title = Screener.predicateLabels.code33Lite;
  });
  renderCoverage();
  $("scan-new").checked = Boolean(filters.isNew);
  $("scan-rs-line-nh").checked = Boolean(filters.rsLineNh);
  $("scan-search").value = filters.query || "";
}

function applyPreset(name) {
  turnoverWasSaved = name !== "reset" || scanData !== null;
  filters = Screener.preset(name, scanData?.meta || {});
  saveFilters();
  renderFilterControls();
  renderRows();
}

function sortValue(row, key) {
  if (key === "tt") return row.tt?.passed;
  if (key === "stage") return stageNumber(row);
  if (key === "base") return row.base?.in_base ? row.base.depth_pct : null;
  if (key === "pivot") return Screener.distance(row.close, Screener.displayedPivot(row));
  if (key === "fund") return row.fund?.code33_lite === true
    ? 1000000 : Math.min(row.fund?.sales_yoy ?? -1000000, row.fund?.pat_yoy ?? -1000000);
  if (key === "sepa") return row.sepa?.score;
  if (key === "symbol") return String(row.symbol || "");
  return row[key];
}

function compareValues(a, b, direction) {
  const aNull = a === null || a === undefined || (typeof a === "number" && Number.isNaN(a));
  const bNull = b === null || b === undefined || (typeof b === "number" && Number.isNaN(b));
  if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1;
  const result = typeof a === "string"
    ? a.localeCompare(b, undefined, { sensitivity: "base" }) : Number(a) - Number(b);
  return direction === "desc" ? -result : result;
}

function filteredRows() {
  if (!Screener.availability(filters, scanData).evaluable) return [];
  const rows = (scanData?.rows || []).filter(row => Screener.matches(row, filters, scanData?.meta || {}));
  const key = filters.sortKey;
  return rows.sort((a, b) => {
    let result = compareValues(sortValue(a, key), sortValue(b, key), filters.sortDir);
    if (!result && key === "tt") result = compareValues(a.rs, b.rs, "desc");
    return result || compareValues(String(a.symbol || ""), String(b.symbol || ""), "asc");
  });
}

function baseText(row) {
  const base = row.base || {};
  const status = baseStatus(base);
  if (status === "none" && !(base.contraction_count > 0) && row.power_play?.flag !== true) return "–";
  const tags = { forming: "form", near_pivot: "near", breakout: "BO", extended: "ext", failed: "fail" };
  let text = row.power_play?.flag === true ? "PP·" : "";
  text += `${tags[status] || status}·${fmt(base.depth_pct)}%·${base.contraction_count || 0}c`;
  if (base.vcp_trend_qualified === true) text += "·VCP";
  if (base.pivot_grade === "cheat") text += "·cheat";
  if (base.pivot_grade === "low") text += "·low-pivot";
  if (base.volume_dryup_ratio_10v50 !== null && base.volume_dryup_ratio_10v50 !== undefined
      && base.volume_dryup_ratio_10v50 < 0.8) text += `·dry ${fmt(base.volume_dryup_ratio_10v50, 2)}`;
  return text;
}

function fundHtml(fund) {
  if (fund && !Screener.usableFund({fund})) return `<span class="muted" title="${esc(`financial history ends ${fund.period_end || fund.latest_period || 'unknown'} — not current`)}">${esc(fund.status || 'unknown')}</span>`;
  if (!fund) return '<span class="muted">–</span>';
  const value = (number) => number === null || number === undefined ? "–" : `${number > 0 ? "+" : ""}${fmt(number, 0)}%`;
  const star = fund.code33_lite === true ? `<span class="fund-star" title="${esc(`Code 33-lite: ${Screener.predicateLabels.code33Lite}`)}">★</span>` : "";
  return `<span title="${esc(`Financial period ${fund.period_end || fund.latest_period || "–"} · ${fund.status || "unknown"}`)}">S${value(fund.sales_yoy)}·P${value(fund.pat_yoy)}${star}</span>`;
}

function sepaHtml(sepa) {
  if (!sepa) return '<span class="muted">–</span>';
  const dots = Object.keys(SEPA_LABELS).map((key) => {
    const item = sepa[key] || {};
    const state = item.ok === true ? "pass" : item.ok === false ? "fail" : "unknown";
    const detail = item.title ? ` — ${item.title}` : "";
    return `<span class="scan-dot ${state}" title="${esc(`${SEPA_LABELS[key]}: ${item.text || "–"}${detail}`)}"></span>`;
  }).join("");
  return `<b>${fmt(sepa.score, 0)}/5</b><span class="sepa-dots">${dots}</span>`;
}

function rsHtml(row) {
  const rank = row.rs === null || row.rs === undefined ? "–" : fmt(row.rs, 0);
  let delta = "";
  if (row.rs_chg_1w !== null && row.rs_chg_1w !== undefined) {
    const value = Number(row.rs_chg_1w);
    const mark = value > 0 ? `▲${Math.abs(value)}` : value < 0 ? `▼${Math.abs(value)}` : "·0";
    delta = `<span class="rs-delta ${cls(value)}" title="${esc(`RS rank Δ: 1w ${rankDelta(row.rs_chg_1w)} · 1m ${Screener.monthDelta(row, scanData?.meta || {})}`)}">${mark}</span>`;
  }
  const star = row.rs_line_nh_before_price === true
    ? '<span class="rs-early-leadership" title="RS line at a 52-week high before price">★</span>' : "";
  return `<b title="${esc(`1m ${Screener.monthDelta(row, scanData?.meta || {})}`)}">${rank}</b>${delta}${star}`;
}

function pivotDisplay(row) {
  const value = Screener.distance(row.close, Screener.displayedPivot(row));
  return { className: value < -5 ? "negative" : value >= 0 && value <= 3 ? "near-pivot" : "",
    text: value === null ? "–" : Screener.distanceText(value) };
}

function renderCoverage() {
  const coverage = Screener.coverage(scanData);
  const blocked = Screener.availability(filters, scanData).blocked;
  const rs = $("scan-rs-line-nh"), fresh = $("scan-new");
  rs.disabled = !coverage.rsUsable && !filters.rsLineNh;
  rs.title = `RS-line NH: ${coverage.rsKnown} known of ${coverage.total}; ${coverage.rsUsable} at snapshot date`;
  fresh.disabled = !coverage.previous && !filters.isNew;
  fresh.title = coverage.previous ? `Compared with ${scanData.meta.prev_as_of}` : "New needs a previous distinct price session";
  for (const [control, key] of [[rs, "rsLineNh"], [fresh, "isNew"]]) {
    const missing = blocked.find(item => item.key === key);
    control.classList.toggle("blocked", !!missing);
    if (missing) control.title = `${missing.reason}. ${control.title}`;
  }
  $("scan-coverage").textContent = `RS-line NH: ${coverage.rsKnown} known / ${coverage.total} (${coverage.rsUsable} current) · RS Δ1m ${Screener.monthDelta({}, scanData?.meta || {})}`;
}

function renderRows(resetPage = true) {
  if (!scanData) { loadScreener(); return; }
  visibleRows = filteredRows();
  const blocked = Screener.availability(filters, scanData).blocked;
  const blockedText = blocked.map(item => item.reason).join("; ");
  if (resetPage) scanPage = 0;
  const pages = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  scanPage = Math.max(0, Math.min(scanPage, pages - 1));
  const first = scanPage * PAGE_SIZE;
  const pageRows = visibleRows.slice(first, first + PAGE_SIZE);
  $("scan-page-status").textContent = visibleRows.length
    ? `Rows ${first + 1}–${first + pageRows.length} of ${visibleRows.length} · page ${scanPage + 1}/${pages}`
    : blocked.length ? `0 rows · blocked: ${blockedText}` : "0 matching rows";
  $("scan-prev").disabled = scanPage === 0;
  $("scan-next").disabled = scanPage >= pages - 1;
  const meta = scanData.meta || {};
  const eight = (scanData.rows || []).filter((row) => row.tt?.passed === 8).length;
  const ready = (scanData.rows || []).filter((row) => row.qualification?.ready === true).length;
  $("scan-count").textContent = `Universe ${fmt(meta.universe_total, 0)} · scanned ${fmt(meta.scanned, 0)} · 8/8: ${fmt(eight, 0)} · ready: ${fmt(ready, 0)} · shown: ${fmt(visibleRows.length, 0)}`;
  renderFilterControls();
  $("scan-count").textContent += ` · ${Screener.coverageText(scanData, filters)}`;
  if (blocked.length) {
    $("scan-count").textContent = `0 rows · blocked: ${blockedText}`;
    for (const item of blocked) {
      const button = document.createElement("button");
      button.id = `scan-remove-${item.key}`;
      button.type = "button"; button.textContent = "Remove condition";
      button.title = `Remove ${item.label}`;
      button.addEventListener("click", () => { filters[item.key] = false; saveFilters(); renderRows(); });
      $("scan-count").appendChild(button);
    }
  } else if (!visibleRows.length) {
    $("scan-count").textContent = `0 matching rows · ${Screener.coverageText(scanData, filters)}`;
  }
  $("scan-results-body").innerHTML = pageRows.map((row) => {
    const base = row.base || {};
    const dots = (row.tt?.checks || []).map((check) => {
      const state = check.pass === true ? "pass" : check.pass === false ? "fail" : "unknown";
      return `<span class="scan-dot ${state}" title="${esc(`${check.label || ""}: ${check.detail || ""}`)}"></span>`;
    }).join("");
    const newBadge = row.new_since_prev ? '<span class="new-badge">NEW</span>' : "";
    const staleBadge = row.stale === true ? `<span class="stale-badge" title="${esc(`stale — last data ${row.last_date || "unknown"}`)}">●</span>` : "";
    const pivot = pivotDisplay(row);
    const symbol = String(row.symbol || "");
    const symbolMarkup = row.has_page
      ? `<a class="scan-symbol" href="${siteUrl(`/s/${encodeURIComponent(symbol)}.html`)}">${esc(symbol)}</a>`
      : `<span class="scan-symbol scan-symbol-static" title="Deep dive not included for this row">${esc(symbol)}</span>`;
    return `<tr class="${row.stale === true ? "scan-row-stale" : ""}">
      <td>${symbolMarkup}${newBadge}${staleBadge}<span class="scan-name" title="${esc(row.name || "")}">${esc(row.name || "")}</span></td>
      <td>₹${fmt(row.close, 2)}</td><td class="${cls(row.chg_pct)}">${signed(row.chg_pct)}</td>
      <td class="${row.rs_young ? "young-rs" : ""}">${rsHtml(row)}</td>
      <td><b>${fmt(row.tt?.passed, 0)}/8</b><span class="tt-dots">${dots}</span></td>
      <td title="${esc(row.stage || "")}">${esc(shortStage(row.stage))}</td>
      <td class="${cls(row.pct_off_high)}">${signed(row.pct_off_high)}</td><td>${fmt(row.pct_above_low)}</td>
      <td class="${row.turnover_pass === false ? "turnover-fail" : ""}">${fmt(row.turnover_cr)}</td>
      <td class="scan-fund ${row.fund ? "" : "muted"}">${fundHtml(row.fund)}</td>
      <td class="scan-sepa">${sepaHtml(row.sepa)}</td>
      <td title="${esc(JSON.stringify(base, null, 2))}">${esc(baseText(row))}</td><td class="${pivot.className}">${pivot.text}</td>
      <td><a class="scan-tv" href="https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(symbol)}" target="_blank" rel="noopener noreferrer" title="Open TradingView" aria-label="Open ${esc(symbol)} in TradingView">↗</a></td>
    </tr>`;
  }).join("") || '<tr><td colspan="14" class="scan-no-results"><b>No rows match the active filters.</b><span>Reset the playbook or broaden one of the thresholds.</span></td></tr>';
  if (blocked.length) $("scan-results-body").innerHTML = `<tr><td colspan="14" class="scan-no-results">Screen blocked: ${esc(blockedText)}</td></tr>`;
  document.querySelectorAll("#scan-results th[data-sort]").forEach((header) => {
    const active = header.dataset.sort === filters.sortKey;
    header.classList.toggle("sort-active", active);
    header.setAttribute("aria-sort", active ? filters.sortDir === "asc" ? "ascending" : "descending" : "none");
    header.textContent = header.dataset.label + (active ? filters.sortDir === "asc" ? " ↑" : " ↓" : "");
  });
  $("scan-export-tv").disabled = !visibleRows.length;
  $("scan-export-csv").disabled = !visibleRows.length && !blocked.length;
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportCsv() {
  downloadText("sepa-screener.csv", Screener.csv(visibleRows, filters, scanData?.meta || {}, Screener.availability(filters, scanData).blocked), "text/csv;charset=utf-8");
}

function bindScreener() {
  $("scan-prev").addEventListener("click", () => { scanPage -= 1; renderRows(false); });
  $("scan-next").addEventListener("click", () => { scanPage += 1; renderRows(false); });
  document.querySelectorAll(".playbook-presets button[data-preset]").forEach((button) =>
    button.addEventListener("click", () => applyPreset(button.dataset.preset)));
  document.querySelectorAll("#scan-tier button[data-tier]").forEach((button) =>
    button.addEventListener("click", () => { filters.tier = button.dataset.tier; saveFilters(); renderFilterControls(); renderRows(); }));
  document.querySelectorAll("#scan-stages button[data-stage]").forEach((button) =>
    button.addEventListener("click", () => {
      const stage = button.dataset.stage;
      filters.stages = filters.stages.includes(stage) ? filters.stages.filter((value) => value !== stage) : [...filters.stages, stage];

      saveFilters(); renderFilterControls(); renderRows();
    }));
  [["scan-rs", "rs"], ["scan-turnover", "turnover"], ["scan-sales-yoy", "salesYoy"], ["scan-pat-yoy", "patYoy"], ["scan-min-history", "minHistory"]].forEach(([id, key]) =>
    $(id).addEventListener("input", (event) => {
      filters[key] = event.target.value === "" ? (key === "rs" ? 0 : null) : Number(event.target.value);
      if (key === "turnover") turnoverWasSaved = true;
      saveFilters(); renderRows();
    }));
  [["scan-in-base", "inBase"], ["scan-near-pivot", "nearPivot"], ["scan-breakout", "breakout"],
    ["scan-recent-breakout", "recentBreakout"], ["scan-power-play", "powerPlay"], ["scan-forming", "forming"], ["scan-proper-vcp", "properVcp"], ["scan-ready", "ready"], ["scan-current-only", "currentOnly"], ["scan-unknown-rs", "includeUnknownRs"],
    ["scan-tightening", "tightening"], ["scan-accelerating", "accelerating"],
    ["scan-new", "isNew"], ["scan-rs-line-nh", "rsLineNh"]].forEach(([id, key]) =>
    $(id).addEventListener("change", (event) => { filters[key] = event.target.checked; saveFilters(); renderFilterControls(); renderRows(); }));
  document.querySelectorAll('input[name="scan-growth"]').forEach(input => input.addEventListener("change", () => {
    filters.growthMode = input.value; saveFilters(); renderRows();
  }));
  $("scan-search").addEventListener("input", (event) => { filters.query = event.target.value; saveFilters(); renderRows(); });
  document.querySelectorAll("#scan-results th[data-sort]").forEach((header) =>
    header.addEventListener("click", () => {
      const key = header.dataset.sort;
      filters.sortDir = filters.sortKey === key ? filters.sortDir === "asc" ? "desc" : "asc" : key === "symbol" ? "asc" : "desc";
      filters.sortKey = key; saveFilters(); renderRows();
    }));
  $("scan-export-tv").addEventListener("click", () => {
    if (!visibleRows.length || !Screener.availability(filters, scanData).evaluable) return;
    downloadText("sepa-tradingview-watchlist.txt", visibleRows.map((row) => `NSE:${row.symbol}`).join(","), "text/plain;charset=utf-8");
  });
  $("scan-export-csv").addEventListener("click", exportCsv);
}

function loadScreener() {
  if (scanData) return Promise.resolve();
  if (scanLoadPromise) return scanLoadPromise;
  $("scan-load").disabled = true;
  $("scan-count").textContent = "Loading screener…";
  scanLoadPromise = (async () => {
    try {
      const response = await fetch(siteUrl("/data/screener.json"), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data?.rows)) throw new Error("Snapshot has no row list");
      scanData = data;
      filters = Screener.forSnapshot(filters, scanData);
      saveFilters();
      if (!turnoverWasSaved) {
        filters.turnover = scanData.meta?.params?.turnover_gate_cr ?? null;
        turnoverWasSaved = true;
        saveFilters();
      }
      $("scan-load").hidden = true;
      renderFilterControls();
      renderRows();
    } catch (error) {
      scanData = null;
      visibleRows = [];
      $("scan-count").textContent = "Screener data unavailable";
      $("scan-results-body").innerHTML = `<tr><td colspan="14" class="scan-no-results negative"><b>Could not load screener data.</b><span>${esc(error.message)}</span></td></tr>`;
      $("scan-load").hidden = false;
      $("scan-load").disabled = false;
      $("scan-load").textContent = "Retry loading screener";
    } finally {
      scanLoadPromise = null;
    }
  })();
  return scanLoadPromise;
}

function initScreener() {
  bindScreener();
  renderFilterControls();
  $("scan-load").addEventListener("click", loadScreener);
  document.querySelectorAll("[data-preset-jump]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.presetJump;
    applyPreset(key);
    $("screener").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  if (!("IntersectionObserver" in window)) { loadScreener(); return; }
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      observer.disconnect();
      loadScreener();
    }
  }, { rootMargin: "200px" });
  observer.observe($("screener"));
}

function initNavigation() {
  const backToTop = document.querySelector(".back-to-top");
  const updateTop = () => backToTop?.classList.toggle("visible", window.scrollY > 600);
  updateTop();
  window.addEventListener("scroll", updateTop, { passive: true });
  if (document.body.dataset.page !== "screener" || !("IntersectionObserver" in window)) return;
  const links = new Map([...document.querySelectorAll("nav [data-section]")].map((link) => [link.dataset.section, link]));
  const observer = new IntersectionObserver((entries) => {
    const active = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!active) return;
    links.forEach((link, id) => link.classList.toggle("active", id === active.target.id));
  }, { rootMargin: "-22% 0px -66%", threshold: [0, 0.1, 0.35] });
  document.querySelectorAll("#playbook, #funnel, #screener, #market").forEach((section) => observer.observe(section));
}

function movingAverage(values, period) {
  let sum = 0;
  return values.map((value, index) => {
    sum += Number(value);
    if (index >= period) sum -= Number(values[index - period]);
    return index >= period - 1 ? sum / period : null;
  });
}

async function initStock() {
  const container = $("chart");
  let config;
  try {
    config = JSON.parse($("stock-data").textContent);
  } catch {
    container.innerHTML = '<div class="chart-loading negative">Invalid chart configuration.</div>';
    return;
  }
  let bars;
  try {
    const response = await fetch(siteUrl(config.seriesPath), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const series = await response.json();
    bars = Array.isArray(series) ? series : series.bars;
    if (series.note) {
      const note = document.createElement("p");
      note.className = "fineprint"; note.textContent = series.note;
      container.parentElement.appendChild(note);
    }
  } catch (error) {
    container.innerHTML = `<div class="chart-loading muted">Price series missing from this snapshot: ${esc(error.message)}</div>`;
    return;
  }
  if (!Array.isArray(bars) || !bars.length) {
    container.innerHTML = '<div class="chart-loading muted">Price series missing from this snapshot.</div>';
    return;
  }
  if (typeof LightweightCharts === "undefined") {
    container.innerHTML = '<div class="chart-loading muted">Chart library unavailable. Technical tables and snapshot figures remain available.</div>';
    return;
  }
  container.innerHTML = '<div class="chart-host"></div><div class="buy-zone-band" aria-hidden="true"><span>Risk-approved entry band</span></div>';
  const host = container.querySelector(".chart-host");
  const band = container.querySelector(".buy-zone-band");
  const chart = LightweightCharts.createChart(host, {
    layout: { background: { color: "transparent" }, textColor: "#8a97a8", fontFamily: "IBM Plex Mono, monospace" },
    grid: { vertLines: { color: "#1d2733" }, horzLines: { color: "#1d2733" } },
    rightPriceScale: { borderColor: "#2a3542", scaleMargins: { top: 0.08, bottom: 0.18 } },
    timeScale: { borderColor: "#2a3542", timeVisible: false, rightOffset: 4 },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    height: Math.max(420, container.clientHeight), autoSize: true,
  });
  const candles = chart.addCandlestickSeries({
    upColor: "#2ee6a8", downColor: "#ef5350", wickUpColor: "#2ee6a8", wickDownColor: "#ef5350", borderVisible: false,
  });
  candles.setData(bars.map(([time, open, high, low, close]) => ({ time, open, high, low, close })));
  const volume = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" } });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  volume.setData(bars.map(([time, open, , , close, value]) => ({
    time, value, color: close >= open ? "rgba(46,230,168,.35)" : "rgba(239,83,80,.35)",
  })));
  const closes = bars.map((bar) => bar[4]);
  [[50, "#4da3ff"], [150, "#f5a623"], [200, "#d678ff"]].forEach(([period, color]) => {
    const series = chart.addLineSeries({ color, lineWidth: 1.4, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const values = movingAverage(closes, period);
    series.setData(bars.map((bar, index) => values[index] === null ? null : { time: bar[0], value: values[index] }).filter(Boolean));
  });
  const pattern = config.qualification?.pattern || {};
  const pivot = pattern.id ? pattern.pivot : null;
  if (Number.isFinite(pivot)) candles.createPriceLine({ price: pivot, color: "#2ee6a8", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "pivot" });
  if (pattern.id && Number.isFinite(pattern.extension_limit)) candles.createPriceLine({ price: pattern.extension_limit, color: "#f5a623", lineWidth: 1, lineStyle: 2, title: "5% extension limit" });
  const reference = config.reference_pattern?.pivot ?? (!pattern.id ? config.geometry_pivot : null);
  if (Number.isFinite(reference)) candles.createPriceLine({ price: reference, color: "#f5a623", lineWidth: 1, lineStyle: 2, title: config.reference_pattern ? "power play · flag forming" : "geometry pivot" });
  candles.setMarkers(Screener.legMarkers(config.reference_pattern ? [] : config.legs, bars.map(bar => bar[0])));
  const stop = pattern.id ? pattern.stop : null;
  if (Number.isFinite(stop)) candles.createPriceLine({ price: stop, color: "#ef5350", lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: "stop" });
  const positionBand = () => {
    if (!Number.isFinite(pivot) || !Number.isFinite(pattern.buy_zone_high) || pattern.buy_zone_high <= pivot) { band.hidden = true; return; }
    const upper = candles.priceToCoordinate(pattern.buy_zone_high);
    const lower = candles.priceToCoordinate(pivot);
    if (upper === null || lower === null) { band.hidden = true; return; }
    band.hidden = false;
    band.style.top = `${Math.min(upper, lower)}px`;
    band.style.height = `${Math.abs(lower - upper)}px`;
  };
  chart.timeScale().fitContent();
  chart.timeScale().subscribeVisibleLogicalRangeChange(positionBand);
  new ResizeObserver(positionBand).observe(host);
  requestAnimationFrame(() => requestAnimationFrame(positionBand));
}

initRefresh();
initNavigation();
if (document.body.dataset.page === "screener") initScreener();
if (document.body.dataset.page === "stock") initStock();

// Progressive web app: keeps the last snapshot readable offline and satisfies the
// installability criteria the Android wrapper (Trusted Web Activity) expects.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator &&
    typeof window !== "undefined" && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(siteUrl("/sw.js"), { scope: siteUrl("/") }).catch(() => {});
  });
}
