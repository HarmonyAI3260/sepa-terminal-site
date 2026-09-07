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
// Every published resource this page rejected or had to limit, named (SPEC-AI §3). The
// banner lists all of them, not only the first one that was loaded.
const resourceIssues = [];

function resourceIssue(resourceId, detail) {
  const id = String(resourceId || "a published resource");
  if (!resourceIssues.some((entry) => entry.id === id)) resourceIssues.push({ id, detail });
  return resourceIssues;
}

function renderBuildBanner() {
  const banner = $("build-mismatch");
  if (!banner) return;
  const parts = [];
  if (buildMismatch) {
    parts.push((buildMismatch.resource ? `Resource ${buildMismatch.resource} — ` : "")
      + `Data build ${buildMismatch.data} \u2260 page build ${buildMismatch.page} `
      + "\u2014 reload to get matching versions."
      + (buildMismatch.priceDate ? ` The loaded data prices ${buildMismatch.priceDate}.`
        : " The loaded data has no price date."));
  }
  for (const entry of resourceIssues) parts.push(`${entry.id}: ${entry.detail}`);
  if (!parts.length) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.textContent = parts.join(" · ");
}

function checkBuildId(dataBuildId, priceDate, resourceId) {
  const page = String(document.documentElement.dataset.buildId || "");
  const data = String(dataBuildId || "");
  if (!page || !data || page === data) return false;
  buildMismatch = { data, page, priceDate: priceDate || null, resource: resourceId || null };
  if (resourceId) resourceIssue(resourceId, `from build ${data}, not ${page}`);
  renderBuildBanner();
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
  // SPEC-AI §4.4: a named template can span both layers. The category half of such a
  // preset is applied with the core half (additively — no other saved condition is
  // touched), so what the page shows is exactly what it filtered on.
  const categoryHalf = Screener.PRESET_CATEGORIES[name];
  if (categoryHalf) {
    categories = ScreenFilters.normalize({ ...categories, ...categoryHalf });
    saveCategories();
    renderCategoryControls();
  }
  renderFilterControls();
  renderRows();
}

/* The research template the current state matches, if any: named on the coverage line so
   a screen's meaning is never implied by its counts alone. */
function activeTemplate() {
  const half = Screener.PRESET_CATEGORIES["eps-led"];
  const matches = Object.entries(half).every(([key, value]) => categories[key] === value);
  if (matches && filters.growthMode === "code33") return Screener.RESEARCH_TEMPLATES["eps-led-v1"];
  return null;
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

/* SPEC-AJ §2.2: the screener payload carries each Trend Template check as {id, pass};
   the label is published once in meta.tt_labels and the per-check detail sentence travels
   with the stock page, not with the index. A row from an older snapshot that still
   carries its own label keeps working. */
function ttCheckTitle(check, state) {
  const labels = ((scanData || {}).meta || {}).tt_labels || {};
  const label = labels[String(check.id)] || check.label || `Trend Template check ${check.id}`;
  return `${check.id}. ${label} — ${state}`;
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
  if (categoryLine) {
    const template = activeTemplate();
    categoryLine.textContent = ScreenFilters.coverageText(scanData?.rows || [], categories, scanData)
      + (template ? ` · ${template.label}: ${template.rule} (${template.basis})` : "");
  }
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
      // A category block names the values this snapshot cannot answer; removing it strips
      // exactly those and leaves the rest of the condition standing (SPEC-AH §2.1).
      button.title = item.unsupported && item.unsupported.length
        ? `Remove ${item.unsupported.join(", ")} from ${item.label}` : `Remove ${item.label}`;
      button.addEventListener("click", () => {
        if (ScreenFilters.FILTERS.has(item.key)) {
          categories = item.unsupported && item.unsupported.length
            ? ScreenFilters.removeUnsupported(categories, item.key, item.unsupported)
            : (() => { const next = { ...ScreenFilters.normalize(categories) };
              delete next[item.key]; return next; })();
          saveCategories();
          renderCategoryControls();
        } else {
          filters[item.key] = false;
          saveFilters();
        }
        renderRows();
      });
      $("scan-count").appendChild(button);
    }
  } else if (!visibleRows.length) {
    $("scan-count").textContent = `0 matching rows · ${Screener.coverageText(scanData, filters)}`;
  }
  $("scan-results-body").innerHTML = pageRows.map((row) => {
    const base = row.base || {};
    const dots = (row.tt?.checks || []).map((check) => {
      const state = check.pass === true ? "pass" : check.pass === false ? "fail" : "unknown";
      return `<span class="scan-dot ${state}" title="${esc(ttCheckTitle(check, state))}"></span>`;
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
      // The screener payload is a published resource like any other: its envelope is
      // checked, and a rejected one is named in the banner (SPEC-AI §3).
      const check = Resources.validate(data, { kind: "screener", buildId: pageBuildId(),
        asOf: data?.meta?.as_of, manifest: pageManifest });
      if (!check.ok) resourceIssue((check.envelope || {}).id || "screener", check.reason);
      checkBuildId(data?.meta?.build_id, data?.meta?.as_of,
        (check.envelope || {}).id || "screener");
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

/* ── one typed loader for every published resource (SPEC-AI §3) ─────────────
   ``fetchJson`` + ``Resources.validate``: the caller gets the payload and a verdict
   ("current", "compatible", "lagging", "stale", "foreign", "missing", "conflicted") and
   decides whether to render, to fall back, or to show the resource notice. Nothing is
   rendered as current on the strength of a build stamp alone. */
let manifestPromise = null;
let pageManifest = null;

async function loadManifest(path = "/data/manifest.json") {
  if (pageManifest) return pageManifest;
  if (!manifestPromise) {
    manifestPromise = fetchJson(path).then((payload) => { pageManifest = payload; return payload; })
      .catch(() => { pageManifest = {}; return pageManifest; });
  }
  return manifestPromise;
}

async function loadResource(path, expectation = {}) {
  const payload = await fetchJson(path);
  const manifest = expectation.manifest !== undefined ? expectation.manifest
    : await loadManifest(expectation.manifestPath || "/data/manifest.json");
  const check = Resources.validate(payload, {
    buildId: pageBuildId(),
    asOf: expectation.asOf,
    kind: expectation.kind,
    instrument: expectation.instrument,
    manifest,
  });
  const id = (check.envelope || {}).id || expectation.kind || path;
  if (!check.ok) {
    resourceIssue(id, check.reason);
    renderBuildBanner();
  }
  return { payload, check, id };
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
    routesPromise = loadResource(path, { kind: "routes" }).then(({ payload, check }) => {
      // A route map from another build points into destinations this build may not have
      // written: it is reported and dropped rather than used to resolve links.
      if (!check.ok) { routePages = {}; return routePages; }
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
  if (id) return { id, index: Number.isInteger(index) ? index : -1, sort, fallback: false, source: "url" };
  try {
    const stored = JSON.parse(sessionStorage.getItem(LIST_CONTEXT_KEY) || "null");
    // A session entry from another contract version or another build is discarded, not
    // migrated: it would point into an order this build no longer publishes.
    const usable = stored && stored.id && stored.version === MSChart.LIST_CONTEXT_VERSION
      && (!stored.build_id || !pageBuildId() || stored.build_id === pageBuildId());
    if (usable) {
      return { id: stored.id, index: Number.isInteger(stored.index) ? stored.index : -1,
        sort: MSChart.listSort(stored.sort), fallback: false, source: "session" };
    }
  } catch { /* a corrupt session entry is simply no context */ }
  return { id: DEFAULT_LIST, index: -1, sort: null, fallback: true, source: "default" };
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
      // A list of the reader's own: the reason is their own note, or simply the list.
      context.reasons = Object.fromEntries(list.items.map((item) =>
        [item.symbol, item.note || `in your list ${list.title}`]));
      context.fallback = false;
      rememberListContext(context, requested);
      return context;
    }
    return { version: MSChart.LIST_CONTEXT_VERSION, id: null, title: null, symbols: [], index: -1,
      position: null, sort: null, pages: null, unresolved: [], fallback: true,
      error: `${requested.id} is not a list in this browser` };
  }
  try {
    const { payload, check } = await loadResource(`/data/lists/${requested.id}.json`,
      { kind: "list" });
    if (!check.ok) {
      // A list from another build carries another order: the reader gets no context
      // rather than a next/previous walk through a stale sequence.
      return { version: MSChart.LIST_CONTEXT_VERSION, id: null, title: null, symbols: [],
        index: -1, position: null, sort: null, pages: null, unresolved: [], fallback: true,
        error: Resources.describe(check) };
    }
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
    // Why each member is in this list, from the list JSON itself (SPEC-AJ §1.3). The
    // navigation context is extended, not duplicated: same object, one more field.
    const rowIndex = new Map(rows.map((row) => [String(row.symbol), row]));
    context.reasons = Object.fromEntries(context.symbols.map((entry) =>
      [entry, Lists.membershipReason(payload, rowIndex.get(entry) || { symbol: entry })]));
    context.fallback = requested.fallback;
    rememberListContext(context, requested);
    return context;
  } catch {
    return { version: MSChart.LIST_CONTEXT_VERSION, id: null, title: null, symbols: [], index: -1,
      position: null, sort: null, pages: null, unresolved: [], fallback: true,
      error: `list ${requested.id} is not published in this snapshot` };
  }
}

/* A list context that arrived in the URL becomes this tab's context, so a link that
   carries no list parameters (Related, Top RS in group, a search result) keeps walking
   the list the reader was reading instead of an older one. */
function rememberListContext(context, requested) {
  if (!context || !context.id || context.index === -1 || (requested || {}).source !== "url") return;
  try {
    sessionStorage.setItem(LIST_CONTEXT_KEY, JSON.stringify({
      version: MSChart.LIST_CONTEXT_VERSION, id: context.id, sort: context.sort,
      index: context.index, build_id: pageBuildId(),
    }));
  } catch { /* private mode: the query string still carries the context */ }
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

/* ── the persistent ordered-list panel (SPEC-AJ §1.3) ────────────────────────────
   On wide viewports the list the reader came from stays on screen as a left column:
   every member with the reason it is in the list and the marks the reader has put on it.
   Built from the same context the keyboard walks and the same ``Lists.listLink``, so the
   panel, the drawer and Space/→ cannot disagree about the order. */
let activeListContext = null;

function reviewMarkHtml(symbol) {
  const store = lists();
  const marks = [];
  if (MyLists.has(store, "favorites", symbol)) marks.push('<i title="Favorite">★</i>');
  if (MyLists.has(store, "liked", symbol)) marks.push('<i class="positive" title="Liked">▲</i>');
  if (MyLists.has(store, "disliked", symbol)) marks.push('<i class="negative" title="Disliked">▼</i>');
  const review = MyLists.reviewOf(store, symbol);
  if (review) {
    marks.push(`<i class="review-mark" title="${esc(MyLists.reviewLabel(review))}">`
      + `✓ ${esc(review.decision)}</i>`);
  }
  return marks.join("");
}

/* Where a list row points. On the stock routes it is the stock page; inside the
   full-screen workspace every row stays in the workspace, so Space and a click do the
   same thing (SPEC-AK §1.3). One context object produces both. */
function inChartView() {
  return (document.body?.dataset || {}).page === "chartview";
}

function contextLink(context, symbol) {
  const state = context || {};
  const link = inChartView() ? Lists.chartLink : Lists.listLink;
  return link(state.id, state.symbols, symbol, basePath(),
    { sort: state.sort, pages: state.pages });
}

function renderListPanel(context) {
  if (context !== undefined) activeListContext = context;
  const panel = $("list-panel");
  const state = activeListContext;
  if (!panel) return;
  if (!state || !(state.symbols || []).length) {
    panel.innerHTML = '<p class="fineprint" id="list-panel-status">'
      + `${esc((state || {}).error || "no list context")}</p>`;
    return;
  }
  const sorted = state.sort ? ` · sorted by ${state.sort.key} ${state.sort.direction}` : "";
  const position = `${state.position || `not in ${state.title || state.id}`}${sorted}`;
  const rows = state.symbols.map((symbol, index) => {
    const reason = (state.reasons || {})[symbol];
    const href = contextLink(state, symbol);
    return `<li class="${index === state.index ? "current" : ""}" data-symbol="${esc(symbol)}">`
      + `<a href="${esc(href)}" data-chart-symbol="${esc(symbol)}" data-chart-index="${index}">`
      + `<b>${esc(symbol)}</b>`
      + `<span class="panel-marks">${reviewMarkHtml(symbol)}</span></a>`
      + (reason ? `<em class="panel-reason">${esc(reason)}</em>` : "")
      + "</li>";
  }).join("");
  panel.innerHTML = `<h3>${esc(state.title || state.id || "List")}</h3>`
    + `<p class="fineprint" id="list-panel-status">${esc(position)}</p>`
    + `<ol class="list-panel-rows" start="1">${rows}</ol>`
    + (state.unresolvedNote ? `<p class="fineprint">${esc(state.unresolvedNote)}</p>` : "");
  panel.querySelector("li.current")?.scrollIntoView({ block: "center" });
}

/* The Absolute / YoY % switch on the quarterly block. Display only: both readings are
   already in the page, so nothing is recomputed and nothing is fetched. */
function initQuarterlyBlock() {
  const block = $("quarterly-block");
  if (!block) return;
  const buttons = [...document.querySelectorAll("[data-quarterly]")];
  buttons.forEach((button) => button.addEventListener("click", () => {
    const mode = button.dataset.quarterly === "yoy" ? "yoy" : "absolute";
    block.dataset.mode = mode;
    buttons.forEach((other) =>
      other.setAttribute("aria-pressed", String(other.dataset.quarterly === mode)));
  }));
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
  if (drawer) {
    drawer.hidden = !drawer.hidden;
    // Re-drawn on the way in, so a drawer opened on an earlier stock still highlights
    // the row the reader is on (SPEC-AK §1.3).
    if (drawer.hidden) return;
  }
  const existing = Boolean(drawer);
  if (!existing) {
    drawer = document.createElement("aside");
    drawer.id = "list-drawer";
    drawer.className = "list-drawer";
  }
  const items = context.symbols.map((symbol, index) =>
    `<li${index === context.index ? ' class="current"' : ""}>`
    + `<a href="${esc(contextLink(context, symbol))}" data-chart-symbol="${esc(symbol)}" `
    + `data-chart-index="${index}">${esc(symbol)}</a></li>`).join("");
  drawer.innerHTML = `<h3>${esc(context.title || context.id || "List")}</h3><ol>${items}</ol>`;
  if (!existing) document.body.appendChild(drawer);
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

/* The element that owns the data-panel column: the stock pages' chart layout, or the
   full-screen workspace's body (SPEC-AK §1.2). One preference, two hosts. */
function panelHost() {
  return document.querySelector(".chartview-body") || document.querySelector(".chart-layout");
}

function panelHidden() {
  return Boolean(panelHost()?.classList.contains("panel-hidden"));
}

function setPanel(open) {
  panelHost()?.classList.toggle("panel-hidden", !open);
  $("toggle-panel")?.setAttribute("aria-pressed", String(open));
  try { localStorage.setItem(PANEL_KEY, open ? "1" : "0"); } catch { /* private mode */ }
}

/* Where the ⛶ control and the F key go from this page: the full-screen workspace, with
   the list context this page is walking. Set once the context is known (SPEC-AK §1.4). */
let chartViewHref = "";

function setChartViewLink(symbol, context) {
  const state = context || {};
  chartViewHref = (state.id && (state.symbols || []).includes(symbol))
    ? Lists.chartLink(state.id, state.symbols, symbol, basePath(),
      { sort: state.sort, pages: state.pages })
    : `${basePath()}/chart/?symbol=${encodeURIComponent(String(symbol || ""))}`;
  const link = $("chart-fullscreen");
  if (link) {
    link.href = chartViewHref;
    link.setAttribute("href", chartViewHref);
  }
  return chartViewHref;
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
  initQuarterlyBlock();
  const context = await loadListContext(symbol);
  renderListNav(context);
  renderListPanel(context);
  const move = bindListNavigation(context);
  const gotoTab = bindTabs();
  setPanel(panelOpen());
  $("toggle-panel")?.addEventListener("click", () => setPanel(panelHidden()));
  setChartViewLink(symbol, context);
  await initChart(config, context, { container, move, gotoTab });
}

/* The reader's moving-average selection, per timeframe. Display state only. */
function loadMaPeriods() {
  try { return JSON.parse(localStorage.getItem(MSChart.MA_STORAGE_KEY) || "null"); }
  catch { return null; }
}

function saveMaPeriods(store) {
  try { localStorage.setItem(MSChart.MA_STORAGE_KEY, JSON.stringify(store || {})); }
  catch { /* private mode: the selection still applies for this session */ }
}

/* ── display preferences that survive the next stock (SPEC-AJ §1.1/§1.2/§1.6) ──
   Overlay switches and the chart view (log/linear + window preset) are read from
   localStorage on every stock page and written back the moment they change. They are
   display state and nothing else: no screening predicate, readiness rule, rating or
   build gate reads these keys — switching an overlay off changes what is drawn, never
   what the row is. */
function loadOverlays() {
  try {
    return MSChart.overlayState(JSON.parse(localStorage.getItem(MSChart.OVERLAY_STORAGE_KEY) || "null"));
  } catch { return MSChart.overlayState(null); }
}

function saveOverlays(state) {
  try { localStorage.setItem(MSChart.OVERLAY_STORAGE_KEY, JSON.stringify(state || {})); }
  catch { /* private mode: the switches still apply for this session */ }
}

function loadChartView() {
  try {
    return MSChart.viewState(JSON.parse(localStorage.getItem(MSChart.VIEW_STORAGE_KEY) || "null"));
  } catch { return MSChart.viewState(null); }
}

function saveChartView(view) {
  try { localStorage.setItem(MSChart.VIEW_STORAGE_KEY, JSON.stringify(MSChart.viewState(view))); }
  catch { /* private mode: the view still applies for this session */ }
}

/* The chart's frame colours come from the stylesheet's own variables, read at creation
   and again on every theme switch (SPEC-AH §5). Candles and markers keep their fixed
   palette: they encode direction and events, not the surface they sit on. */
function cssVariable(name, fallback) {
  try {
    const style = getComputedStyle(document.documentElement);
    const value = String(style.getPropertyValue(name) || "").trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

function themedChartOptions() {
  const background = cssVariable("--bg", "#0b0f14");
  const text = cssVariable("--text", "#e6edf5");
  const muted = cssVariable("--muted", "#8a97a8");
  const border = cssVariable("--border", "#2a3542");
  const grid = cssVariable("--border-soft", border);
  return {
    layout: { background: { color: background }, textColor: muted,
      fontFamily: "IBM Plex Mono, monospace" },
    grid: { vertLines: { color: grid }, horzLines: { color: grid } },
    rightPriceScale: { borderColor: border },
    timeScale: { borderColor: border },
    // The crosshair chip takes the foreground colour as its ground; the library picks the
    // contrasting text, so it stays readable in both themes.
    crosshair: { vertLine: { color: muted, labelBackgroundColor: text },
      horzLine: { color: muted, labelBackgroundColor: text } },
  };
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
  /* SPEC-AK §1.3: one mount, one handle. Every listener, observer, subscription and the
     chart itself are registered here and released by ``dispose()``, so the workspace can
     mount the next symbol into the same hosts without leaving a second chart, a second
     click handler on the toolbar or a second keyboard listener behind. */
  const releases = [];
  const bind = (target, type, listener, options) => {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, listener, options);
    releases.push(() => {
      if (typeof target.removeEventListener === "function") {
        target.removeEventListener(type, listener, options);
      }
    });
  };
  const bindAll = (selector, type, listener) =>
    document.querySelectorAll(selector).forEach((node) => bind(node, type, listener));
  const handle = {
    symbol,
    disposed: false,
    // The last bar of the canonical daily history, for a header that wants the session's
    // volume without loading the series a second time.
    lastBar: null,
    handleKey: () => false,
    dispose() {
      if (handle.disposed) return;
      handle.disposed = true;
      while (releases.length) {
        const release = releases.pop();
        try { release(); } catch { /* a torn-down node cannot block the next mount */ }
      }
    },
  };
  if (!container) return handle;

  let daily = [];
  let weekly = [];
  let seriesReference = null;
  let indexCloses = new Map();
  let rsCloses = new Map();
  // Every resource this chart loaded, with the verdict that decided how it was used.
  const resourceNotes = [];
  let weeklyFallback = null;
  try {
    const { payload: series, check, id } = await loadResource(config.seriesPath,
      { kind: "series", instrument: symbol, asOf: config.as_of });
    daily = Array.isArray(series) ? series : series.bars || [];
    seriesReference = Array.isArray(series) ? null : series.reference || null;
    checkBuildId(series.build_id, daily.length ? daily[daily.length - 1][0] : null, id);
    if (!check.ok) {
      // The daily history is the chart: an incompatible one is blocked, never mixed
      // with this build's pattern, stop and risk band.
      container.innerHTML = '<div class="chart-loading negative">The chart is blocked: '
        + `${esc(Resources.describe(check))}. Reload for matching versions.</div>`;
      return handle;
    }
    if (Resources.badge(check)) resourceNotes.push(`price history ${Resources.badge(check)}`);
    if (series.note) {
      const note = document.createElement("p");
      note.className = "fineprint"; note.textContent = series.note;
      (container.parentElement || container).appendChild(note);
    }
  } catch (error) {
    container.innerHTML = `<div class="chart-loading muted">Price series missing from this snapshot: ${esc(error.message)}</div>`;
    return handle;
  }
  if (config.weeklyPath) {
    try {
      const { payload, check, id } = await loadResource(config.weeklyPath,
        { kind: "weekly", instrument: symbol, asOf: config.as_of });
      if (check.ok) {
        weekly = payload.bars || [];
        if (Resources.badge(check)) resourceNotes.push(`weekly history ${Resources.badge(check)}`);
      } else {
        // Not blocked: the weekly view is aggregated from the daily history this build
        // published, and the page says the stored file was rejected.
        weekly = MSChart.aggregate(daily, "W");
        weeklyFallback = `${id} was rejected (${check.reason}); the weekly view is `
          + "aggregated from this build's daily history instead";
        resourceNotes.push(weeklyFallback);
      }
    } catch { weekly = MSChart.aggregate(daily, "W"); }
  } else {
    weekly = MSChart.aggregate(daily, "W");
  }
  for (const [path, target] of [[config.indexPath, "index"], [config.rsIndexPath, "rs"]]) {
    if (!path) continue;
    try {
      const instrument = String(path).split("/").pop().replace(/\.json$/, "");
      const { payload, check, id } = await loadResource(path,
        { kind: "index", instrument, asOf: config.as_of });
      if (!check.ok) {
        // A benchmark that cannot be trusted is not drawn at all: an overlay or an RS
        // line from another build beside a current pattern is exactly the mix the
        // sixth audit found.
        resourceNotes.push(`${target === "index" ? "index overlay" : "RS line"} hidden — `
          + `${Resources.describe(check)}`);
        continue;
      }
      const pairs = payload.closes && payload.closes.length
        ? payload.closes : (payload.bars || []).map((bar) => [bar[0], bar[4]]);
      const map = new Map(pairs.map(([day, value]) => [String(day), Number(value)]));
      if (target === "index") indexCloses = map; else rsCloses = map;
      const observed = (check.envelope || {}).observed_through;
      const badge = Resources.badge(check);
      resourceNotes.push(`${id} last ${observed}${badge ? ` · ${badge}` : ""}`);
    } catch { /* an unpublished index simply has no overlay */ }
  }
  const benchmarkNote = $("chart-benchmarks");
  if (benchmarkNote) benchmarkNote.textContent = resourceNotes.join(" · ");

  if (!daily.length) {
    container.innerHTML = '<div class="chart-loading muted">Price series missing from this snapshot.</div>';
    return handle;
  }
  handle.lastBar = daily[daily.length - 1];
  if (typeof LightweightCharts === "undefined") {
    container.innerHTML = '<div class="chart-loading muted">Chart library unavailable. Technical tables and snapshot figures remain available.</div>';
    return handle;
  }
  container.innerHTML = '<div class="chart-host"></div><svg class="draw-overlay" id="draw-overlay"></svg>'
    + '<div class="buy-zone-band" aria-hidden="true"><span>Risk-approved entry band</span></div>';
  const host = container.querySelector(".chart-host");
  const overlay = $("draw-overlay");
  const band = container.querySelector(".buy-zone-band");
  // The reader's overlay switches and chart view, read before the chart exists so the
  // first paint is already the one they left on the previous stock (SPEC-AJ §1.6).
  let overlays = loadOverlays();
  let view = loadChartView();
  const scaleMode = () => (view.scale === "linear"
    ? LightweightCharts.PriceScaleMode.Normal : LightweightCharts.PriceScaleMode.Logarithmic);
  const chart = LightweightCharts.createChart(host, {
    ...themedChartOptions(),
    rightPriceScale: { ...themedChartOptions().rightPriceScale,
      scaleMargins: MSChart.PRICE_SCALE_MARGINS, mode: scaleMode() },
    timeScale: { ...themedChartOptions().timeScale, timeVisible: false, rightOffset: 4 },
    crosshair: { ...themedChartOptions().crosshair, mode: LightweightCharts.CrosshairMode.Normal },
    height: Math.max(460, container.clientHeight), autoSize: true,
  });
  // Repaint the frame (not the candles) whenever the theme changes — for as long as
  // this chart exists.
  releases.push(onThemeChange(() => chart.applyOptions(themedChartOptions())));
  releases.push(() => chart.remove());
  const candles = chart.addCandlestickSeries({
    upColor: "#4da3ff", downColor: "#ff5fa2", wickUpColor: "#4da3ff", wickDownColor: "#ff5fa2",
    borderVisible: false,
  });
  const volume = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" } });
  // A taller volume pane: the bottom 26 % of the chart instead of 18 %, so a dry-up is
  // legible beside the price bars (SPEC-AJ §1.2).
  chart.priceScale("vol").applyOptions({ scaleMargins: MSChart.VOLUME_SCALE_MARGINS });
  const volumeAverage = chart.addLineSeries({ priceScaleId: "vol", color: "#f5a623", lineWidth: 1,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  // One series per selectable daily average (21/50/150/200); the weekly and monthly sets
  // are shorter, so the spare series simply carry no data.
  const maSeries = MSChart.MA_PERIODS.D.map(() => chart.addLineSeries({ lineWidth: 1.4,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }));
  const rsSeries = chart.addLineSeries({ color: "#2ee6a8", lineWidth: 1.2, priceLineVisible: false,
    lastValueVisible: false, crosshairMarkerVisible: false });
  const indexSeries = chart.addLineSeries({ color: "#8a97a8", lineWidth: 1, priceScaleId: "idx",
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  chart.priceScale("idx").applyOptions({ visible: false,
    scaleMargins: MSChart.PRICE_SCALE_MARGINS });

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
  /* Drawn from the published reference, cleared and redrawn whenever the "52-week lines"
     overlay changes. The levels themselves never change with the timeframe or the zoom. */
  const applyReferenceLines = () => {
    referenceLines.splice(0).forEach((line) => candles.removePriceLine(line));
    if (!priceReference.available || !overlays.reference_52w) return;
    drawPriceLine(priceReference.high, { color: "#3a4756", lineWidth: 1, lineStyle: 3,
      axisLabelVisible: true, title: priceReference.highTitle }, referenceLines);
    drawPriceLine(priceReference.low, { color: "#3a4756", lineWidth: 1, lineStyle: 3,
      axisLabelVisible: true, title: priceReference.lowTitle }, referenceLines);
  };
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
  let bars = [];
  let maStore = loadMaPeriods();
  let maPeriods = MSChart.maSelection(maStore, timeframe);

  /* The "MAs" control: one checkbox per selectable period for the timeframe on screen,
     remembered per timeframe in localStorage. */
  function renderMaControls() {
    const host = $("ma-tools");
    if (!host) return;
    const unit = timeframe === "W" ? "w" : timeframe === "M" ? "m" : "d";
    host.innerHTML = '<span class="ma-label">MAs</span>' + (MSChart.MA_PERIODS[timeframe] || [])
      .map((period) => `<label class="ma-toggle"><input type="checkbox" data-ma="${period}"`
        + `${maPeriods.includes(period) ? " checked" : ""}> ${period}${unit}</label>`).join("");
    bindAll("#ma-tools [data-ma]", "change", () => {
        const chosen = [...document.querySelectorAll("#ma-tools [data-ma]")]
          .filter((entry) => entry.checked).map((entry) => Number(entry.dataset.ma));
        maStore = MSChart.maStore(maStore, timeframe, chosen);
        maPeriods = MSChart.maSelection(maStore, timeframe);
        saveMaPeriods(maStore);
        render();
      });
  }

  function render() {
    bars = timeframe === "D" ? daily : timeframe === "W"
      ? (weekly.length ? weekly : MSChart.aggregate(daily, "W")) : MSChart.aggregate(daily, "M");
    candles.setData(bars.map(([time, open, high, low, close]) => ({ time, open, high, low, close })));
    const volumes = MSChart.volumeSeries(bars, MSChart.VOLUME_PERIODS[timeframe]);
    volume.setData(volumes.map((entry) => ({ time: entry.time, value: entry.value,
      color: entry.up ? "rgba(77,163,255,.35)" : "rgba(255,95,162,.35)" })));
    volumeAverage.setData(volumes.filter((entry) => entry.average !== null)
      .map((entry) => ({ time: entry.time, value: entry.average })));
    // The volume pane names the average it draws, in the units of the timeframe on screen.
    const volumeLegend = $("chart-volume-legend");
    if (volumeLegend) volumeLegend.textContent = MSChart.volumeLegend(timeframe);
    const closes = bars.map((bar) => bar[4]);
    // Display only: the reader's moving-average choice changes what is drawn and nothing
    // else — no score, gate or signal reads it (SPEC-AH §5).
    const periods = maPeriods;
    maSeries.forEach((series, index) => {
      const period = periods[index];
      if (!period) { series.setData([]); return; }
      const values = MSChart.movingAverage(closes, period);
      series.applyOptions({ color: MSChart.maColor(period, timeframe) });
      series.setData(bars.map((bar, position) => values[position] === null
        ? null : { time: bar[0], value: values[position] }).filter(Boolean));
    });
    const legend = $("chart-ma-legend");
    if (legend) legend.textContent = MSChart.maLegend(periods, timeframe);
    // Every overlay below is a switch the reader owns (SPEC-AJ §1.1). An overlay that is
    // off draws nothing; the underlying row, pattern and dates are untouched.
    const rs = overlays.rs_line ? MSChart.rsLine(bars, rsCloses) : { points: [] };
    rsSeries.setData(rs.points.map((point) => ({ time: point.time, value: point.value })));
    const rating = (config.ratings_compact || {}).rs;
    // The events come from the daily history; only their placement follows the timeframe.
    const eventMarkers = overlays.rs_events ? MSChart.eventMarkers(rsEventState, bars, timeframe) : [];
    const latest = overlays.rs_line && rs.points.length && rating
      ? [{ time: rs.points[rs.points.length - 1].time, position: "belowBar", color: "#2ee6a8",
          shape: "arrowUp", text: `RS ${rating}`, kind: "rs_latest" }]
      : [];
    const legMarkers = (overlays.legs
      ? Screener.legMarkers(config.reference_pattern ? [] : config.legs, bars.map((bar) => bar[0]))
      : []).map((marker) => ({ ...marker, kind: "leg" }));
    const markers = MSChart.sortedMarkers(legMarkers, eventMarkers, latest);
    MSChart.assertSortedMarkers(markers);
    candles.setMarkers(markers);
    indexSeries.setData(overlays.index
      ? bars.map((bar) => (indexCloses.has(String(bar[0]))
        ? { time: bar[0], value: indexCloses.get(String(bar[0])) } : null)).filter(Boolean)
      : []);
    priceLines.splice(0).forEach((line) => candles.removePriceLine(line));
    if (overlays.pivot) drawPriceLine(pivot, { color: "#2ee6a8", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "pivot" });
    if (pattern.id && overlays.extension) drawPriceLine(pattern.extension_limit, { color: "#f5a623", lineWidth: 1, lineStyle: 2, title: "5% extension limit" });
    if (pattern.id && overlays.stop) drawPriceLine(pattern.stop, { color: "#ef5350", lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: "stop" });
    const reference = config.reference_pattern?.pivot ?? (!pattern.id ? config.geometry_pivot : null);
    if (Number.isFinite(reference) && overlays.geometry_pivot) drawPriceLine(reference, { color: "#f5a623", lineWidth: 1, lineStyle: 2,
      title: config.reference_pattern ? "power play · flag forming" : "geometry pivot" });
    applyReferenceLines();
    const loaded = MSChart.loadedRange(bars);
    setFineprint("chart-reference", [
      priceReference.available
        ? `${priceReference.note} · lines drawn on every timeframe from the same window`
        : priceReference.note,
      Number.isFinite(loaded.high) && Number.isFinite(loaded.low)
        ? `loaded-range high ₹${fmt(loaded.high, 2)} · loaded-range low ₹${fmt(loaded.low, 2)} (${loaded.bars} ${timeframe} bars)`
        : null,
      MSChart.partialLastNote(daily, timeframe, config.as_of || priceReference.asOf),
      timeframe === "W" && weeklyFallback ? weeklyFallback : null,
      hiddenOverlayNote(),
    ].filter(Boolean).join(" · "));
    setFineprint("panel-reference-window", priceReference.available
      ? `${priceReference.window || "window unknown"} · ${priceReference.status}`
      : "no dated 52-week window in this snapshot");
    applyWindow();
    positionBand();
    renderDrawings();
  }

  /* The window preset is a preference, not a per-symbol state: it is applied after every
     render, so a timeframe switch and the next stock both open on the same window. A
     preset longer than the loaded history falls back to the whole history. */
  function applyWindow() {
    const range = MSChart.windowRange(view.window, timeframe, bars.length);
    if (!range) { chart.timeScale().fitContent(); return; }
    chart.timeScale().setVisibleLogicalRange(range);
  }

  /* The chart says which overlays are switched off, so a missing pivot line is never
     read as "this build has no pivot". */
  function hiddenOverlayNote() {
    const off = MSChart.OVERLAYS.filter((entry) => !overlays[entry.id]).map((entry) => entry.label);
    return off.length ? `overlays off: ${off.join(", ")}` : null;
  }

  const positionBand = () => {
    if (!band) return;
    if (!overlays.risk_band) { band.hidden = true; return; }
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
  let drag = null;

  function svg(name, attributes) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }

  /* The published base as a shaded band (SPEC-AJ §1.1): from ``base_start_date`` to the
     last bar on screen, between ``base_low`` and ``base_high``. The boundaries come from
     the scan; nothing here re-derives a base from the bars that happen to be loaded. */
  function renderBaseBand(width, height) {
    if (!overlays.base_band) return false;
    const model = MSChart.baseBandModel(config.base_band, bars);
    if (!model) return false;
    const left = adapter.timeToCoordinate(model.start);
    const right = adapter.timeToCoordinate(model.end);
    const top = adapter.priceToCoordinate(model.high);
    const bottom = adapter.priceToCoordinate(model.low);
    if (![left, right, top, bottom].every((value) => Number.isFinite(value))) return false;
    const rect = svg("rect", { x: Math.min(left, right), y: Math.min(top, bottom),
      width: Math.max(1, Math.abs(right - left)), height: Math.max(1, Math.abs(bottom - top)),
      fill: "rgba(77,163,255,.10)", stroke: "#4da3ff", "stroke-width": 1,
      "stroke-dasharray": "4 3", "data-overlay": "base_band" });
    const label = svg("title", {});
    label.textContent = model.title;
    rect.appendChild(label);
    overlay.appendChild(rect);
    return true;
  }

  function renderDrawings() {
    if (!overlay) return;
    overlay.innerHTML = "";
    const width = host.clientWidth;
    const height = host.clientHeight;
    overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
    overlay.setAttribute("width", width);
    overlay.setAttribute("height", height);
    // Drawn first, so the reader's own drawings stay on top of it.
    const drawnBand = renderBaseBand(width, height);
    // What the overlay actually drew this pass, for the page's own consistency checks.
    overlay.dataset.overlays = MSChart.OVERLAYS
      .filter((entry) => (entry.id === "base_band" ? drawnBand : overlays[entry.id]))
      .map((entry) => entry.id).join(",");
    for (const drawing of drawings.concat(pending ? [pending] : [])) {
      // Dated points are binned onto the bars actually on screen (SPEC-AH §4), so a
      // drawing made on the daily chart still lands on the right weekly candle.
      const projected = MSChart.project(drawing, adapter, { bars, timeframe });
      if (!projected) continue;
      const stroke = drawing.color;
      const active = selected && selected.id === drawing.id;
      const common = { stroke, "stroke-width": active ? 2.4 : 1.4, fill: "none",
        "data-drawing": drawing.id };
      // Each stroke gets an invisible, wider "hit" twin: in select mode the overlay itself
      // ignores the pointer (the chart keeps its pan and zoom), so only the twins can
      // deliver a mousedown to the select/drag handler below.
      const hit = { class: "hit", "data-drawing": drawing.id };
      if (drawing.tool === "hline") {
        overlay.appendChild(svg("line", { x1: 0, x2: width, y1: projected.y, y2: projected.y, ...common }));
        overlay.appendChild(svg("line", { x1: 0, x2: width, y1: projected.y, y2: projected.y, ...hit }));
      } else if (drawing.tool === "rect") {
        const [a, b] = projected.points;
        overlay.appendChild(svg("rect", { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
          width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y), ...common,
          fill: `${stroke}22` }));
        overlay.appendChild(svg("rect", { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
          width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y), ...hit }));
      } else if (drawing.tool === "text") {
        const [anchor] = projected.points;
        const label = svg("text", { x: anchor.x, y: anchor.y, fill: stroke, "data-drawing": drawing.id,
          "font-size": 12 });
        label.textContent = drawing.text || "note";
        overlay.appendChild(label);
      } else {
        const [a, b] = projected.points;
        // One extension factor for the renderer and the hit test: MSChart.raySegment.
        const extended = drawing.tool === "ray" ? MSChart.raySegment(a, b)[1] : b;
        overlay.appendChild(svg("line", { x1: a.x, y1: a.y, x2: extended.x, y2: extended.y, ...common }));
        overlay.appendChild(svg("line", { x1: a.x, y1: a.y, x2: extended.x, y2: extended.y, ...hit }));
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

  bind(overlay, "mousedown", (event) => {
    const point = pointFromEvent(event);
    if (tool === "select") {
      selected = MSChart.hitTest(drawings, point, adapter, { bars, timeframe });
      // A mousedown on a hit drawing starts a move; the original is kept so Escape can
      // put it back exactly where it was (SPEC-AH §4).
      drag = selected ? { id: selected.id, origin: point,
        original: JSON.parse(JSON.stringify(selected)) } : null;
      // While a drag is live the overlay takes the pointer, so the move keeps tracking
      // after the cursor leaves the thin stroke it started on.
      overlay.classList.toggle("dragging", Boolean(drag));
      if (drag) event.preventDefault();
      renderDrawings();
      return;
    }
    if (!Number.isFinite(point.price)) return;
    // A horizontal line needs a price and nothing else, so it can be dropped anywhere on
    // the pane — including right of the last bar, where there is no date to read.
    if (tool === "hline") {
      drawings.push(MSChart.createDrawing("hline", [{ price: point.price }]));
      persist();
      return;
    }
    if (!point.time) return;
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
  bind(overlay, "mousemove", (event) => {
    if (drag) {
      const point = pointFromEvent(event);
      const stamps = bars.map((bar) => String(bar[0]));
      const from = MSChart.readTime(drag.origin.time);
      const to = MSChart.readTime(point.time);
      const barDelta = from && to ? stamps.indexOf(to) - stamps.indexOf(from) : 0;
      const priceDelta = Number.isFinite(point.price) && Number.isFinite(drag.origin.price)
        ? point.price - drag.origin.price : 0;
      const index = drawings.findIndex((entry) => entry.id === drag.id);
      if (index !== -1) {
        drawings[index] = MSChart.moveDrawing(drag.original, barDelta, priceDelta, stamps);
        selected = drawings[index];
        renderDrawings();
      }
      return;
    }
    if (!pending) return;
    const point = pointFromEvent(event);
    if (!point.time || !Number.isFinite(point.price)) return;
    pending.points[1] = { time: MSChart.readTime(point.time) || point.time, price: point.price };
    renderDrawings();
  });
  bind(overlay, "mouseup", () => {
    if (drag) { drag = null; overlay.classList.remove("dragging"); persist(); return; }
    if (!pending) return;
    drawings.push(pending);
    pending = null;
    persist();
  });
  bindAll("[data-draw]", "click", (event) => {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    tool = button.dataset.draw;
    document.querySelectorAll("[data-draw]").forEach((other) =>
      other.setAttribute("aria-pressed", String(other === button)));
    overlay?.classList.toggle("drawing", tool !== "select");
  });
  bindAll('[data-draw-action="clear"]', "click", () => {
    drawings = []; selected = null; persist();
  });
  bindAll('[data-draw-action="export"]', "click", () => {
    downloadText(`${symbol}-drawings.json`, MSChart.exportDrawings(symbol, drawings), "application/json");
  });
  bindAll('[data-draw-action="import"]', "click", () => {
    const text = window.prompt("Paste exported drawings JSON");
    if (!text) return;
    try { drawings = drawings.concat(MSChart.importDrawings(text)); persist(); }
    catch { window.alert("That is not a drawings export from this app."); }
  });

  bindAll("[data-timeframe]", "click", (event) => {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    timeframe = button.dataset.timeframe;
    try { localStorage.setItem(TIMEFRAME_KEY, timeframe); } catch { /* private mode */ }
    document.querySelectorAll("[data-timeframe]").forEach((other) =>
      other.setAttribute("aria-pressed", String(other.dataset.timeframe === timeframe)));
    maPeriods = MSChart.maSelection(maStore, timeframe);
    renderMaControls();
    // The window is a preference, not a per-symbol or per-timeframe state: it is
    // re-applied inside render() after every switch (SPEC-AJ §1.2).
    render();
  });
  /* One checkbox per overlay, filled from the shared vocabulary so the toolbar and the
     module can never disagree about which overlays exist. */
  function renderOverlayControls() {
    const tools = $("overlay-tools");
    if (!tools) return;
    tools.innerHTML = '<span class="ma-label">Overlays</span>' + MSChart.OVERLAYS
      .map((entry) => `<label class="ma-toggle" title="${esc(entry.label)} (display only)">`
        + `<input type="checkbox" data-overlay="${esc(entry.id)}"`
        + `${overlays[entry.id] ? " checked" : ""}> ${esc(entry.label)}</label>`).join("");
    bindAll("#overlay-tools [data-overlay]", "change", (event) => {
      const input = event?.currentTarget || event?.target;
      if (!input) return;
      overlays = MSChart.overlayStore(overlays, input.dataset.overlay, input.checked);
      saveOverlays(overlays);
      render();
    });
  }

  /* 6M · 1Y · 2Y · All, from the same module vocabulary. */
  function renderWindowControls() {
    const host = $("window-presets");
    if (!host) return;
    host.innerHTML = '<span class="ma-label">Window</span>' + MSChart.WINDOW_PRESETS
      .map((preset) => `<button type="button" data-window="${esc(preset.id)}" `
        + `aria-pressed="${preset.id === view.window}">${esc(preset.label)}</button>`).join("");
    bindAll("#window-presets [data-window]", "click", (event) => {
        const button = event?.currentTarget || event?.target;
        if (!button) return;
        view = MSChart.viewStore(view, { window: button.dataset.window });
        saveChartView(view);
        document.querySelectorAll("#window-presets [data-window]").forEach((other) =>
          other.setAttribute("aria-pressed", String(other.dataset.window === view.window)));
        applyWindow();
      });
  }

  function renderScaleControl() {
    const button = $("toggle-scale");
    if (!button) return;
    button.textContent = view.scale === "linear" ? "Linear" : "Log";
    button.setAttribute("aria-pressed", String(view.scale === "log"));
  }

  bind($("toggle-scale"), "click", () => {
    view = MSChart.viewStore(view, { scale: view.scale === "log" ? "linear" : "log" });
    saveChartView(view);
    renderScaleControl();
    chart.priceScale("right").applyOptions({ mode: scaleMode() });
    positionBand();
    renderDrawings();
  });
  bindAll("[data-expand]", "click", (event) => {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    button.previousElementSibling?.classList.add("expanded");
    button.remove();
  });

  /* Every key this chart owns. The page decides who listens: a stock route lets the
     chart register the listener itself (and ``dispose`` removes it); the full-screen
     workspace passes ``keyboard: false`` and forwards the events from its own single
     listener, so mounting the next symbol never adds a second one (SPEC-AK §1.3).
     Returns true when the chart consumed the event. */
  const onKeyDown = (event) => {
    const action = MSChart.keyAction(event);
    if (!action) return false;
    if (action === "next" || action === "prev") { event.preventDefault(); move(action === "next" ? 1 : -1); return true; }
    if (action === "first" || action === "last") {
      const target = action === "first" ? 0 : context.symbols.length - 1;
      if (context.symbols.length) gotoListEntry(context, { ok: true, index: target, symbol: context.symbols[target] });
      return true;
    }
    if (action === "fullscreen") {
      // SPEC-AK §1.4: F opens this symbol in the full-screen workspace, with the list
      // context the page is already carrying.
      if (chartViewHref) window.location.href = chartViewHref;
      return true;
    }
    if (action.startsWith("timeframe:")) {
      document.querySelector(`[data-timeframe="${action.slice(10)}"]`)?.click();
      return true;
    }
    if (action === "panel") { setPanel(panelHidden()); return true; }
    if (action === "list") { toggleListDrawer(context); return true; }
    if (action === "cancel") {
      const active = Boolean(drag || pending || selected || tool !== "select");
      // Escape during a drag restores the drawing exactly as it was before the move.
      if (drag) {
        const index = drawings.findIndex((entry) => entry.id === drag.id);
        if (index !== -1) drawings[index] = drag.original;
        drag = null;
        overlay?.classList.remove("dragging");
      }
      pending = null; selected = null; tool = "select"; renderDrawings();
      return active;
    }
    if (action === "delete" && selected) {
      drawings = drawings.filter((entry) => entry.id !== selected.id);
      selected = null;
      persist();
      return true;
    }
    if (action.startsWith("tab:")) { gotoTab(Number(action.slice(4))); return true; }
    return false;
  };
  handle.handleKey = onKeyDown;
  if (mount.keyboard !== false) bind(window, "keydown", onKeyDown);

  const onTimeRange = () => { positionBand(); renderDrawings(); };
  chart.timeScale().subscribeVisibleTimeRangeChange(onTimeRange);
  chart.timeScale().subscribeVisibleLogicalRangeChange(positionBand);
  releases.push(() => {
    const scale = chart.timeScale();
    scale.unsubscribeVisibleTimeRangeChange?.(onTimeRange);
    scale.unsubscribeVisibleLogicalRangeChange?.(positionBand);
  });
  const resize = new ResizeObserver(() => { positionBand(); renderDrawings(); });
  resize.observe(host);
  releases.push(() => resize.disconnect());
  document.querySelectorAll("[data-timeframe]").forEach((other) =>
    other.setAttribute("aria-pressed", String(other.dataset.timeframe === timeframe)));
  renderMaControls();
  renderOverlayControls();
  renderWindowControls();
  renderScaleControl();
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => { positionBand(); renderDrawings(); }));
  return handle;
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
  let stockCheck = null;
  let stockResourceId = `stock/${requested}`;
  try {
    const loaded = await loadResource(
      `${config.stockPath || "/data/stock/"}${encodeURIComponent(requested)}.json`,
      { kind: "stock", instrument: requested, asOf: config.as_of });
    stock = loaded.payload;
    stockCheck = loaded.check;
    stockResourceId = loaded.id;
  } catch {
    if (hero) hero.innerHTML = technicalNotFound(requested, config.as_of);
    for (const id of ["chart-card", "technical-financials", "technical-pattern", "technical-lists"]) hide($(id));
    return;
  }
  checkBuildId(stock.build_id, stock.last_date || config.as_of, stockResourceId);
  if (stockCheck && !stockCheck.ok) {
    // The row this page renders (pattern, stop, ratings) is the resource: an
    // incompatible one is reported instead of being drawn as current.
    if (hero) {
      hero.innerHTML = `<h1>${esc(requested)}</h1><p class="list-empty negative">`
        + `${esc(Resources.describe(stockCheck))}. Reload for matching versions.</p>`;
    }
    for (const id of ["chart-card", "technical-financials", "technical-pattern",
      "technical-lists"]) hide($(id));
    return;
  }
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
  renderListPanel(context);
  const move = bindListNavigation(context);
  setPanel(panelOpen());
  $("toggle-panel")?.addEventListener("click", () => setPanel(panelHidden()));
  setChartViewLink(symbol, context);

  const pattern = qualification.pattern || {};
  const chartConfig = {
    symbol, name: stock.name || symbol, as_of: config.as_of,
    seriesPath: `${config.seriesPath || "/data/series/"}${encodeURIComponent(symbol)}.json`,
    weeklyPath: null,
    indexPath: config.indexPath || "/data/index/NIFTY50.json",
    rsIndexPath: config.rsIndexPath || "/data/index/NIFTY500.json",
    qualification, legs: base.legs || [], geometry_pivot: base.pivot_hint ?? null,
    base_band: { start_date: base.base_start_date ?? null, low: base.base_low ?? null,
      high: base.base_high ?? null },
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

/* ── the full-screen chart workspace (SPEC-AK) ────────────────────────────────
   One published page, ``/chart/?symbol=…&list=…&sort=…&i=…``, renders any scanned symbol
   in a viewport-filling workspace: the header strip, the ordered list the reader arrived
   from, the data panel with the quarterly block, and the chart. Space moves to the next
   symbol in that list WITHOUT a page load — the hosts are re-filled, the chart is
   disposed and re-mounted, and ``history.pushState`` records the move — so the browser's
   native full-screen state (and the reader's scroll, zoom and drawings tool) survive.

   Nothing here re-implements a panel: a symbol with a full research page renders the
   fragments that page published (``data/stock-detail/<SYM>.json``), and every other
   symbol renders the technical panel from ``data/stock/<SYM>.json``. Every fetch goes
   through ``loadResource``, so a foreign or missing file is reported, never drawn as
   this build's. */

const CHARTVIEW_EPS_DUE = "n/a (no results-calendar feed)";
const CHARTVIEW_DETAIL_ONLY = "published with the full research payload; this symbol has "
  + "a technical page in this snapshot";

function chartViewFigure(key, label, value, note, extra) {
  const missing = value === null || value === undefined || value === "";
  const title = missing ? (note || "not available in this snapshot") : (note || "");
  return `<div data-figure="${esc(key)}"${title ? ` title="${esc(title)}"` : ""}>`
    + `<span>${esc(label)}</span>`
    + `<b${missing ? ' class="na"' : ""}>${missing ? "n/a" : esc(value)}</b>`
    + (extra ? `<em>${esc(extra)}</em>` : "") + "</div>";
}

/* The header strip's figures, from the compact row this build published for the symbol
   plus (on a full page) its financial payload. A figure this snapshot does not carry
   prints "n/a" with the reason it is missing as its title — never a blank. */
function chartViewFigures(stock, detail) {
  const facts = { ...((stock || {}).facts || {}), ...((detail || {}).facts || {}) };
  const notes = { ...((stock || {}).facts_notes || {}), ...((detail || {}).facts_notes || {}) };
  const reason = (key) => notes[key] || (detail ? "not available in this snapshot"
    : CHARTVIEW_DETAIL_ONLY);
  const number = (value, digits = 0) => (value === null || value === undefined
    ? null : fmt(value, digits));
  const reference = (detail || {}).reference || {};
  const high = facts.hi_52w ?? reference.high;
  const low = facts.lo_52w ?? reference.low;
  const volume = facts.volume_last;
  return [
    chartViewFigure("market_cap", "Market cap", number(facts.market_cap_cr) && `₹${fmt(facts.market_cap_cr, 0)} Cr`,
      reason("market_cap_cr"), facts.market_cap_source || ""),
    chartViewFigure("float", "Shares float", number(facts.float_cr, 2) && `${fmt(facts.float_cr, 2)} Cr`,
      reason("float_cr")),
    chartViewFigure("shares_outstanding", "Shares out", number(facts.shares_outstanding_cr, 2)
      && `${fmt(facts.shares_outstanding_cr, 2)} Cr`, reason("shares_outstanding_cr")),
    chartViewFigure("sales_ttm", "Sales (TTM)", number(facts.sales_ttm_cr) && `₹${fmt(facts.sales_ttm_cr, 0)} Cr`,
      reason("sales_ttm_cr")),
    chartViewFigure("avg_volume_50d", "50-day avg vol", number(facts.avg_volume_50d), reason("avg_volume_50d")),
    chartViewFigure("off_52w_high", "Off 52w high", number(facts.off_52w_high_pct, 1)
      && `${signed(facts.off_52w_high_pct)}`, reason("off_52w_high_pct")),
    chartViewFigure("reference_52w", "52-week hi–lo", high === null || high === undefined || low === null
      || low === undefined ? null : `₹${fmt(low, 2)} – ₹${fmt(high, 2)}`,
    "the dated 52-week window this build published with the series"),
    chartViewFigure("eps_due", "EPS due", null, CHARTVIEW_EPS_DUE),
    chartViewFigure("price", "Price", (stock || {}).close === null || (stock || {}).close === undefined
      ? null : `₹${fmt(stock.close, 2)}`, "last published close",
    (stock || {}).last_date || ""),
    chartViewFigure("change", "Change", (stock || {}).chg_pct === null || (stock || {}).chg_pct === undefined
      ? null : signed(stock.chg_pct), "change on the last published session"),
    chartViewFigure("volume", "Volume", volume === null || volume === undefined ? null : fmt(volume, 0),
      volume === null || volume === undefined ? reason("volume_last")
        : "last published session"),
    chartViewFigure("rs_tt_stage", "RS · TT · Stage", `${fmt((stock || {}).rs, 0)} · `
      + `${fmt(((stock || {}).tt || {}).passed, 0)}/8 · ${(stock || {}).stage || "unknown"}`,
    "relative strength, Trend Template and stage from this snapshot"),
  ].join("");
}

async function initChartView() {
  const configNode = $("chartview-config");
  if (!configNode) return null;
  let config = {};
  try { config = JSON.parse(configNode.textContent); } catch { config = {}; }
  const search = $("chartview-search");
  const requested = String(new URLSearchParams(window.location.search).get("symbol") || "")
    .trim().toUpperCase();
  // The list the reader arrived from, read once. Walking it only changes the index, so
  // the workspace never refetches a list payload to move one row.
  let base = await loadListContext(requested);
  let context = base;
  let handle = null;
  let disposals = 0;
  let current = "";

  const rebase = (symbol, index) => {
    const at = Number.isInteger(index) ? index : (base.symbols || []).indexOf(symbol);
    const next = MSChart.listContext({ id: base.id, title: base.title, build_id: base.build_id,
      symbols: base.symbols, index: at, sort: base.sort, pages: base.pages,
      unresolved: base.unresolved, fallback: base.fallback }, symbol);
    next.reasons = base.reasons;
    next.error = base.error;
    return next;
  };

  const status = (text) => { const node = $("chartview-position"); if (node) node.textContent = text; };
  const notes = (text) => { const node = $("chartview-notes"); if (node) node.textContent = text || ""; };

  const move = (step) => {
    const label = $("list-position");
    const confirmWrap = label?.dataset.confirmWrap === "1";
    const result = MSChart.advance(context, step, { confirmWrap });
    if (label) delete label.dataset.confirmWrap;
    if (!result.ok) {
      if (label && result.needsConfirmation) {
        label.textContent = `${result.reason} — press again to wrap`;
        label.dataset.confirmWrap = "1";
      }
      return false;
    }
    showSymbol(result.symbol, { index: result.index });
    return true;
  };

  const jump = (position) => {
    if (!(context.symbols || []).length) return;
    const index = Math.max(0, Math.min(context.symbols.length - 1, position));
    showSymbol(context.symbols[index], { index });
  };

  async function mountChart(chartConfig) {
    if (handle) { handle.dispose(); handle = null; disposals += 1; }
    handle = await initChart(chartConfig, context,
      { container: $("chart"), move, gotoTab: () => {}, keyboard: false });
    return handle;
  }

  /* One symbol into the workspace. ``push`` records the move in the session history;
     a popstate replay passes ``push: false`` so the back button does not re-push. */
  async function showSymbol(symbol, options = {}) {
    const wanted = String(symbol || "").trim().toUpperCase();
    if (!wanted || !TECHNICAL_SYMBOL_RE.test(wanted)) return null;
    current = wanted;
    context = rebase(wanted, options.index);
    activeListContext = context;
    document.title = `${wanted} · chart — SEPA Terminal`;
    const name = $("chartview-name");
    if (name) name.textContent = wanted;
    if (search) search.value = "";
    renderListPanel(context);
    renderListNav(context);
    rememberListContext(context, { source: "url" });
    status(`${context.position || `not in ${context.title || context.id || "any list"}`}`
      + `${context.sort ? ` · sorted by ${context.sort.key} ${context.sort.direction}` : ""}`);
    if (options.push !== false) {
      const url = Lists.chartLink(context.id, context.symbols, wanted, basePath(),
        { sort: context.sort, pages: context.pages });
      try { window.history.pushState({ symbol: wanted, index: context.index }, "", url); }
      catch { /* a browser that refuses the state change still shows the symbol */ }
    }
    const exit = $("chartview-exit");
    if (exit) {
      // The route manifest resolves the destination, so a symbol reached from the search
      // box (and therefore not in the list) still opens its own page.
      const href = Lists.listLink(context.id, context.symbols, wanted, basePath(),
        { sort: context.sort, pages: routePages || context.pages });
      exit.href = href;
      exit.setAttribute("href", href);
    }

    let stock = null;
    let check = null;
    let resourceId = `stock/${wanted}`;
    try {
      const loaded = await loadResource(
        `${config.stockPath || "/data/stock/"}${encodeURIComponent(wanted)}.json`,
        { kind: "stock", instrument: wanted, asOf: config.as_of });
      stock = loaded.payload;
      check = loaded.check;
      resourceId = loaded.id;
    } catch {
      renderMissing(wanted, `${wanted} is not in this snapshot (as of `
        + `${config.as_of || "unknown"}). It may be outside the scanned universe or `
        + "excluded by the universe ledger.");
      return null;
    }
    checkBuildId(stock.build_id, stock.last_date || config.as_of, resourceId);
    if (check && !check.ok) {
      // The row this workspace renders is the resource: an incompatible one is reported
      // with the symbol still in the header, never drawn as current.
      renderMissing(wanted, `${Resources.describe(check)}. Reload for matching versions.`);
      return null;
    }
    if (name) name.textContent = `${stock.name || wanted} · ${wanted}`;
    const route = Lists.pageOf(wanted, routePages) || "technical";
    let detail = null;
    if (route === "full") {
      try {
        const loaded = await loadResource(
          `${config.detailPath || "/data/stock-detail/"}${encodeURIComponent(wanted)}.json`,
          { kind: "stock_detail", instrument: wanted, asOf: config.as_of });
        detail = loaded.check.ok ? loaded.payload : null;
        if (!loaded.check.ok) notes(Resources.describe(loaded.check));
      } catch { detail = null; }
    }
    renderHeader(wanted, stock, detail, route);
    renderPanels(wanted, stock, detail, route);
    initStockActions({ ...stock, symbol: wanted });
    const mounted = await mountChart(chartConfig(wanted, stock, detail));
    // Only the daily history knows the last session's volume when the compact row does
    // not carry it, so the figure is filled in once the chart has loaded that series.
    if (mounted && mounted.lastBar && (stock.facts || {}).volume_last === undefined) {
      const cell = document.querySelector('#chartview-figures [data-figure="volume"] b');
      if (cell) { cell.textContent = fmt(mounted.lastBar[5], 0); cell.className = ""; }
    }
    return mounted;
  }

  function renderMissing(symbol, message) {
    const name = $("chartview-name");
    if (name) name.textContent = symbol;
    const meta = $("chartview-meta");
    if (meta) meta.textContent = "";
    const figures = $("chartview-figures");
    if (figures) figures.innerHTML = "";
    const host = $("chartview-data");
    if (host) {
      host.innerHTML = '<div class="data-panel" id="data-panel">'
        + `<p class="list-empty">${esc(message)}</p>`
        + `<p class="fineprint"><a href="${esc(siteUrl(`/?q=${encodeURIComponent(symbol)}#screener`))}">`
        + `Search the screener for ${esc(symbol)} →</a></p></div>`;
    }
    const chart = $("chart");
    if (chart) chart.innerHTML = `<div class="chart-loading muted">${esc(message)}</div>`;
    if (handle) { handle.dispose(); handle = null; disposals += 1; }
    notes(message);
  }

  function renderHeader(symbol, stock, detail, route) {
    const group = (stock || {}).group || {};
    const links = (detail || {}).links || {};
    const website = links.website || links.screener || null;
    const meta = $("chartview-meta");
    if (meta) {
      meta.innerHTML = [
        `<b>${esc(symbol)}</b>`,
        esc(group.name || "unmapped industry group"),
        group.rank ? `rank ${esc(group.rank)} of ${esc(group.of)}` : "no ranked group",
        website ? `<a href="${esc(website)}" rel="noopener nofollow" target="_blank">website ↗</a>`
          : "no website in this snapshot",
        route === "full" ? "full research page" : "technical view (no financial deep dive)",
      ].join(" · ");
    }
    const about = $("chartview-about");
    if (about) {
      about.textContent = (detail || {}).about
        || `No description is cached for ${symbol} in this snapshot.`;
      about.classList.remove("expanded");
    }
    const figures = $("chartview-figures");
    if (figures) figures.innerHTML = chartViewFigures(stock, detail);
  }

  function renderPanels(symbol, stock, detail, route) {
    const host = $("chartview-data");
    if (!host) return;
    if (detail && (detail.fragments || {}).data_panel) {
      // The full page's own markup, published with it: the workspace shows the panel and
      // the quarterly block byte for byte, it does not re-render them.
      host.innerHTML = detail.fragments.data_panel + (detail.fragments.quarterly_block || "");
      initQuarterlyBlock();
      return;
    }
    const coverage = config.coverage || {};
    host.innerHTML = '<div class="data-panel" id="data-panel"></div>'
      + '<section class="card"><span class="eyebrow">FINANCIAL RECORD</span>'
      + "<h2>Financial record</h2>"
      + `<p>No financial deep dive for ${esc(symbol)} in this snapshot — full pages cover `
      + `${fmt(coverage.full, 0)} of ${fmt(coverage.rows, 0)} symbols (Trend Template ≥ 6/8 `
      + "and the turnover gate). Fundamentals: unknown, not failed.</p>"
      + (route === "full"
        ? '<p class="fineprint negative">This symbol has a full research page, but its '
          + 'detail file could not be read in this snapshot.</p>' : "")
      + `<p class="fineprint"><a href="${esc(siteUrl(`/?q=${encodeURIComponent(symbol)}#screener`))}">`
      + "Open this row in the screener →</a></p></section>";
    renderTechnicalPanel(stock);
  }

  /* The chart's configuration: the full page's own payload when there is one, otherwise
     the same object the technical route assembles from the compact row. */
  function chartConfig(symbol, stock, detail) {
    if (detail) {
      return { ...detail, symbol, as_of: detail.as_of || config.as_of };
    }
    const base_ = (stock || {}).base || {};
    const power = (stock || {}).power_play || {};
    const qualification = (stock || {}).qualification || {};
    const pattern = qualification.pattern || {};
    return {
      symbol, name: (stock || {}).name || symbol, as_of: config.as_of,
      seriesPath: `${config.seriesPath || "/data/series/"}${encodeURIComponent(symbol)}.json`,
      weeklyPath: null,
      indexPath: config.indexPath || "/data/index/NIFTY50.json",
      rsIndexPath: config.rsIndexPath || "/data/index/NIFTY500.json",
      qualification, legs: base_.legs || [], geometry_pivot: base_.pivot_hint ?? null,
      base_band: { start_date: base_.base_start_date ?? null, low: base_.base_low ?? null,
        high: base_.base_high ?? null },
      reference_pattern: !pattern.id && power.flag === true
        ? { id: "power_play", pivot: power.pivot ?? null } : null,
      ratings_compact: (stock || {}).ratings || {}, tick_size: (stock || {}).tick_size ?? null,
      close: (stock || {}).close, chg_pct: (stock || {}).chg_pct,
    };
  }

  const toggleFullscreen = () => {
    const button = $("chartview-fullscreen");
    try {
      if (document.fullscreenElement) {
        document.exitFullscreen?.();
        button?.setAttribute("aria-pressed", "false");
      } else {
        document.documentElement.requestFullscreen?.();
        button?.setAttribute("aria-pressed", "true");
      }
    } catch { /* a browser that refuses full screen keeps the page's own full viewport */ }
  };

  const exitToPage = () => {
    const href = $("chartview-exit")?.href;
    if (href) window.location.href = href;
  };

  // ── the page's controls, bound once ──────────────────────────────────────
  $("list-prev")?.addEventListener("click", () => move(-1));
  $("list-next")?.addEventListener("click", () => move(1));
  $("list-open")?.addEventListener("click", () => toggleListDrawer(context));
  $("chartview-fullscreen")?.addEventListener("click", toggleFullscreen);
  $("chartview-about")?.addEventListener("click", (event) =>
    event.currentTarget?.classList?.toggle("expanded"));
  $("toggle-panel")?.addEventListener("click", () => setPanel(panelHidden()));
  search?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const wanted = String(search.value || "").trim().toUpperCase();
    if (wanted) showSymbol(wanted);
  });
  // A click on a list row stays in the workspace; a middle-click or a modified click is
  // left to the browser, so "open in a new tab" still works.
  document.addEventListener?.("click", (event) => {
    const link = event.target?.closest?.("a[data-chart-symbol]");
    if (!link || event.defaultPrevented) return;
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const index = Number.parseInt(link.dataset.chartIndex, 10);
    showSymbol(link.dataset.chartSymbol, { index: Number.isInteger(index) ? index : undefined });
  });
  window.addEventListener("popstate", (event) => {
    const state = (event && event.state) || {};
    const symbol = state.symbol
      || String(new URLSearchParams(window.location.search).get("symbol") || "");
    if (symbol) showSymbol(symbol, { push: false, index: state.index });
  });
  /* One keyboard listener for the whole workspace, registered once — not per mount. The
     chart is handed only the keys it owns (drawings), through the handle. It listens in
     the capture phase so it sees the shortcut overlay still open on Escape: the bubbling
     handler that closes that overlay must not also send the reader back to the page. */
  window.addEventListener("keydown", (event) => {
    const action = MSChart.keyAction(event);
    if (!action) return;
    if (action === "next" || action === "prev") { event.preventDefault(); move(action === "next" ? 1 : -1); return; }
    if (action === "first") { jump(0); return; }
    if (action === "last") { jump((context.symbols || []).length - 1); return; }
    if (action === "fullscreen") { event.preventDefault(); toggleFullscreen(); return; }
    if (action === "search") { event.preventDefault(); search?.focus?.(); return; }
    if (action.startsWith("timeframe:")) {
      document.querySelector(`[data-timeframe="${action.slice(10)}"]`)?.click();
      return;
    }
    if (action === "panel") { setPanel(panelHidden()); return; }
    if (action === "list") { toggleListDrawer(context); return; }
    if (action === "cancel") {
      // A pending drawing first, then the browser's own full-screen exit, and only then
      // back to the page this symbol came from.
      if (handle && handle.handleKey(event)) return;
      if ($("key-help") && $("key-help").hidden === false) return;
      if (document.fullscreenElement) return;
      exitToPage();
      return;
    }
    if (handle) handle.handleKey(event);
  }, true);

  setPanel(panelOpen());
  renderListPanel(context);
  renderListNav(context);
  await loadRoutes(config.routesPath || "/data/routes.json");
  if (!requested || !TECHNICAL_SYMBOL_RE.test(requested)) {
    renderMissing(requested || "No symbol requested",
      "Open a stock from a list, or use the screener to find one.");
    status("no symbol requested");
    return { showSymbol, disposals: () => disposals, context: () => context };
  }
  await showSymbol(requested, { push: false, index: base.index });
  return { showSymbol, disposals: () => disposals, context: () => context,
    handle: () => handle };
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
    const loaded = await loadResource(config.path, { kind: "list", asOf: config.as_of });
    payload = loaded.payload;
    checkBuildId(payload.build_id, payload.as_of, loaded.id);
    if (!loaded.check.ok) {
      target.insertAdjacentHTML("afterbegin",
        `<p class="fineprint negative">${esc(Resources.describe(loaded.check))}; the table `
        + "above is this build's published snapshot and the live controls are disabled.</p>");
      return;
    }
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
  /* SPEC-AK §1.4: the same row, opened straight in the full-screen workspace with the
     order the reader is looking at — so the ⛶ on a card and Space in the workspace walk
     one list. */
  const chartFor = (rows, symbol) => Lists.chartLink(payload.id, rows.map((row) => String(row.symbol)),
    String(symbol), document.documentElement.dataset.basePath || "",
    { sort: currentSort(), pages });
  const chartMark = (rows, symbol) => `<a class="chart-view-link" href="${esc(chartFor(rows, symbol))}"`
    + ` title="Open ${esc(symbol)} in the full-screen chart"`
    + ` aria-label="Open ${esc(symbol)} in the full-screen chart">⛶</a>`;

  function ordered() {
    return Lists.sortRows(payload.rows, sortKey, Lists.defaultDirection(sortKey), extrasFor);
  }

  function renderTable(rows, all) {
    const head = payload.columns.map((key) => `<th>${esc((payload.column_labels || {})[key] || key)}</th>`).join("");
    const body = rows.map((row) => `<tr>${payload.columns.map((key) => {
      if (key === "symbol") {
        return `<td><a class="list-symbol" href="${esc(linkFor(all, row.symbol))}">${esc(row.symbol)}</a>`
          + `${chartMark(all, row.symbol)}</td>`;
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
      return `<article class="list-card">${chartMark(all, card.symbol)}<a href="${esc(href)}"><header><b>${esc(card.symbol)}</b><small>${esc(card.name)}</small></header>
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

/* The symbol the action bar is pointed at, and whether its controls are already bound.
   The stock routes call ``initStockActions`` once; the full-screen workspace calls it
   again for every symbol, and must not end up with one handler per stock (SPEC-AK §1.3):
   the handlers read ``actionSymbol``/``actionPayload``, which the next call re-points. */
let actionSymbol = "";
let actionPayload = {};
let actionsBound = false;

function initStockActions(payload) {
  const host = $("stock-actions");
  if (!host) return;
  const symbol = String(payload.symbol || host.dataset.symbol || "");
  actionSymbol = symbol;
  actionPayload = payload || {};
  host.dataset.symbol = symbol;
  const status = $("action-status");
  const store = lists();
  MyLists.touchRecent(store, symbol);
  persistLists();
  const refresh = () => {
    for (const [id, list] of [["action-favorite", "favorites"], ["action-like", "liked"],
      ["action-dislike", "disliked"]]) {
      const button = $(id);
      if (button) button.setAttribute("aria-pressed", String(MyLists.has(lists(), list, actionSymbol)));
    }
  };
  const announce = (text) => { const node = $("action-status") || status;
    if (node) node.textContent = text; };
  /* SPEC-AJ §1.5: a saved review decision. It is a note to yourself — stored in this
     browser under My Lists → Reviewed, carried by the local app's /api/lists sync, and
     nothing else. No AI verdict, no order, nothing leaves the page. */
  const reviewContext = () => {
    let stored = null;
    try { stored = JSON.parse(sessionStorage.getItem(LIST_CONTEXT_KEY) || "null"); }
    catch { stored = null; }
    const requested = new URLSearchParams(window.location.search).get("list");
    return { list: requested || (stored || {}).id || null, build_id: pageBuildId() || null };
  };
  const showReview = () => {
    const saved = MyLists.reviewOf(lists(), actionSymbol);
    const node = $("review-state");
    if (node) {
      node.textContent = saved
        ? `${MyLists.reviewLabel(saved)}${saved.note ? ` · ${saved.note}` : ""}`
        : "Not reviewed in this browser.";
    }
    const select = $("review-decision");
    if (select && saved && saved.decision) select.value = saved.decision;
  };
  refresh();
  showReview();
  // Bound once per page: the workspace re-points the same controls at the next symbol.
  if (actionsBound) return;
  actionsBound = true;
  $("action-favorite")?.addEventListener("click", () => {
    MyLists.toggle(lists(), "favorites", { symbol: actionSymbol });
    persistLists(); refresh();
    renderListPanel();
    announce(MyLists.has(lists(), "favorites", actionSymbol) ? `${actionSymbol} added to Favorite Stocks` : `${actionSymbol} removed from Favorite Stocks`);
  });
  for (const [id, verdict] of [["action-like", "liked"], ["action-dislike", "disliked"]]) {
    $(id)?.addEventListener("click", () => {
      MyLists.opinion(lists(), actionSymbol, verdict);
      persistLists(); refresh();
      renderListPanel();
      announce(MyLists.has(lists(), verdict, actionSymbol) ? `${actionSymbol} marked ${verdict}` : `${actionSymbol} cleared`);
    });
  }
  $("action-add")?.addEventListener("click", () => {
    const named = MyLists.listsOf(lists()).filter((list) => !list.builtin).map((list) => list.title);
    const answer = window.prompt(`Add ${actionSymbol} to which list?${named.length ? ` Existing: ${named.join(", ")}` : ""}`, named[0] || "Watchlist");
    if (!answer) return;
    const existing = MyLists.listsOf(lists()).find((list) => list.title === answer);
    const id = existing ? existing.id : MyLists.createList(lists(), answer);
    MyLists.add(lists(), id, { symbol: actionSymbol }, { title: answer, kind: "custom" });
    persistLists();
    announce(`${actionSymbol} added to ${answer}`);
  });
  $("action-review")?.addEventListener("click", () => {
    const decision = $("review-decision")?.value;
    if (!MyLists.DECISIONS.includes(decision)) {
      announce("Choose buy-plan, watch or pass before saving a decision.");
      return;
    }
    const existing = MyLists.reviewOf(lists(), actionSymbol);
    const note = window.prompt(`Note for ${actionSymbol} (optional)`, (existing || {}).note || "");
    // Cancelled: the decision already saved for this symbol stands, unchanged.
    if (note === null) return;
    MyLists.review(lists(), actionSymbol, { decision, note, context: reviewContext() });
    persistLists();
    showReview();
    renderListPanel();
    announce(`${actionSymbol} reviewed · ${decision} (stored in this browser)`);
  });
  $("action-position")?.addEventListener("click", () => {
    const quantity = window.prompt(`Quantity of ${actionSymbol}`, "");
    if (quantity === null) return;
    const price = window.prompt(`Average price paid for ${actionSymbol}`, "");
    if (price === null) return;
    const date = window.prompt("Entry date (YYYY-MM-DD, optional)", new Date().toISOString().slice(0, 10));
    const pattern = (actionPayload.qualification || {}).pattern || {};
    MyLists.add(lists(), "portfolio", { symbol: actionSymbol }, { kind: "portfolio", title: "My Portfolio" });
    MyLists.updateHolding(lists(), actionSymbol, {
      qty: quantity, avg_price: price, entry_date: date,
      entry_pivot: pattern.pivot, entry_stop: pattern.stop, entry_buy_high: pattern.buy_zone_high,
    });
    persistLists();
    announce(`${actionSymbol} recorded in My Portfolio (${quantity} @ ${price})`);
  });
}

/* ── §3 / §4 the browser-local pages ─────────────────────────────────────── */
/* Every symbol a reader's own list can hold resolves through the published route
   manifest: an imported symbol with no full page still opens its technical view. */
const portfolioView = Portfolio.renderers({ esc, fmt, signed, cls, url: siteUrl,
  stockUrl: (symbol) => Lists.stockHref(symbol, basePath(), routePages),
  contextUrl: (listId, symbol, index) => Lists.listLink(`my:${listId}`,
    [String(symbol)], String(symbol), basePath(), { pages: routePages })
    .replace(/&i=0$/, `&i=${index}`),
  // SPEC-AK §1.4: a row of the reader's own list opens in the workspace with the same
  // "my:" context, so Space walks Favorites exactly as it walks a published list.
  chartUrl: (listId, symbol, index) => Lists.chartLink(`my:${listId}`,
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
    const loaded = await loadResource(config.screenerPath || "/data/screener.json",
      { kind: "screener", asOf: config.as_of });
    const payload = loaded.payload;
    checkBuildId(payload.build_id || payload.meta?.build_id, payload.meta?.as_of, loaded.id);
    if (!loaded.check.ok) {
      host.innerHTML = `<p class="list-empty negative">${esc(Resources.describe(loaded.check))}, `
        + "so nothing here can be valued against it. Reload for matching versions.</p>";
      return;
    }
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
      // SPEC-AI §1: a lot error is reported on the status line even when the portfolio
      // evaluates — an invalid line never disappears because another lot was valid.
      const lotErrors = (result.coverage.unresolved || []).filter((entry) => entry.kind === "lot");
      const lotNote = lotErrors.length
        ? ` ${lotErrors.length} lot error(s): ${lotErrors.map((entry) => `${entry.symbol}`
          + `${entry.line === null ? "" : ` line ${entry.line}`}: ${entry.reason}`).join("; ")}.`
        : "";
      if (status) status.textContent = `${note || ""}${lotNote}`;
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
/* Anything that paints its own colours (the chart) registers here and repaints when the
   reader switches themes; a dark grid on a light ground is a rendering bug, not a style. */
const themeListeners = [];

function onThemeChange(listener) {
  if (typeof listener === "function") themeListeners.push(listener);
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (root.dataset) root.dataset.theme = theme;
  for (const listener of themeListeners) {
    try { listener(theme); } catch { /* a repaint must never break the toggle */ }
  }
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
if (document.body.dataset.page === "chartview") initChartView();

// Progressive web app: keeps the last snapshot readable offline and satisfies the
// installability criteria the Android wrapper (Trusted Web Activity) expects.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator &&
    typeof window !== "undefined" && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(siteUrl("/sw.js"), { scope: siteUrl("/") }).catch(() => {});
  });
}
