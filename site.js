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

// One atomic build: the page, the screener JSON and every series carry the same
// build id. A mixed pair is shown, never silently rendered as if it agreed.
let buildMismatch = null;

function checkBuildId(dataBuildId, priceDate) {
  const page = String(document.documentElement.dataset.buildId || "");
  const data = String(dataBuildId || "");
  if (!page || !data || page === data) return false;
  buildMismatch = { data, page, priceDate: priceDate || null };
  const banner = $("build-mismatch");
  if (banner) {
    banner.hidden = false;
    banner.textContent = `Data build ${data} \u2260 page build ${page} \u2014 reload to get matching versions.`
      + (priceDate ? ` The loaded data prices ${priceDate}.` : " The loaded data has no price date.");
  }
  for (const id of ["scan-export-tv", "scan-export-csv"]) {
    const control = $(id);
    if (control) {
      control.disabled = true;
      control.title = `Exports are disabled: data build ${data} does not match page build ${page}`;
    }
  }
  return true;
}

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
// SPEC-AF §5: the six grouped categories compose with the shared screener contract.
const CATEGORY_KEY = "sepa_screener_categories";
let categories = loadCategories();

function loadCategories() {
  try {
    return ScreenFilters.normalize(JSON.parse(localStorage.getItem(CATEGORY_KEY) || "null"));
  } catch { return ScreenFilters.defaults(); }
}

function saveCategories() {
  try { localStorage.setItem(CATEGORY_KEY, JSON.stringify(ScreenFilters.normalize(categories))); }
  catch { /* private mode: the filters still apply for this session */ }
}

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
  if (!ScreenFilters.availability(categories, scanData).evaluable) return [];
  const rows = (scanData?.rows || []).filter(row =>
    Screener.matches(row, filters, scanData?.meta || {}) && ScreenFilters.matches(row, categories));
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
  const categoryLine = $("category-coverage");
  if (categoryLine) categoryLine.textContent = ScreenFilters.coverageText(scanData?.rows || [], categories, scanData);
}

function renderRows(resetPage = true) {
  if (!scanData) { loadScreener(); return; }
  visibleRows = filteredRows();
  const blocked = [...Screener.availability(filters, scanData).blocked,
    ...ScreenFilters.availability(categories, scanData).blocked];
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
    // Every scanned row has a destination: the deep dive when it has one, the generic
    // technical view otherwise.
    const symbolMarkup = `<a class="scan-symbol${row.has_page ? "" : " scan-symbol-technical"}" `
      + `href="${esc(Lists.stockHref(symbol, basePath(), row))}"`
      + `${row.has_page ? "" : ' title="Technical view: this row has no financial deep dive"'}`
      + `>${esc(symbol)}</a>`;
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
  $("scan-export-tv").disabled = !visibleRows.length || !!buildMismatch;
  $("scan-export-csv").disabled = (!visibleRows.length && !blocked.length) || !!buildMismatch;
  if (buildMismatch) checkBuildId(buildMismatch.data, buildMismatch.priceDate);
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
  if (buildMismatch) return;
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
    if (buildMismatch || !visibleRows.length || !Screener.availability(filters, scanData).evaluable) return;
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
      checkBuildId(data?.meta?.build_id, data?.meta?.as_of);
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
  initCategories();
  // ?q=SYM prefills the search box, so a symbol that has no page is never dropped when
  // the technical view sends the reader back here.
  const requested = new URLSearchParams(window.location.search).get("q");
  if (requested) {
    const search = $("scan-search");
    if (search) search.value = requested;
    filters.query = requested;
    saveFilters();
  }
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

/* ── MarketSmith-parity stock page: chart, data panel, drawings, list nav ── */
const PANEL_KEY = "sepa_panel_open";
const TIMEFRAME_KEY = "sepa_timeframe";
const LIST_CONTEXT_KEY = "sepa_list_context";
const DEFAULT_LIST = "growth-50";

async function fetchJson(path) {
  const response = await fetch(siteUrl(path), { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function pageBuildId() {
  return String((document.documentElement.dataset || {}).buildId || "");
}

function basePath() {
  return (document.documentElement.dataset || {}).basePath || "";
}

/* The route manifest: which symbols own a full research page and which resolve through
   the generic technical route. Fetched once per page, then held in memory. */
let routePages = null;
let routesPromise = null;

async function loadRoutes(path = "/data/routes.json") {
  if (routePages) return routePages;
  if (!routesPromise) {
    routesPromise = fetchJson(path).then((payload) => {
      const map = {};
      for (const symbol of payload.full || []) map[String(symbol)] = "full";
      for (const symbol of payload.technical || []) map[String(symbol)] = "technical";
      routePages = map;
      return map;
    }).catch(() => { routePages = {}; return routePages; });
  }
  return routesPromise;
}

function parseSortParam(value) {
  const text = String(value || "");
  const separator = text.lastIndexOf(":");
  if (separator <= 0) return null;
  const key = text.slice(0, separator);
  const direction = text.slice(separator + 1);
  if (!/^[A-Za-z0-9_]+$/.test(key)) return null;
  if (direction !== "asc" && direction !== "desc") return null;
  return { key, direction };
}

function readListParams() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("list");
  const index = Number.parseInt(params.get("i"), 10);
  const sort = parseSortParam(params.get("sort"));
  if (id) return { id, index: Number.isInteger(index) ? index : -1, sort, fallback: false };
  try {
    const stored = JSON.parse(sessionStorage.getItem(LIST_CONTEXT_KEY) || "null");
    // A session entry from another contract version or another build is discarded, not
    // migrated: it would point into an order this build no longer publishes.
    const usable = stored && stored.id && stored.version === MSChart.LIST_CONTEXT_VERSION
      && (!stored.build_id || !pageBuildId() || stored.build_id === pageBuildId());
    if (usable) {
      return { id: stored.id, index: Number.isInteger(stored.index) ? stored.index : -1,
        sort: MSChart.listSort(stored.sort), fallback: false };
    }
  } catch { /* a corrupt session entry is simply no context */ }
  return { id: DEFAULT_LIST, index: -1, sort: null, fallback: true };
}

async function loadListContext(symbol) {
  const requested = readListParams();
  // "my:<id>" is one of the reader's own lists: it lives in this browser, not in the
  // published snapshot, so it is read from the store instead of fetched. Its routes come
  // from the published route manifest, because an imported symbol may be anything.
  if (String(requested.id).startsWith("my:")) {
    const list = MyLists.get(lists(), String(requested.id).slice(3));
    if (list) {
      const pages = await loadRoutes();
      const context = MSChart.listContext({ id: requested.id, title: list.title,
        build_id: pageBuildId(), symbols: list.items.map((item) => item.symbol),
        index: requested.index, sort: requested.sort, pages }, symbol);
      context.fallback = false;
      return context;
    }
    return { version: MSChart.LIST_CONTEXT_VERSION, id: null, title: null, symbols: [], index: -1,
      position: null, sort: null, pages: null, unresolved: [], fallback: true,
      error: `${requested.id} is not a list in this browser` };
  }
  try {
    const payload = await fetchJson(`/data/lists/${requested.id}.json`);
    const rows = payload.rows || [];
    const present = new Set(rows.map((row) => String(row.symbol)));
    const pages = {};
    for (const row of rows) pages[String(row.symbol)] = row.page || (row.has_page ? "full" : "technical");
    // The context follows what the reader is looking at: the sorted order when a sort is
    // set, otherwise the published order, in both cases only over rows this build carries.
    const extrasFor = (row) => ({ included_in: (payload.included_in || {})[row.symbol] });
    const published = (payload.symbols || []).map(String);
    const symbols = !rows.length ? published
      : requested.sort
        ? Lists.sortRows(rows, requested.sort.key, requested.sort.direction, extrasFor)
          .map((row) => String(row.symbol))
        : published.filter((entry) => present.has(entry));
    const context = MSChart.listContext(
      { id: payload.id, title: payload.title, build_id: payload.build_id, symbols,
        index: requested.index, sort: requested.sort, pages,
        unresolved: payload.missing_symbols || [] },
      symbol);
    context.fallback = requested.fallback;
    return context;
  } catch {
    return { version: MSChart.LIST_CONTEXT_VERSION, id: null, title: null, symbols: [], index: -1,
      position: null, sort: null, pages: null, unresolved: [], fallback: true,
      error: `list ${requested.id} is not published in this snapshot` };
  }
}

function renderListNav(context) {
  const label = $("list-position");
  if (!label) return;
  if (!context.symbols.length) {
    label.textContent = context.error || "no list context";
    return;
  }
  const suffix = context.fallback ? ` · default list (${context.title || context.id})`
    : ` in ${context.title || context.id}`;
  const sorted = context.sort ? ` · sorted by ${context.sort.key} ${context.sort.direction}` : "";
  const unresolved = context.unresolvedNote ? ` · ${context.unresolvedNote}` : "";
  label.textContent = (context.position ? `${context.position}${suffix}`
    : `not in ${context.title || context.id}`) + sorted + unresolved;
}

function gotoListEntry(context, result) {
  if (!result.ok) {
    const label = $("list-position");
    if (label && result.needsConfirmation) {
      label.textContent = `${result.reason} — press again to wrap`;
      label.dataset.confirmWrap = "1";
    }
    return false;
  }
  try {
    sessionStorage.setItem(LIST_CONTEXT_KEY, JSON.stringify({
      version: MSChart.LIST_CONTEXT_VERSION, id: context.id, sort: context.sort,
      index: result.index, build_id: pageBuildId(),
    }));
  } catch { /* private mode: navigation still works through the query string */ }
  window.location.href = Lists.listLink(context.id, context.symbols, result.symbol, basePath(),
    { sort: context.sort, pages: context.pages });
  return true;
}

function bindListNavigation(context) {
  const move = (step) => {
    const label = $("list-position");
    const confirmWrap = label?.dataset.confirmWrap === "1";
    const result = MSChart.advance(context, step, { confirmWrap });
    if (label) delete label.dataset.confirmWrap;
    gotoListEntry(context, result);
  };
  $("list-prev")?.addEventListener("click", () => move(-1));
  $("list-next")?.addEventListener("click", () => move(1));
  $("list-open")?.addEventListener("click", () => toggleListDrawer(context));
  return move;
}

function toggleListDrawer(context) {
  let drawer = $("list-drawer");
  if (drawer) { drawer.hidden = !drawer.hidden; return; }
  drawer = document.createElement("aside");
  drawer.id = "list-drawer";
  drawer.className = "list-drawer";
  const items = context.symbols.map((symbol, index) =>
    `<li${index === context.index ? ' class="current"' : ""}><a href="${esc(Lists.listLink(
      context.id, context.symbols, symbol, basePath(),
      { sort: context.sort, pages: context.pages }))}">${esc(symbol)}</a></li>`).join("");
  drawer.innerHTML = `<h3>${esc(context.title || context.id || "List")}</h3><ol>${items}</ol>`;
  document.body.appendChild(drawer);
  drawer.querySelector("li.current")?.scrollIntoView({ block: "center" });
}

function bindTabs() {
  const tabs = [...document.querySelectorAll("#stock-tabs a[data-tab]")];
  if (!tabs.length) return () => {};
  const activate = (anchor) => {
    tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === anchor));
    document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  tabs.forEach((tab) => tab.addEventListener("click", () => activate(tab.dataset.tab)));
  return (index) => { const tab = tabs[index - 1]; if (tab) activate(tab.dataset.tab); };
}

function panelOpen() {
  try { return localStorage.getItem(PANEL_KEY) !== "0"; } catch { return true; }
}

function setPanel(open) {
  document.querySelector(".chart-layout")?.classList.toggle("panel-hidden", !open);
  $("toggle-panel")?.setAttribute("aria-pressed", String(open));
  try { localStorage.setItem(PANEL_KEY, open ? "1" : "0"); } catch { /* private mode */ }
}

function storedTimeframe() {
  try { return MSChart.TIMEFRAMES.includes(localStorage.getItem(TIMEFRAME_KEY)) ? localStorage.getItem(TIMEFRAME_KEY) : "W"; }
  catch { return "W"; }
}

async function initStock() {
  const container = $("chart");
  let config;
  try {
    config = JSON.parse($("stock-data").textContent);
  } catch {
    if (container) container.innerHTML = '<div class="chart-loading negative">Invalid chart configuration.</div>';
    return;
  }
  const symbol = String(config.symbol || "");
  initStockActions(config);
  const context = await loadListContext(symbol);
  renderListNav(context);
  const move = bindListNavigation(context);
  const gotoTab = bindTabs();
  setPanel(panelOpen());
  $("toggle-panel")?.addEventListener("click", () => setPanel(document.querySelector(".chart-layout")?.classList.contains("panel-hidden")));
  await initChart(config, context, { container, move, gotoTab });
}

/* One chart initialiser for both stock routes (SPEC-AG §4.3).

   ``config`` is the full page's ``#stock-data`` payload or the equivalent assembled from
   ``data/stock/<SYM>.json`` on the technical page; ``mount`` carries the chart container
   and the two page callbacks (list navigation and tab activation). When
   ``config.weeklyPath`` is null the weekly view is aggregated from the same daily
   history, so both pages read one canonical series. */
async function initChart(config, context, mount = {}) {
  const container = mount.container || $("chart");
  const move = typeof mount.move === "function" ? mount.move : () => {};
  const gotoTab = typeof mount.gotoTab === "function" ? mount.gotoTab : () => {};
  const symbol = String(config.symbol || "");
  if (!container) return;

  let daily = [];
  let weekly = [];
  let seriesReference = null;
  let indexCloses = new Map();
  let rsCloses = new Map();
  try {
    const series = await fetchJson(config.seriesPath);
    daily = Array.isArray(series) ? series : series.bars || [];
    seriesReference = Array.isArray(series) ? null : series.reference || null;
    checkBuildId(series.build_id, daily.length ? daily[daily.length - 1][0] : null);
    if (series.note) {
      const note = document.createElement("p");
      note.className = "fineprint"; note.textContent = series.note;
      (container.parentElement || container).appendChild(note);
    }
  } catch (error) {
    container.innerHTML = `<div class="chart-loading muted">Price series missing from this snapshot: ${esc(error.message)}</div>`;
    return;
  }
  if (config.weeklyPath) {
    try {
      const payload = await fetchJson(config.weeklyPath);
      weekly = payload.bars || [];
    } catch { weekly = MSChart.aggregate(daily, "W"); }
  } else {
    weekly = MSChart.aggregate(daily, "W");
  }
  for (const [path, target] of [[config.indexPath, "index"], [config.rsIndexPath, "rs"]]) {
    if (!path) continue;
    try {
      const payload = await fetchJson(path);
      const pairs = payload.closes && payload.closes.length
        ? payload.closes : (payload.bars || []).map((bar) => [bar[0], bar[4]]);
      const map = new Map(pairs.map(([day, value]) => [String(day), Number(value)]));
      if (target === "index") indexCloses = map; else rsCloses = map;
    } catch { /* an unpublished index simply has no overlay */ }
  }

  if (!daily.length) {
    container.innerHTML = '<div class="chart-loading muted">Price series missing from this snapshot.</div>';
    return;
  }
  if (typeof LightweightCharts === "undefined") {
    container.innerHTML = '<div class="chart-loading muted">Chart library unavailable. Technical tables and snapshot figures remain available.</div>';
    return;
  }
  container.innerHTML = '<div class="chart-host"></div><svg class="draw-overlay" id="draw-overlay"></svg>'
    + '<div class="buy-zone-band" aria-hidden="true"><span>Risk-approved entry band</span></div>';
  const host = container.querySelector(".chart-host");
  const overlay = $("draw-overlay");
  const band = container.querySelector(".buy-zone-band");
  const chart = LightweightCharts.createChart(host, {
    layout: { background: { color: "transparent" }, textColor: "#8a97a8", fontFamily: "IBM Plex Mono, monospace" },
    grid: { vertLines: { color: "#1d2733" }, horzLines: { color: "#1d2733" } },
    rightPriceScale: { borderColor: "#2a3542", scaleMargins: { top: 0.08, bottom: 0.18 },
      mode: LightweightCharts.PriceScaleMode.Logarithmic },
    timeScale: { borderColor: "#2a3542", timeVisible: false, rightOffset: 4 },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    height: Math.max(460, container.clientHeight), autoSize: true,
  });
  const candles = chart.addCandlestickSeries({
    upColor: "#4da3ff", downColor: "#ff5fa2", wickUpColor: "#4da3ff", wickDownColor: "#ff5fa2",
    borderVisible: false,
  });
  const volume = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" } });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  const volumeAverage = chart.addLineSeries({ priceScaleId: "vol", color: "#f5a623", lineWidth: 1,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const maSeries = [0, 1, 2].map(() => chart.addLineSeries({ lineWidth: 1.4, priceLineVisible: false,
    lastValueVisible: false, crosshairMarkerVisible: false }));
  const rsSeries = chart.addLineSeries({ color: "#2ee6a8", lineWidth: 1.2, priceLineVisible: false,
    lastValueVisible: false, crosshairMarkerVisible: false });
  const indexSeries = chart.addLineSeries({ color: "#8a97a8", lineWidth: 1, priceScaleId: "idx",
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  chart.priceScale("idx").applyOptions({ visible: false, scaleMargins: { top: 0.08, bottom: 0.18 } });

  const pattern = (config.qualification && config.qualification.pattern) || {};
  const pivot = pattern.id ? pattern.pivot : null;
  const priceLines = [];
  const drawPriceLine = (price, options, sink = priceLines) => {
    if (!Number.isFinite(price)) return;
    sink.push(candles.createPriceLine({ price, ...options }));
  };
  /* The 52-week lines come from the published reference and are drawn once, outside the
     timeframe switch: the same named level on D, W and M. Nothing recomputes them from
     the bars that happen to be loaded. */
  const priceReference = MSChart.referenceModel(seriesReference || config.reference);
  const referenceLines = [];
  if (priceReference.available) {
    drawPriceLine(priceReference.high, { color: "#3a4756", lineWidth: 1, lineStyle: 3,
      axisLabelVisible: true, title: priceReference.highTitle }, referenceLines);
    drawPriceLine(priceReference.low, { color: "#3a4756", lineWidth: 1, lineStyle: 3,
      axisLabelVisible: true, title: priceReference.lowTitle }, referenceLines);
  }
  const setFineprint = (id, text) => { const target = $(id); if (target) target.textContent = text || ""; };
  /* RS-line events: computed once, from the canonical daily history and the daily
     benchmark closes. A timeframe switch only changes which bar carries the marker. */
  const rsEventState = MSChart.rsEvents(daily, rsCloses, { lookback: MSChart.RS_LOOKBACK.D });
  setFineprint("chart-events", rsEventState.status === "ok"
    ? `RS-line events: ${rsEventState.events.length} full-window highs `
      + `(${rsEventState.lookback} aligned sessions, benchmark Nifty 500, hash ${rsEventState.input_hash}). `
      + "A weekly or monthly marker means at least one session in that period closed the RS line at a "
      + `${rsEventState.lookback}-session high.`
    : `RS-line events: none — ${rsEventState.note} (benchmark Nifty 500, hash ${rsEventState.input_hash}).`);
  let timeframe = storedTimeframe();
  let indexVisible = false;
  let bars = [];

  function render() {
    bars = timeframe === "D" ? daily : timeframe === "W"
      ? (weekly.length ? weekly : MSChart.aggregate(daily, "W")) : MSChart.aggregate(daily, "M");
    candles.setData(bars.map(([time, open, high, low, close]) => ({ time, open, high, low, close })));
    const volumes = MSChart.volumeSeries(bars, timeframe === "D" ? 50 : 10);
    volume.setData(volumes.map((entry) => ({ time: entry.time, value: entry.value,
      color: entry.up ? "rgba(77,163,255,.35)" : "rgba(255,95,162,.35)" })));
    volumeAverage.setData(volumes.filter((entry) => entry.average !== null)
      .map((entry) => ({ time: entry.time, value: entry.average })));
    const closes = bars.map((bar) => bar[4]);
    const periods = MSChart.MA_PERIODS[timeframe];
    const colors = ["#4da3ff", "#f5a623", "#d678ff"];
    maSeries.forEach((series, index) => {
      const period = periods[index];
      if (!period) { series.setData([]); return; }
      const values = MSChart.movingAverage(closes, period);
      series.applyOptions({ color: colors[index] });
      series.setData(bars.map((bar, position) => values[position] === null
        ? null : { time: bar[0], value: values[position] }).filter(Boolean));
    });
    const rs = MSChart.rsLine(bars, rsCloses);
    rsSeries.setData(rs.points.map((point) => ({ time: point.time, value: point.value })));
    const rating = (config.ratings_compact || {}).rs;
    // The events come from the daily history; only their placement follows the timeframe.
    const eventMarkers = MSChart.eventMarkers(rsEventState, bars, timeframe);
    const latest = rs.points.length && rating
      ? [{ time: rs.points[rs.points.length - 1].time, position: "belowBar", color: "#2ee6a8",
          shape: "arrowUp", text: `RS ${rating}`, kind: "rs_latest" }]
      : [];
    const legMarkers = Screener.legMarkers(config.reference_pattern ? [] : config.legs,
      bars.map((bar) => bar[0])).map((marker) => ({ ...marker, kind: "leg" }));
    const markers = MSChart.sortedMarkers(legMarkers, eventMarkers, latest);
    MSChart.assertSortedMarkers(markers);
    candles.setMarkers(markers);
    indexSeries.setData(indexVisible
      ? bars.map((bar) => (indexCloses.has(String(bar[0]))
        ? { time: bar[0], value: indexCloses.get(String(bar[0])) } : null)).filter(Boolean)
      : []);
    priceLines.splice(0).forEach((line) => candles.removePriceLine(line));
    drawPriceLine(pivot, { color: "#2ee6a8", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "pivot" });
    if (pattern.id) drawPriceLine(pattern.extension_limit, { color: "#f5a623", lineWidth: 1, lineStyle: 2, title: "5% extension limit" });
    if (pattern.id) drawPriceLine(pattern.stop, { color: "#ef5350", lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: "stop" });
    const reference = config.reference_pattern?.pivot ?? (!pattern.id ? config.geometry_pivot : null);
    if (Number.isFinite(reference)) drawPriceLine(reference, { color: "#f5a623", lineWidth: 1, lineStyle: 2,
      title: config.reference_pattern ? "power play · flag forming" : "geometry pivot" });
    const loaded = MSChart.loadedRange(bars);
    setFineprint("chart-reference", [
      priceReference.available
        ? `${priceReference.note} · lines drawn on every timeframe from the same window`
        : priceReference.note,
      Number.isFinite(loaded.high) && Number.isFinite(loaded.low)
        ? `loaded-range high ₹${fmt(loaded.high, 2)} · loaded-range low ₹${fmt(loaded.low, 2)} (${loaded.bars} ${timeframe} bars)`
        : null,
      MSChart.partialLastNote(daily, timeframe, config.as_of || priceReference.asOf),
    ].filter(Boolean).join(" · "));
    setFineprint("panel-reference-window", priceReference.available
      ? `${priceReference.window || "window unknown"} · ${priceReference.status}`
      : "no dated 52-week window in this snapshot");
    chart.timeScale().fitContent();
    positionBand();
    renderDrawings();
  }

  const positionBand = () => {
    if (!band) return;
    if (!Number.isFinite(pivot) || !Number.isFinite(pattern.buy_zone_high) || pattern.buy_zone_high <= pivot) { band.hidden = true; return; }
    const upper = candles.priceToCoordinate(pattern.buy_zone_high);
    const lower = candles.priceToCoordinate(pivot);
    if (upper === null || lower === null) { band.hidden = true; return; }
    band.hidden = false;
    band.style.top = `${Math.min(upper, lower)}px`;
    band.style.height = `${Math.abs(lower - upper)}px`;
  };

  /* ── drawings ── */
  const adapter = {
    timeToCoordinate: (time) => chart.timeScale().timeToCoordinate(time),
    priceToCoordinate: (price) => candles.priceToCoordinate(price),
  };
  let drawings = MSChart.loadDrawings(symbol, localStorage);
  let tool = "select";
  let pending = null;
  let selected = null;

  function svg(name, attributes) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }

  function renderDrawings() {
    if (!overlay) return;
    overlay.innerHTML = "";
    const width = host.clientWidth;
    const height = host.clientHeight;
    overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
    overlay.setAttribute("width", width);
    overlay.setAttribute("height", height);
    for (const drawing of drawings.concat(pending ? [pending] : [])) {
      const projected = MSChart.project(drawing, adapter);
      if (!projected) continue;
      const stroke = drawing.color;
      const active = selected && selected.id === drawing.id;
      const common = { stroke, "stroke-width": active ? 2.4 : 1.4, fill: "none",
        "data-drawing": drawing.id };
      if (drawing.tool === "hline") {
        overlay.appendChild(svg("line", { x1: 0, x2: width, y1: projected.y, y2: projected.y, ...common }));
      } else if (drawing.tool === "rect") {
        const [a, b] = projected.points;
        overlay.appendChild(svg("rect", { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
          width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y), ...common,
          fill: `${stroke}22` }));
      } else if (drawing.tool === "text") {
        const [anchor] = projected.points;
        const label = svg("text", { x: anchor.x, y: anchor.y, fill: stroke, "data-drawing": drawing.id,
          "font-size": 12 });
        label.textContent = drawing.text || "note";
        overlay.appendChild(label);
      } else {
        const [a, b] = projected.points;
        const extended = drawing.tool === "ray"
          ? { x: a.x + (b.x - a.x) * 40, y: a.y + (b.y - a.y) * 40 } : b;
        overlay.appendChild(svg("line", { x1: a.x, y1: a.y, x2: extended.x, y2: extended.y, ...common }));
      }
    }
  }

  function pointFromEvent(event) {
    const rect = host.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const time = chart.timeScale().coordinateToTime(x);
    let price = candles.coordinateToPrice(y);
    if (event.shiftKey && time) price = MSChart.snapToClose(price, bars, time);
    return { x, y, time, price };
  }

  function persist() {
    MSChart.saveDrawings(symbol, drawings, localStorage);
    renderDrawings();
  }

  overlay?.addEventListener("mousedown", (event) => {
    const point = pointFromEvent(event);
    if (tool === "select") {
      selected = MSChart.hitTest(drawings, point, adapter);
      renderDrawings();
      return;
    }
    if (!point.time || !Number.isFinite(point.price)) return;
    if (tool === "hline") {
      drawings.push(MSChart.createDrawing("hline", [{ time: point.time, price: point.price }]));
      persist();
      return;
    }
    if (tool === "text") {
      const text = window.prompt("Note text");
      if (text) {
        drawings.push(MSChart.createDrawing("text", [{ time: point.time, price: point.price }], { text }));
        persist();
      }
      return;
    }
    pending = MSChart.createDrawing(tool, [{ time: point.time, price: point.price },
      { time: point.time, price: point.price }]);
  });
  overlay?.addEventListener("mousemove", (event) => {
    if (!pending) return;
    const point = pointFromEvent(event);
    if (!point.time || !Number.isFinite(point.price)) return;
    pending.points[1] = { time: point.time, price: point.price };
    renderDrawings();
  });
  overlay?.addEventListener("mouseup", () => {
    if (!pending) return;
    drawings.push(pending);
    pending = null;
    persist();
  });
  document.querySelectorAll("[data-draw]").forEach((button) => button.addEventListener("click", () => {
    tool = button.dataset.draw;
    document.querySelectorAll("[data-draw]").forEach((other) =>
      other.setAttribute("aria-pressed", String(other === button)));
    overlay?.classList.toggle("drawing", tool !== "select");
  }));
  document.querySelector('[data-draw-action="clear"]')?.addEventListener("click", () => {
    drawings = []; selected = null; persist();
  });
  document.querySelector('[data-draw-action="export"]')?.addEventListener("click", () => {
    downloadText(`${symbol}-drawings.json`, MSChart.exportDrawings(symbol, drawings), "application/json");
  });
  document.querySelector('[data-draw-action="import"]')?.addEventListener("click", () => {
    const text = window.prompt("Paste exported drawings JSON");
    if (!text) return;
    try { drawings = drawings.concat(MSChart.importDrawings(text)); persist(); }
    catch { window.alert("That is not a drawings export from this app."); }
  });

  document.querySelectorAll("[data-timeframe]").forEach((button) => button.addEventListener("click", () => {
    timeframe = button.dataset.timeframe;
    try { localStorage.setItem(TIMEFRAME_KEY, timeframe); } catch { /* private mode */ }
    document.querySelectorAll("[data-timeframe]").forEach((other) =>
      other.setAttribute("aria-pressed", String(other.dataset.timeframe === timeframe)));
    render();
  }));
  $("toggle-index")?.addEventListener("click", () => {
    indexVisible = !indexVisible;
    $("toggle-index").setAttribute("aria-pressed", String(indexVisible));
    render();
  });
  document.querySelectorAll("[data-expand]").forEach((button) => button.addEventListener("click", () => {
    button.previousElementSibling?.classList.add("expanded");
    button.remove();
  }));

  window.addEventListener("keydown", (event) => {
    const action = MSChart.keyAction(event);
    if (!action) return;
    if (action === "next" || action === "prev") { event.preventDefault(); move(action === "next" ? 1 : -1); return; }
    if (action === "first" || action === "last") {
      const target = action === "first" ? 0 : context.symbols.length - 1;
      if (context.symbols.length) gotoListEntry(context, { ok: true, index: target, symbol: context.symbols[target] });
      return;
    }
    if (action.startsWith("timeframe:")) {
      document.querySelector(`[data-timeframe="${action.slice(10)}"]`)?.click();
      return;
    }
    if (action === "panel") { setPanel(document.querySelector(".chart-layout")?.classList.contains("panel-hidden")); return; }
    if (action === "list") { toggleListDrawer(context); return; }
    if (action === "cancel") { pending = null; selected = null; tool = "select"; renderDrawings(); return; }
    if (action === "delete" && selected) {
      drawings = drawings.filter((entry) => entry.id !== selected.id);
      selected = null;
      persist();
      return;
    }
    if (action.startsWith("tab:")) gotoTab(Number(action.slice(4)));
  });

  chart.timeScale().subscribeVisibleTimeRangeChange(() => { positionBand(); renderDrawings(); });
  chart.timeScale().subscribeVisibleLogicalRangeChange(positionBand);
  new ResizeObserver(() => { positionBand(); renderDrawings(); }).observe(host);
  document.querySelectorAll("[data-timeframe]").forEach((other) =>
    other.setAttribute("aria-pressed", String(other.dataset.timeframe === timeframe)));
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => { positionBand(); renderDrawings(); }));
}

/* ── the generic technical route (SPEC-AG §4.2) ───────────────────────────────
   One page serves every scanned symbol that has no full research page. It renders from
   data/stock/<SYM>.json and data/series/<SYM>.json, states its own coverage, and — when
   the symbol is not in the snapshot at all — says so with the symbol still in view. */
const TECHNICAL_SYMBOL_RE = /^[A-Z0-9&._-]{1,20}$/;

function technicalMetric(label, value, extra = "") {
  return `<div><span>${esc(label)}</span><b>${esc(value)}</b>${extra ? `<em>${esc(extra)}</em>` : ""}</div>`;
}

function technicalNotFound(symbol, asOf) {
  return `<h1>${esc(symbol)}</h1><p class="list-empty">${esc(symbol)} is not in this snapshot `
    + `(as of ${esc(asOf || "unknown")}). It may be outside the scanned universe or excluded by `
    + `the universe ledger.</p><p><a href="${esc(siteUrl(`/?q=${encodeURIComponent(symbol)}#screener`))}">`
    + `Search the screener for ${esc(symbol)} →</a></p>`;
}

async function initTechnical() {
  const configNode = $("technical-config");
  if (!configNode) return;
  let config = {};
  try { config = JSON.parse(configNode.textContent); } catch { config = {}; }
  const hero = $("technical-hero");
  const heading = $("technical-symbol");
  const chartCard = $("chart-card");
  const requested = String(new URLSearchParams(window.location.search).get("symbol") || "")
    .trim().toUpperCase();
  const hide = (node) => { if (node) node.hidden = true; };
  if (!requested || !TECHNICAL_SYMBOL_RE.test(requested)) {
    if (heading) heading.textContent = "No symbol requested";
    const name = $("technical-name");
    if (name) {
      name.innerHTML = `Open a stock from a list, or <a href="${esc(siteUrl("/#screener"))}">`
        + "use the screener</a> to find one.";
    }
    for (const id of ["chart-card", "technical-financials", "technical-pattern", "technical-lists",
      "stock-actions", "list-nav"]) hide($(id));
    return;
  }
  document.title = `${requested} · technical view — SEPA Terminal`;
  if (heading) heading.textContent = requested;

  let stock = null;
  try {
    stock = await fetchJson(`${config.stockPath || "/data/stock/"}${encodeURIComponent(requested)}.json`);
  } catch {
    if (hero) hero.innerHTML = technicalNotFound(requested, config.as_of);
    for (const id of ["chart-card", "technical-financials", "technical-pattern", "technical-lists"]) hide($(id));
    return;
  }
  checkBuildId(stock.build_id, stock.last_date || config.as_of);
  const symbol = String(stock.symbol || requested);
  const ratings = stock.ratings || {};
  const group = stock.group || {};
  const qualification = stock.qualification || {};
  const base = stock.base || {};
  const power = stock.power_play || {};
  if (heading) heading.textContent = symbol;
  const name = $("technical-name");
  if (name) name.textContent = stock.name || symbol;
  const price = $("technical-price");
  if (price) {
    price.innerHTML = `<b>₹${fmt(stock.close, 2)}</b>`
      + `<span class="${esc(cls(stock.chg_pct))}">${esc(signed(stock.chg_pct))}</span>`
      + `<em class="hero-volume">${esc(stock.stage || "stage unknown")} · Trend Template `
      + `${fmt((stock.tt || {}).passed, 0)}/8</em>`;
  }
  const actions = $("stock-actions");
  if (actions) actions.dataset.symbol = symbol;
  const metrics = $("technical-metrics");
  if (metrics) {
    metrics.innerHTML = [
      technicalMetric("Relative strength", fmt(stock.rs, 0), `1w ${signed(stock.rs_chg_1w, "")}`),
      technicalMetric("Composite (custom)", fmt(ratings.composite, 0), `EPS ${fmt(ratings.eps, 0)} · A/D ${ratings.ad || "–"}`),
      technicalMetric("Industry group", group.name || "unmapped",
        group.rank ? `rank ${group.rank} of ${group.of}` : "no ranked group"),
      technicalMetric("Entry state", String(qualification.entry_state || "none").replace(/_/g, " "),
        qualification.ready === true ? "Actionable" : "not actionable in this snapshot"),
      technicalMetric("Lifecycle", String(base.lifecycle_state || base.status || "none").replace(/_/g, " "),
        `${fmt(base.depth_pct, 1)}% depth`),
      technicalMetric("Data stamp", stock.last_date || config.as_of || "–",
        stock.stale === true ? "stale row" : "current snapshot"),
    ].join("");
  }
  const status = $("technical-chart-status");
  if (status) {
    status.innerHTML = `<span class="chart-oh">OH ${esc(signed(stock.pct_off_high))}</span>`
      + `<span class="chart-ol">OL ${esc(signed(stock.pct_above_low))}</span>`
      + `<span class="chart-pivot">${esc(stock.pct_to_pivot === null || stock.pct_to_pivot === undefined
        ? "no active pivot" : `${fmt(stock.pct_to_pivot, 1)}% to Pivot`)}</span>`;
  }

  initStockActions({ ...stock, symbol });
  const context = await loadListContext(symbol);
  renderListNav(context);
  const move = bindListNavigation(context);
  setPanel(panelOpen());
  $("toggle-panel")?.addEventListener("click", () =>
    setPanel(document.querySelector(".chart-layout")?.classList.contains("panel-hidden")));

  const pattern = qualification.pattern || {};
  const chartConfig = {
    symbol, name: stock.name || symbol, as_of: config.as_of,
    seriesPath: `${config.seriesPath || "/data/series/"}${encodeURIComponent(symbol)}.json`,
    weeklyPath: null,
    indexPath: config.indexPath || "/data/index/NIFTY50.json",
    rsIndexPath: config.rsIndexPath || "/data/index/NIFTY500.json",
    qualification, legs: base.legs || [], geometry_pivot: base.pivot_hint ?? null,
    reference_pattern: !pattern.id && power.flag === true
      ? { id: "power_play", pivot: power.pivot ?? null } : null,
    ratings_compact: ratings, tick_size: stock.tick_size ?? null,
  };
  renderTechnicalPanel(stock);
  const financials = $("technical-financials");
  if (financials) {
    const coverage = config.coverage || {};
    financials.innerHTML = '<span class="eyebrow">FINANCIAL RECORD</span>'
      + "<h2>Financial record</h2>"
      + `<p>No financial deep dive for ${esc(symbol)} in this snapshot — full pages cover `
      + `${fmt(coverage.full, 0)} of ${fmt(coverage.rows, 0)} symbols (Trend Template ≥ 6/8 and the `
      + "turnover gate). Fundamentals: unknown, not failed.</p>"
      + `<p class="fineprint"><a href="${esc(siteUrl(`/?q=${encodeURIComponent(symbol)}#screener`))}">`
      + "Open this row in the screener →</a></p>";
  }
  const patternCard = $("technical-pattern");
  if (patternCard) {
    patternCard.innerHTML = '<span class="eyebrow">STRUCTURE</span><h2>Pattern read</h2>'
      + '<div class="geometry-grid">'
      + technicalMetric("Base status", String(base.status || "none").replace(/_/g, " "), "")
      + technicalMetric("Contractions", (base.contraction_legs_pct || []).map((value) => `${fmt(value, 1)}%`).join(" → ") || "–", "")
      + technicalMetric("Pivot", pattern.pivot ? `₹${fmt(pattern.pivot, 2)}` : (base.pivot_hint ? `₹${fmt(base.pivot_hint, 2)}` : "–"),
        pattern.id ? "risk-approved pattern pivot" : "geometry pivot only")
      + technicalMetric("Stop", pattern.stop ? `₹${fmt(pattern.stop, 2)}` : "–",
        pattern.risk_pct ? `${fmt(pattern.risk_pct, 1)}% risk from pivot` : "no active pattern")
      + "</div>";
  }
  const listsCard = $("technical-lists");
  if (listsCard) {
    const memberships = stock.lists || [];
    listsCard.innerHTML = '<span class="eyebrow">MEMBERSHIP</span><h2>Lists this stock is in</h2>'
      + (memberships.length
        ? `<ul class="top-rs-list">${memberships.map((entry) =>
          `<li><a href="${esc(siteUrl(`/lists/${entry.id}.html`))}">${esc(entry.title)}</a>`
          + `<span>${esc(entry.section)}</span><b>${entry.index + 1} of ${entry.count}</b></li>`).join("")}</ul>`
        : '<p class="muted">This symbol is not in any published list in this snapshot.</p>');
  }
  await initChart(chartConfig, context, { container: $("chart"), move, gotoTab: () => {} });
  if (chartCard) chartCard.hidden = false;
}

/* The technical blocks of the full page's data panel, rendered from the compact row. */
function renderTechnicalPanel(stock) {
  const panel = $("data-panel");
  if (!panel) return;
  const facts = stock.facts || {};
  const surveillance = stock.surveillance || {};
  const line = (label, value, suffix = "") => `<div class="panel-line"><span>${esc(label)}</span>`
    + `<b>${value === null || value === undefined || value === "" ? '<span class="na">n/a</span>'
      : `${esc(value)}${esc(suffix)}`}</b></div>`;
  const flagged = Object.entries(surveillance).filter(([, value]) => value === true)
    .map(([key]) => key.replace(/_/g, " "));
  panel.innerHTML = '<div class="panel-block"><h3>52-week reference</h3>'
    + line("52-week high", facts.hi_52w === null || facts.hi_52w === undefined ? null : `₹${fmt(facts.hi_52w, 2)}`)
    + line("52-week low", facts.lo_52w === null || facts.lo_52w === undefined ? null : `₹${fmt(facts.lo_52w, 2)}`)
    + line("Off 52-week high", facts.off_52w_high_pct === null || facts.off_52w_high_pct === undefined ? null : fmt(facts.off_52w_high_pct, 1), "%")
    + line("Above 52-week low", facts.above_52w_low_pct === null || facts.above_52w_low_pct === undefined ? null : fmt(facts.above_52w_low_pct, 1), "%")
    + '<p class="fineprint" id="panel-reference-window"></p></div>'
    + '<div class="panel-block"><h3>Liquidity</h3>'
    + line("Average volume (50d)", facts.avg_volume_50d === null || facts.avg_volume_50d === undefined ? null : fmt(facts.avg_volume_50d, 0))
    + line("Average ₹ volume (50d)", facts.avg_rupee_volume_cr === null || facts.avg_rupee_volume_cr === undefined ? null : `₹${fmt(facts.avg_rupee_volume_cr, 1)} Cr`)
    + line("Turnover", stock.turnover_cr === null || stock.turnover_cr === undefined ? null : `₹${fmt(stock.turnover_cr, 1)} Cr`)
    + line("Market cap", facts.market_cap_cr === null || facts.market_cap_cr === undefined ? null : `₹${fmt(facts.market_cap_cr, 0)} Cr`,
      facts.market_cap_source ? ` (${facts.market_cap_source})` : "")
    + "</div>"
    + '<div class="panel-block"><h3>Behaviour</h3>'
    + line("U/D Vol Ratio", facts.ud_vol_ratio === null || facts.ud_vol_ratio === undefined ? null : fmt(facts.ud_vol_ratio, 2))
    + line("Alpha", facts.alpha === null || facts.alpha === undefined ? null : fmt(facts.alpha, 2), "%")
    + line("Beta", facts.beta === null || facts.beta === undefined ? null : fmt(facts.beta, 2))
    + line("Index membership", (stock.indices || []).join(", ") || null)
    + line("Surveillance", flagged.join(", ") || (stock.surveillance_text || "no flag in this snapshot"))
    + "</div>";
}

/* ── list pages ───────────────────────────────────────────────────────────── */
function initSidebar() {
  const toggle = $("sidebar-toggle");
  const body = $("sidebar-body");
  const aside = $("site-sidebar");
  if (!toggle || !body) return;
  let open = false;
  let scrim = null;
  const setOpen = (next) => {
    open = next;
    body.classList.toggle("open", open);
    aside?.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open && !scrim) {
      scrim = document.createElement("div");
      scrim.className = "sidebar-scrim";
      scrim.addEventListener("click", () => setOpen(false));
      document.body.appendChild(scrim);
    } else if (!open && scrim) {
      scrim.remove();
      scrim = null;
    }
  };
  toggle.addEventListener("click", () => setOpen(!open));
  window.addEventListener("keydown", (event) => { if (event.key === "Escape" && open) setOpen(false); });
}

async function initList() {
  const target = $("list-render");
  const configNode = $("list-config");
  if (!target || !configNode) return;
  let payload;
  try {
    const config = JSON.parse(configNode.textContent);
    payload = await fetchJson(config.path);
    checkBuildId(payload.build_id, payload.as_of);
  } catch (error) {
    target.insertAdjacentHTML("afterbegin",
      `<p class="fineprint negative">Live list data could not be loaded (${esc(error.message)}); the table above is the published snapshot.</p>`);
    return;
  }
  const controls = $("list-controls");
  if (controls) controls.hidden = false;
  const select = $("list-sort");
  const options = Lists.sortOptions(payload);
  if (select) {
    select.innerHTML = options.map((option) => `<option value="${esc(option.key)}">${esc(option.label)}</option>`).join("");
    select.value = payload.columns.includes("composite") ? "composite" : payload.columns[0];
  }
  let view = payload.view === "table" ? "table" : "cards";
  let sortKey = select ? select.value : payload.columns[0];
  let pageIndex = 1;
  const extrasFor = (row) => ({ included_in: (payload.included_in || {})[row.symbol] });
  // The route each row resolves to, and the sort the reader is looking at: both travel
  // with every link, so the keyboard context follows the visible order.
  const pages = {};
  for (const row of payload.rows || []) {
    pages[String(row.symbol)] = row.page || (row.has_page ? "full" : "technical");
  }
  const currentSort = () => ({ key: sortKey, direction: Lists.defaultDirection(sortKey) });
  const linkFor = (rows, symbol) => Lists.listLink(payload.id, rows.map((row) => String(row.symbol)),
    String(symbol), document.documentElement.dataset.basePath || "",
    { sort: currentSort(), pages });

  function ordered() {
    return Lists.sortRows(payload.rows, sortKey, Lists.defaultDirection(sortKey), extrasFor);
  }

  function renderTable(rows, all) {
    const head = payload.columns.map((key) => `<th>${esc((payload.column_labels || {})[key] || key)}</th>`).join("");
    const body = rows.map((row) => `<tr>${payload.columns.map((key) => {
      if (key === "symbol") {
        return `<td><a class="list-symbol" href="${esc(linkFor(all, row.symbol))}">${esc(row.symbol)}</a></td>`;
      }
      return `<td>${esc(Lists.formatCell(row, key, extrasFor(row)))}</td>`;
    }).join("")}<td class="row-actions-cell">${listActionsHtml(row.symbol)}</td></tr>`).join("");
    return `<div class="detail-table-wrap"><table class="detail-table list-table"><thead><tr>${head}<th aria-label="My Lists"></th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function renderCards(rows, all) {
    return `<div class="list-cards">${rows.map((row) => {
      const card = Lists.cardModel(row, (payload.sparks || {})[row.symbol], extrasFor(row),
        document.documentElement.dataset.basePath || "", pages);
      const href = linkFor(all, row.symbol);
      const spark = card.spark
        ? `<svg class="spark" viewBox="0 0 160 44" preserveAspectRatio="none"><polyline points="${esc(card.spark)}"/></svg>`
        : `<p class="spark-missing">no weekly series published for this symbol</p>`;
      return `<article class="list-card"><a href="${esc(href)}"><header><b>${esc(card.symbol)}</b><small>${esc(card.name)}</small></header>
        ${spark}
        <div class="list-card-price"><b>${esc(card.close)}</b><span class="${esc(card.changeClass)}">${esc(card.change)}</span></div>
        <dl>${card.ratings.map((entry) => `<div><dt>${esc(entry.label)}</dt><dd>${esc(entry.value)}</dd></div>`).join("")}</dl></a>${listActionsHtml(card.symbol)}</article>`;
    }).join("")}</div>`;
  }

  function draw() {
    const rows = ordered();
    const paged = Lists.page(rows, Lists.PAGE_SIZE, pageIndex);
    target.innerHTML = view === "cards" ? renderCards(paged.rows, rows) : renderTable(paged.rows, rows);
    const more = $("list-more");
    if (more) {
      more.hidden = !paged.more;
      more.textContent = `Show more (${paged.shown} of ${rows.length})`;
    }
    document.querySelectorAll("[data-list-view]").forEach((button) =>
      button.setAttribute("aria-pressed", String(button.dataset.listView === view)));
  }

  bindListActions(target, draw);
  select?.addEventListener("change", () => { sortKey = select.value; pageIndex = 1; draw(); });
  document.querySelectorAll("[data-list-view]").forEach((button) => button.addEventListener("click", () => {
    view = button.dataset.listView; pageIndex = 1; draw();
  }));
  $("list-more")?.addEventListener("click", () => { pageIndex += 1; draw(); });
  $("list-export")?.addEventListener("click", () =>
    downloadText(`${payload.id}-${payload.as_of || "snapshot"}.csv`, Lists.csv(payload, ordered()), "text/csv"));
  draw();
}


/* ── §5 Build Your Screen: the six categories and saved named screens ─────── */
function renderCategoryControls() {
  const host = $("filter-category-body");
  if (!host) return;
  const state = ScreenFilters.normalize(categories);
  host.innerHTML = ScreenFilters.categoriesHtml(state);
  const summary = $("filter-category-summary");
  if (summary) {
    const active = ScreenFilters.active(state);
    summary.textContent = active.length
      ? `${active.length} active: ${ScreenFilters.describe(state)}` : "no category filter is active";
  }
}

function readCategoryControls() {
  return ScreenFilters.readControls([...document.querySelectorAll("#filter-category-body [data-filter]")]);
}

function applyCategoryState(state) {
  categories = ScreenFilters.normalize(state);
  saveCategories();
  renderCategoryControls();
  if (scanData) { renderCoverage(); renderRows(); }
}

function renderSavedScreens(selected) {
  const select = $("saved-screens");
  if (!select) return;
  const document_ = ScreenFilters.loadSaved(localStorage);
  select.innerHTML = ['<option value="">— saved screens —</option>',
    ...document_.screens.map((screen) =>
      `<option value="${esc(screen.name)}"${screen.name === selected ? " selected" : ""}>${esc(screen.name)}</option>`)].join("");
}

function initCategories() {
  const host = $("filter-category-body");
  if (!host) return;
  renderCategoryControls();
  renderSavedScreens();
  host.addEventListener("change", () => applyCategoryState(readCategoryControls()));
  $("category-clear")?.addEventListener("click", () => applyCategoryState({}));
  $("saved-apply")?.addEventListener("click", () => {
    const screen = ScreenFilters.getScreen(localStorage, $("saved-screens").value);
    if (!screen) return;
    if (screen.screener) { filters = Screener.normalize(screen.screener); saveFilters(); renderFilterControls(); }
    applyCategoryState(screen.filters);
  });
  $("saved-save")?.addEventListener("click", () => {
    const name = window.prompt("Name this screen", $("saved-screens").value || "My screen");
    if (!name) return;
    const result = ScreenFilters.saveScreen(localStorage, name, categories, Screener.normalize(filters));
    if (!result.ok) { window.alert(result.error); return; }
    renderSavedScreens(String(name).trim().slice(0, 60));
  });
  $("saved-delete")?.addEventListener("click", () => {
    const name = $("saved-screens").value;
    if (!name) return;
    ScreenFilters.deleteScreen(localStorage, name);
    renderSavedScreens();
  });
}

/* ── §2 My Lists: the browser-local store behind every list control ───────── */
let myLists = null;

function lists() {
  if (myLists === null) myLists = MyLists.load(localStorage);
  return myLists;
}

function persistLists() {
  MyLists.save(localStorage, myLists);
  renderSidebarCounts();
}

function renderSidebarCounts() {
  const counts = MyLists.counts(lists());
  const portfolio = MyLists.holdings(lists()).length;
  document.querySelectorAll("[data-mylist-count]").forEach((node) => {
    const id = node.dataset.mylistCount;
    const value = id === "model-current-holdings" ? portfolio
      : id === "model-sell-watchlist" ? portfolio
      : id === "my-lists" ? Object.values(counts).reduce((total, count) => total + count, 0)
      : id === "model-buy-watchlist" ? counts.favorites || 0 : null;
    node.textContent = value === null ? "" : String(value);
  });
}

function listActionsHtml(symbol) {
  const store = lists();
  const state = (id) => (MyLists.has(store, id, symbol) ? ' aria-pressed="true"' : ' aria-pressed="false"');
  return `<span class="row-actions" data-symbol="${esc(symbol)}">`
    + `<button type="button" data-list-action="favorites"${state("favorites")} title="Favorite">★</button>`
    + `<button type="button" data-list-action="liked"${state("liked")} title="Like">▲</button>`
    + `<button type="button" data-list-action="disliked"${state("disliked")} title="Dislike">▼</button>`
    + `<button type="button" data-list-action="add" title="Add to a list of your own">+</button>`
    + `</span>`;
}

function bindListActions(container, redraw) {
  container?.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-list-action]");
    if (!button) return;
    event.preventDefault();
    const symbol = button.parentElement?.dataset?.symbol || button.dataset.symbol;
    const action = button.dataset.listAction;
    if (!symbol) return;
    if (action === "liked" || action === "disliked") MyLists.opinion(lists(), symbol, action);
    else if (action === "add") {
      const named = MyLists.listsOf(lists()).filter((list) => !list.builtin).map((list) => list.title);
      const answer = window.prompt(`Add ${symbol} to which list?`, named[0] || "Watchlist");
      if (!answer) return;
      const existing = MyLists.listsOf(lists()).find((list) => list.title === answer);
      MyLists.add(lists(), existing ? existing.id : MyLists.createList(lists(), answer),
        { symbol }, { title: answer, kind: "custom" });
    } else MyLists.toggle(lists(), "favorites", { symbol });
    persistLists();
    if (typeof redraw === "function") redraw();
  });
}

function initStockActions(payload) {
  const host = $("stock-actions");
  if (!host) return;
  const symbol = String(payload.symbol || host.dataset.symbol || "");
  const status = $("action-status");
  const store = lists();
  MyLists.touchRecent(store, symbol);
  persistLists();
  const refresh = () => {
    for (const [id, list] of [["action-favorite", "favorites"], ["action-like", "liked"],
      ["action-dislike", "disliked"]]) {
      const button = $(id);
      if (button) button.setAttribute("aria-pressed", String(MyLists.has(lists(), list, symbol)));
    }
  };
  const announce = (text) => { if (status) status.textContent = text; };
  $("action-favorite")?.addEventListener("click", () => {
    MyLists.toggle(lists(), "favorites", { symbol });
    persistLists(); refresh();
    announce(MyLists.has(lists(), "favorites", symbol) ? `${symbol} added to Favorite Stocks` : `${symbol} removed from Favorite Stocks`);
  });
  for (const [id, verdict] of [["action-like", "liked"], ["action-dislike", "disliked"]]) {
    $(id)?.addEventListener("click", () => {
      MyLists.opinion(lists(), symbol, verdict);
      persistLists(); refresh();
      announce(MyLists.has(lists(), verdict, symbol) ? `${symbol} marked ${verdict}` : `${symbol} cleared`);
    });
  }
  $("action-add")?.addEventListener("click", () => {
    const named = MyLists.listsOf(lists()).filter((list) => !list.builtin).map((list) => list.title);
    const answer = window.prompt(`Add ${symbol} to which list?${named.length ? ` Existing: ${named.join(", ")}` : ""}`, named[0] || "Watchlist");
    if (!answer) return;
    const existing = MyLists.listsOf(lists()).find((list) => list.title === answer);
    const id = existing ? existing.id : MyLists.createList(lists(), answer);
    MyLists.add(lists(), id, { symbol }, { title: answer, kind: "custom" });
    persistLists();
    announce(`${symbol} added to ${answer}`);
  });
  $("action-position")?.addEventListener("click", () => {
    const quantity = window.prompt(`Quantity of ${symbol}`, "");
    if (quantity === null) return;
    const price = window.prompt(`Average price paid for ${symbol}`, "");
    if (price === null) return;
    const date = window.prompt("Entry date (YYYY-MM-DD, optional)", new Date().toISOString().slice(0, 10));
    const pattern = (payload.qualification || {}).pattern || {};
    MyLists.add(lists(), "portfolio", { symbol }, { kind: "portfolio", title: "My Portfolio" });
    MyLists.updateHolding(lists(), symbol, {
      qty: quantity, avg_price: price, entry_date: date,
      entry_pivot: pattern.pivot, entry_stop: pattern.stop, entry_buy_high: pattern.buy_zone_high,
    });
    persistLists();
    announce(`${symbol} recorded in My Portfolio (${quantity} @ ${price})`);
  });
  refresh();
}

/* ── §3 / §4 the browser-local pages ─────────────────────────────────────── */
/* Every symbol a reader's own list can hold resolves through the published route
   manifest: an imported symbol with no full page still opens its technical view. */
const portfolioView = Portfolio.renderers({ esc, fmt, signed, cls, url: siteUrl,
  stockUrl: (symbol) => Lists.stockHref(symbol, basePath(), routePages),
  contextUrl: (listId, symbol, index) => Lists.listLink(`my:${listId}`,
    [String(symbol)], String(symbol), basePath(), { pages: routePages })
    .replace(/&i=0$/, `&i=${index}`) });

async function initUserPage() {
  const host = $("user-render");
  const configNode = $("user-config");
  if (!host || !configNode) return;
  let config = {};
  try { config = JSON.parse(configNode.textContent); } catch { config = {}; }
  const store = lists();
  renderSidebarCounts();
  // The route manifest first: a reader's list can hold any symbol, and every one of them
  // must link somewhere that resolves.
  await loadRoutes(config.routesPath || "/data/routes.json");

  if (config.id === "my-lists") {
    const draw = () => { host.innerHTML = portfolioView.myLists(MyLists.listsOf(lists())); };
    draw();
    host.addEventListener("click", (event) => {
      const target = event.target;
      if (target?.dataset?.removeSymbol) {
        MyLists.remove(lists(), target.dataset.removeList, target.dataset.removeSymbol);
        persistLists(); draw(); return;
      }
      if (target?.dataset?.deleteList) {
        MyLists.deleteList(lists(), target.dataset.deleteList);
        persistLists(); draw(); return;
      }
      if (target?.dataset?.exportList) {
        const id = target.dataset.exportList;
        downloadText(`${id}.csv`, MyLists.exportCsv(lists(), id), "text/csv;charset=utf-8");
      }
    });
    host.addEventListener("change", async (event) => {
      const input = event.target;
      if (!input?.dataset?.importList || !input.files?.length) return;
      const text = await input.files[0].text();
      const result = MyLists.importCsv(lists(), input.dataset.importList, text);
      persistLists(); draw();
      const status = $("mylists-status");
      if (status) status.textContent = result.ok
        ? `Imported ${result.imported} rows (${result.skipped} skipped).` : `Import failed: ${result.error}`;
    });
    $("mylists-export")?.addEventListener("click", () =>
      downloadText("sepa-my-lists.json", MyLists.exportJson(lists()), "application/json"));
    $("mylists-import")?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const result = MyLists.importJson(lists(), await file.text());
      const status = $("mylists-status");
      if (result.ok) { myLists = result.store; persistLists(); draw(); }
      if (status) status.textContent = result.ok
        ? `Merged ${result.lists} lists (${result.added >= 0 ? "+" : ""}${result.added} rows).`
        : `Import failed: ${result.error}`;
    });
    $("mylists-new")?.addEventListener("click", () => {
      const title = window.prompt("Name the new list", "Watchlist");
      if (!title) return;
      MyLists.createList(lists(), title);
      persistLists(); draw();
    });
    $("mylists-sync")?.addEventListener("click", async () => {
      const status = $("mylists-status");
      try {
        // Same-origin only: the published site has no API, so this succeeds exactly when
        // the bundle is being served by the local app.
        const remote = await fetchJson("/api/lists");
        myLists = MyLists.merge(lists(), remote);
        persistLists();
        const put = await fetch(siteUrl("/api/lists"), { method: "PUT",
          headers: { "content-type": "application/json" }, body: JSON.stringify(myLists) });
        if (!put.ok) throw new Error(`HTTP ${put.status}`);
        draw();
        if (status) status.textContent = "Synced with the local app.";
      } catch (error) {
        if (status) status.textContent = `Sync is only available when this page is served by the local SEPA Terminal app (${esc(error.message)}).`;
      }
    });
    return;
  }

  host.innerHTML = '<p class="list-empty">Loading the published snapshot…</p>';
  let rows = [];
  try {
    const payload = await fetchJson(config.screenerPath || "/data/screener.json");
    checkBuildId(payload.build_id || payload.meta?.build_id, payload.meta?.as_of);
    rows = payload.rows || [];
  } catch (error) {
    host.innerHTML = `<p class="list-empty negative">The published snapshot could not be loaded (${esc(error.message)}), so nothing can be valued.</p>`;
    return;
  }
  const byId = Portfolio.index(rows);

  if (config.id === "model-current-holdings") {
    host.innerHTML = portfolioView.holdingsTable(Portfolio.currentHoldings(MyLists.holdings(store), byId));
    return;
  }
  if (config.id === "model-sell-watchlist") {
    const cards = Portfolio.sellWatchlist(MyLists.holdings(store), byId);
    host.innerHTML = cards.length ? portfolioView.holdingsTable(cards)
      : '<p class="list-empty">No holding breaches a sell rule in this snapshot.</p>';
    return;
  }
  if (config.id === "model-buy-watchlist") {
    let systemSymbols = [];
    if (config.systemListPath) {
      try { systemSymbols = (await fetchJson(config.systemListPath)).symbols || []; } catch { systemSymbols = []; }
    }
    host.innerHTML = portfolioView.buyWatchlistTable(
      Portfolio.buyWatchlist(MyLists.symbols(store, "favorites"), byId, systemSymbols));
    return;
  }
  if (config.id === "portfolio-evaluation") {
    const status = $("evaluation-status");
    const subsetButton = $("evaluation-subset");
    let lastHoldings = [];
    const render = (holdings, note, options = {}) => {
      lastHoldings = holdings || [];
      const result = Portfolio.evaluate(holdings, byId, { asOf: config.as_of, ...options });
      host.innerHTML = portfolioView.evaluation(result);
      if (status) status.textContent = note || "";
      // The subset run is always the reader's explicit choice: a withheld grade never
      // turns itself into a partial one.
      if (subsetButton) {
        subsetButton.hidden = result.status !== "partial";
        const resolved = result.coverage.submitted - (result.coverage.unresolved || []).length;
        subsetButton.textContent = `Evaluate the ${resolved} resolved positions as a subset`;
      }
      return result;
    };
    const runSubset = () => render(lastHoldings, "Subset evaluation over the resolved positions only.",
      { subset: true });
    subsetButton?.addEventListener("click", runSubset);
    host.addEventListener("click", (event) => {
      if (event.target?.closest?.("[data-evaluation-subset]")) { event.preventDefault(); runSubset(); }
    });
    const fromText = () => {
      const parsed = Portfolio.parseHoldings($("evaluation-input").value, MyLists.parseCsv);
      return render(parsed.items, parsed.errors.length
        ? `${parsed.items.length} positions read; ${parsed.errors.length} line(s) skipped: ${parsed.errors.map((error) => `line ${error.line}`).join(", ")}`
        : `${parsed.items.length} positions read.`);
    };
    $("evaluation-run")?.addEventListener("click", fromText);
    $("evaluation-portfolio")?.addEventListener("click", () => {
      const holdings = MyLists.holdings(lists());
      render(holdings, holdings.length ? `Evaluated ${holdings.length} positions from My Portfolio.`
        : "My Portfolio has no position with both a quantity and an average price.");
    });
    $("evaluation-file")?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      $("evaluation-input").value = await file.text();
      fromText();
    });
    const holdings = MyLists.holdings(store);
    render(holdings, holdings.length ? `Evaluated ${holdings.length} positions from My Portfolio.`
      : "Paste holdings above, upload a CSV, or record positions on a stock page.");
  }
}

/* ── §6 Markets → Bulk & Block Deals: a client-side filter over the table ─── */
function initDeals() {
  const input = $("deals-filter");
  const table = $("deals-table");
  if (!input || !table) return;
  const rows = [...(table.querySelectorAll?.("tbody tr") || [])];
  const count = $("deals-count");
  const apply = () => {
    const needle = input.value.trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const match = !needle || row.textContent.toLowerCase().includes(needle);
      row.hidden = !match;
      if (match) shown += 1;
    }
    if (count) count.textContent = `${shown} of ${rows.length} shown`;
  };
  input.addEventListener("input", apply);
  apply();
}

/* ── §7 polish: theme, keyboard help, mobile drawer ───────────────────────── */
const THEME_KEY = "sepa_theme";

function applyTheme(theme) {
  const root = document.documentElement;
  if (root.dataset) root.dataset.theme = theme;
  const button = $("theme-toggle");
  if (button) {
    button.setAttribute("aria-pressed", String(theme === "light"));
    button.textContent = theme === "light" ? "Light" : "Dark";
  }
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { saved = null; }
  applyTheme(saved === "light" ? "light" : "dark");
  $("theme-toggle")?.addEventListener("click", () => {
    const next = (document.documentElement.dataset || {}).theme === "light" ? "dark" : "light";
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  });
}

function toggleKeyHelp(open) {
  const overlay = $("key-help");
  if (!overlay) return;
  overlay.hidden = open === undefined ? !overlay.hidden : !open;
}

function initKeyHelp() {
  $("help-open")?.addEventListener("click", () => toggleKeyHelp());
  $("help-close")?.addEventListener("click", () => toggleKeyHelp(false));
  window.addEventListener("keydown", (event) => {
    const tag = String(event.target?.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag) || event.target?.isContentEditable) return;
    if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      toggleKeyHelp();
    } else if (event.key === "Escape") {
      toggleKeyHelp(false);
    }
  });
}

initRefresh();
initNavigation();
initSidebar();
initTheme();
initKeyHelp();
renderSidebarCounts();
if (document.body.dataset.page === "screener") initScreener();
if (document.body.dataset.page === "stock") initStock();
if (document.body.dataset.page === "technical") initTechnical();
if (document.body.dataset.page === "list") initList();
if (document.body.dataset.page === "user") initUserPage();
if (document.body.dataset.page === "markets") initDeals();

// Progressive web app: keeps the last snapshot readable offline and satisfies the
// installability criteria the Android wrapper (Trusted Web Activity) expects.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator &&
    typeof window !== "undefined" && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(siteUrl("/sw.js"), { scope: siteUrl("/") }).catch(() => {});
  });
}
