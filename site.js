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

const REFRESH_KEY = "sepa_refresh_key";
const REFRESH_OWNER = "sepa_refresh_owner";
let refreshPollTimer = null;

function readRefreshConfig() {
  try {
    const config = JSON.parse($("refresh-config")?.textContent || "{}");
    return config && typeof config === "object" ? config : {};
  } catch {
    return {};
  }
}

function showRefreshProgress(message, tone = "") {
  const progress = $("refresh-progress");
  if (!progress) return;
  progress.hidden = false;
  progress.className = `refresh-progress ${tone}`.trim();
  progress.textContent = message;
}

function refreshClock(value) {
  const stamp = new Date(value || Date.now());
  if (Number.isNaN(stamp.getTime())) return "now";
  return stamp.toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
  });
}

function runningRefreshText(status) {
  const phase = String(status.phase || "starting");
  const detail = String(status.detail || "").trim();
  if (phase === "scan") {
    const scanDetail = detail.replace(/^scan(?:ning)?\s*[:·-]?\s*/i, "");
    return `Refreshing · scan${scanDetail ? ` ${scanDetail}` : ""}`;
  }
  if (phase === "autogen") return "Refreshing · generating briefs";
  if (phase === "build") return "Refreshing · building";
  if (phase === "publish") return "Refreshing · publishing";
  return `Refreshing · ${detail || "starting"}`;
}

async function readTriggerResponse(response) {
  try { return await response.json(); } catch { return {}; }
}

function stopRefreshPolling() {
  if (refreshPollTimer !== null) window.clearTimeout(refreshPollTimer);
  refreshPollTimer = null;
}

function renderTriggerStatus(status, button) {
  if (status.state === "running") {
    button.disabled = true;
    showRefreshProgress(runningRefreshText(status));
    return true;
  }
  button.disabled = false;
  stopRefreshPolling();
  if (status.state === "done") {
    const published = status.last_result?.published === true;
    showRefreshProgress(
      `${published ? "Published" : "Refresh complete"} ${refreshClock(status.finished_at)} — reload for the new snapshot`,
      "positive",
    );
  } else if (status.state === "failed") {
    showRefreshProgress(`Refresh failed · ${status.detail || "check the Mac trigger log"}`, "negative");
  }
  return false;
}

// Trigger requests: bounded wait + a hint for Chrome's local-network permission.
// On the owner's own machine the trigger host resolves to a private Tailscale
// address, so Chrome holds the request until "Allow" is clicked in the address bar.
const LNA_HINT = "Waiting for the browser — if Chrome asks to allow access to your local network, click Allow";
async function triggerFetch(url, options = {}, { timeoutMs = 15000, hint = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const hintTimer = hint ? setTimeout(() => showRefreshProgress(LNA_HINT), 2500) : null;
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (hintTimer) clearTimeout(hintTimer);
  }
}

async function pollTriggerStatus(config, button, showNetworkError = true) {
  try {
    const response = await triggerFetch(`${config.url}/status`, { cache: "no-store", referrerPolicy: "no-referrer" }, { timeoutMs: 12000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await readTriggerResponse(response);
    if (renderTriggerStatus(status, button)) {
      stopRefreshPolling();
      refreshPollTimer = window.setTimeout(
        () => pollTriggerStatus(config, button, true), 5000,
      );
    }
  } catch {
    button.disabled = false;
    stopRefreshPolling();
    if (showNetworkError) {
      showRefreshProgress(
        "no answer from the refresh service — if Chrome showed a local-network permission prompt, click Allow and press again; otherwise the Mac may be asleep or Funnel off",
        "negative",
      );
    }
  }
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

const FILTER_DEFAULTS = {
  tier: "8/8", rs: 70, stages: ["2"], turnover: null,
  inBase: false, nearPivot: false, breakout: false, recentBreakout: false,
  powerPlay: false, shelf: false, tightening: false, isNew: false, rsLineNh: false,
  salesYoy: null, patYoy: null, accelerating: false, code33Lite: false,
  forming: false, setupAny: false, fundamentalAny: false, minBoVol: null,
  activePreset: null, query: "", sortKey: "tt", sortDir: "desc",
};
const FILTER_KEY = "sepa_screener_filters";
const SEPA_LABELS = {
  trend: "Trend", fundamentals: "Fundamentals", catalyst: "Catalyst", entry: "Entry", exit: "Exit",
};
let scanData = null;
let visibleRows = [];
let turnoverWasSaved = false;
let filters = loadFilters();

function loadFilters() {
  let saved = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(FILTER_KEY) || "null");
    if (parsed && typeof parsed === "object") saved = parsed;
  } catch {}
  turnoverWasSaved = Object.prototype.hasOwnProperty.call(saved, "turnover");
  const loaded = { ...FILTER_DEFAULTS, ...saved };
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
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch {}
}

function baseStatus(base) {
  const explicit = String(base?.status || "");
  if (["forming", "near_pivot", "breakout", "extended", "failed"].includes(explicit)) return explicit;
  if (!base?.in_base) return "none";
  const below = base.pct_below_pivot;
  return below !== null && below !== undefined && below >= 0 && below <= 5 ? "near_pivot" : "forming";
}

function commonPlaybookGate(row) {
  return row.turnover_pass === true && row.rs !== null && row.rs !== undefined
    && row.stale !== true && Number(row.history_sessions || 0) >= 250;
}

function presetMatches(row, name) {
  const base = row.base || {};
  const tt = Number(row.tt?.passed || 0);
  const age = Number(base.crossed_sessions_ago ?? 99);
  if (name === "ready") return commonPlaybookGate(row) && tt === 8 && row.rs >= 80
    && ["near_pivot", "breakout"].includes(base.status)
    && base.proper_vcp === true
    && (base.status !== "breakout" || base.breakout_confirmed === true && age <= 5);
  if (name === "fresh") return commonPlaybookGate(row) && tt >= 7 && row.rs >= 70
    && base.proper_vcp === true && base.breakout_confirmed === true && age <= 5;
  if (name === "power") return commonPlaybookGate(row) && row.power_play?.flag === true;
  if (name === "earnings") return commonPlaybookGate(row);
  return true;
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
  document.querySelectorAll(".playbook-presets button[data-preset]").forEach((button) =>
    button.classList.toggle("active", button.dataset.preset === filters.activePreset));
  document.querySelectorAll("#scan-tier button[data-tier]").forEach((button) =>
    button.classList.toggle("active", button.dataset.tier === filters.tier));
  document.querySelectorAll("#scan-stages button[data-stage]").forEach((button) =>
    button.classList.toggle("active", filters.stages.includes(button.dataset.stage)));
  $("scan-rs").value = filters.rs ?? 70;
  $("scan-turnover").value = filters.turnover ?? "";
  $("scan-in-base").checked = Boolean(filters.inBase);
  $("scan-near-pivot").checked = Boolean(filters.nearPivot);
  $("scan-breakout").checked = Boolean(filters.breakout);
  $("scan-recent-breakout").checked = Boolean(filters.recentBreakout);
  $("scan-power-play").checked = Boolean(filters.powerPlay);
  $("scan-shelf").checked = Boolean(filters.shelf);
  $("scan-tightening").checked = Boolean(filters.tightening);
  $("scan-sales-yoy").value = filters.salesYoy ?? "";
  $("scan-pat-yoy").value = filters.patYoy ?? "";
  $("scan-accelerating").checked = Boolean(filters.accelerating);
  $("scan-code33-lite").checked = Boolean(filters.code33Lite);
  $("scan-new").checked = Boolean(filters.isNew);
  $("scan-rs-line-nh").checked = Boolean(filters.rsLineNh);
  $("scan-search").value = filters.query || "";
}

function applyPreset(name) {
  const reset = {
    ...FILTER_DEFAULTS,
    stages: [...FILTER_DEFAULTS.stages],
    turnover: name === "reset" ? scanData?.meta?.params?.turnover_gate_cr ?? null : null,
    activePreset: name === "reset" ? null : name,
  };
  if (name !== "reset") {
    reset.tier = "All";
    reset.rs = 0;
    reset.stages = [];
  }
  if (name === "ready") Object.assign(reset, {
    tier: "≥7", rs: 80, nearPivot: true, breakout: true,
    setupAny: true,
  });
  if (name === "fresh") Object.assign(reset, { tier: "≥7", rs: 70, recentBreakout: true, minBoVol: 1.5 });
  if (name === "power") reset.powerPlay = true;
  if (name === "forming") reset.forming = true;
  if (name === "in-base") reset.inBase = true;
  if (name === "near-pivot") reset.nearPivot = true;
  if (name === "breakout") reset.breakout = true;
  if (name === "tightening") reset.tightening = true;
  if (name === "earnings") Object.assign(reset, {
    tier: "≥7", rs: 70, salesYoy: 20, patYoy: 20,
    code33Lite: true, fundamentalAny: true,
  });
  filters = reset;
  saveFilters();
  renderFilterControls();
  renderRows();
}

function sortValue(row, key) {
  if (key === "tt") return row.tt?.passed;
  if (key === "stage") return stageNumber(row);
  if (key === "base") return row.base?.in_base ? row.base.depth_pct : null;
  if (key === "pivot") return row.base?.in_base ? row.base.pct_below_pivot : null;
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
  const tier = filters.tier;
  const rsThreshold = Number(filters.rs) || 0;
  const turnoverThreshold = Number(filters.turnover) || 0;
  const query = String(filters.query || "").trim().toLowerCase();
  const rows = (scanData?.rows || []).filter((row) => {
    const passed = row.tt?.passed;
    const tierOk = tier === "All" || tier === "8/8" && passed === 8
      || tier === "≥7" && passed >= 7 || tier === "≥6" && passed >= 6;
    const rsOk = row.rs === null ? tier === "All" : row.rs >= rsThreshold;
    const stageOk = !filters.stages.length || filters.stages.some((stage) =>
      String(row.stage || "").startsWith(`Stage ${stage}`));
    const turnoverOk = turnoverThreshold <= 0
      || row.turnover_cr !== null && row.turnover_cr >= turnoverThreshold;
    const queryOk = !query || String(row.symbol || "").toLowerCase().includes(query)
      || String(row.name || "").toLowerCase().includes(query);
    const statusChecks = [];
    if (filters.nearPivot) statusChecks.push(row.base?.status === "near_pivot");
    if (filters.breakout) statusChecks.push(row.base?.status === "breakout");
    if (filters.forming) statusChecks.push(row.base?.status === "forming");
    const statusOk = !statusChecks.length || statusChecks.some(Boolean);
    const setupChecks = [];
    if (filters.tightening) setupChecks.push(row.base?.proper_vcp === true);
    if (filters.shelf) setupChecks.push(row.base?.kind === "shelf");
    const setupOk = !setupChecks.length || (filters.setupAny ? setupChecks.some(Boolean) : setupChecks.every(Boolean));
    const fund = row.fund;
    const salesOn = filters.salesYoy !== null && filters.salesYoy !== "";
    const patOn = filters.patYoy !== null && filters.patYoy !== "";
    const growthOn = salesOn || patOn;
    const growthOk = (!salesOn || fund !== null && fund?.sales_yoy >= Number(filters.salesYoy))
      && (!patOn || fund !== null && fund?.pat_yoy >= Number(filters.patYoy));
    const fundChecks = [];
    if (growthOn) fundChecks.push(growthOk);
    if (filters.accelerating) fundChecks.push(fund?.sales_acc3 === true || fund?.pat_acc3 === true);
    if (filters.code33Lite) fundChecks.push(fund?.code33_lite === true);
    const fundOk = !fundChecks.length || (filters.fundamentalAny ? fundChecks.some(Boolean) : fundChecks.every(Boolean));
    return tierOk && rsOk && stageOk && turnoverOk && queryOk
      && presetMatches(row, filters.activePreset)
      && (!filters.inBase || row.base?.in_base === true)
      && statusOk && setupOk && fundOk
      && (!filters.recentBreakout || row.recent_breakout === true)
      && (!filters.powerPlay || row.power_play?.flag === true)
      && (filters.minBoVol === null || row.base?.breakout_vol_ratio >= filters.minBoVol)
      && (!filters.isNew || row.new_since_prev === true)
      && (!filters.rsLineNh || row.rs_line_nh === true);
  });
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
  if (base.vcp_valid === true) text += "·VCP";
  if (base.pivot_grade === "cheat") text += "·cheat";
  if (base.pivot_grade === "low") text += "·low-pivot";
  if (base.volume_dryup_ratio_10v50 !== null && base.volume_dryup_ratio_10v50 !== undefined
      && base.volume_dryup_ratio_10v50 < 0.8) text += `·dry ${fmt(base.volume_dryup_ratio_10v50, 2)}`;
  return text;
}

function fundHtml(fund) {
  if (!fund) return '<span class="muted">–</span>';
  const value = (number) => number === null || number === undefined ? "–" : `${number > 0 ? "+" : ""}${fmt(number, 0)}%`;
  const star = fund.code33_lite === true ? '<span class="fund-star" title="Code 33-lite">★</span>' : "";
  return `<span title="${esc(`Latest quarter ${fund.latest_period || "–"}`)}">S${value(fund.sales_yoy)}·P${value(fund.pat_yoy)}${star}</span>`;
}

function sepaHtml(sepa) {
  if (!sepa) return '<span class="muted">–</span>';
  const dots = Object.keys(SEPA_LABELS).map((key) => {
    const item = sepa[key] || {};
    const state = item.ok === true ? "pass" : item.ok === false ? "fail" : "unknown";
    return `<span class="scan-dot ${state}" title="${esc(`${SEPA_LABELS[key]}: ${item.text || "–"}`)}"></span>`;
  }).join("");
  return `<b>${fmt(sepa.score, 0)}/5</b><span class="sepa-dots">${dots}</span>`;
}

function rsHtml(row) {
  const rank = row.rs === null || row.rs === undefined ? "–" : fmt(row.rs, 0);
  let delta = "";
  if (row.rs_chg_1w !== null && row.rs_chg_1w !== undefined) {
    const value = Number(row.rs_chg_1w);
    const mark = value > 0 ? `▲${Math.abs(value)}` : value < 0 ? `▼${Math.abs(value)}` : "·0";
    delta = `<span class="rs-delta ${cls(value)}" title="${esc(`RS rank Δ: 1w ${rankDelta(row.rs_chg_1w)} · 1m ${rankDelta(row.rs_chg_1m)}`)}">${mark}</span>`;
  }
  const star = row.rs_line_nh_before_price === true
    ? '<span class="rs-early-leadership" title="RS line at a 52-week high before price">★</span>' : "";
  return `<b>${rank}</b>${delta}${star}`;
}

function pivotDisplay(base) {
  const status = String(base?.status || "none");
  const value = base?.pct_below_pivot;
  if (["breakout", "extended"].includes(status) && value !== null && value !== undefined) {
    return { className: status === "extended" ? "negative" : "breakout-pivot", text: `+${Number(-value).toFixed(1)}%` };
  }
  if (["near_pivot", "forming"].includes(status) && value !== null && value !== undefined) {
    return { className: status === "near_pivot" ? "near-pivot" : "", text: `${fmt(value)}%` };
  }
  return { className: "", text: "–" };
}

function renderRows() {
  visibleRows = filteredRows();
  const meta = scanData.meta || {};
  const eight = (scanData.rows || []).filter((row) => row.tt?.passed === 8).length;
  const ready = (scanData.rows || []).filter((row) => row.sepa?.ready === true).length;
  $("scan-count").textContent = `Universe ${fmt(meta.universe_total, 0)} · scanned ${fmt(meta.scanned, 0)} · 8/8: ${fmt(eight, 0)} · ready: ${fmt(ready, 0)} · shown: ${fmt(visibleRows.length, 0)}`;
  $("scan-results-body").innerHTML = visibleRows.map((row) => {
    const base = row.base || {};
    const dots = (row.tt?.checks || []).map((check) => {
      const state = check.pass === true ? "pass" : check.pass === false ? "fail" : "unknown";
      return `<span class="scan-dot ${state}" title="${esc(`${check.label || ""}: ${check.detail || ""}`)}"></span>`;
    }).join("");
    const newBadge = row.new_since_prev ? '<span class="new-badge">NEW</span>' : "";
    const staleBadge = row.stale === true ? `<span class="stale-badge" title="${esc(`stale — last data ${row.last_date || "unknown"}`)}">●</span>` : "";
    const pivot = pivotDisplay(base);
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
  document.querySelectorAll("#scan-results th[data-sort]").forEach((header) => {
    const active = header.dataset.sort === filters.sortKey;
    header.classList.toggle("sort-active", active);
    header.setAttribute("aria-sort", active ? filters.sortDir === "asc" ? "ascending" : "descending" : "none");
    header.textContent = header.dataset.label + (active ? filters.sortDir === "asc" ? " ↑" : " ↓" : "");
  });
  $("scan-export-tv").disabled = !visibleRows.length;
  $("scan-export-csv").disabled = !visibleRows.length;
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

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportCsv() {
  const headers = ["symbol", "name", "close", "chg_pct", "rs", "rs_chg_1w", "rs_chg_1m", "tt", "stage", "pct_off_high", "pct_above_low", "turnover_cr", "sales_yoy", "pat_yoy", "code33_lite", "sepa_score", "base", "pivot_delta"];
  const lines = [headers.join(",")];
  visibleRows.forEach((row) => lines.push([
    row.symbol, row.name, row.close, row.chg_pct, row.rs, row.rs_chg_1w, row.rs_chg_1m,
    row.tt?.passed, row.stage, row.pct_off_high, row.pct_above_low, row.turnover_cr,
    row.fund?.sales_yoy, row.fund?.pat_yoy, row.fund?.code33_lite, row.sepa?.score,
    baseText(row), pivotDisplay(row.base).text,
  ].map(csvCell).join(",")));
  downloadText("sepa-screener.csv", `${lines.join("\n")}\n`, "text/csv;charset=utf-8");
}

function bindScreener() {
  document.querySelectorAll(".playbook-presets button[data-preset]").forEach((button) =>
    button.addEventListener("click", () => applyPreset(button.dataset.preset)));
  document.querySelectorAll("#scan-tier button[data-tier]").forEach((button) =>
    button.addEventListener("click", () => { filters.tier = button.dataset.tier; filters.activePreset = null; saveFilters(); renderFilterControls(); renderRows(); }));
  document.querySelectorAll("#scan-stages button[data-stage]").forEach((button) =>
    button.addEventListener("click", () => {
      const stage = button.dataset.stage;
      filters.stages = filters.stages.includes(stage) ? filters.stages.filter((value) => value !== stage) : [...filters.stages, stage];
      filters.activePreset = null;
      saveFilters(); renderFilterControls(); renderRows();
    }));
  [["scan-rs", "rs"], ["scan-turnover", "turnover"], ["scan-sales-yoy", "salesYoy"], ["scan-pat-yoy", "patYoy"]].forEach(([id, key]) =>
    $(id).addEventListener("input", (event) => {
      filters[key] = event.target.value === "" ? null : Number(event.target.value);
      filters.activePreset = null; saveFilters(); renderRows();
    }));
  [["scan-in-base", "inBase"], ["scan-near-pivot", "nearPivot"], ["scan-breakout", "breakout"],
    ["scan-recent-breakout", "recentBreakout"], ["scan-power-play", "powerPlay"], ["scan-shelf", "shelf"],
    ["scan-tightening", "tightening"], ["scan-accelerating", "accelerating"], ["scan-code33-lite", "code33Lite"],
    ["scan-new", "isNew"], ["scan-rs-line-nh", "rsLineNh"]].forEach(([id, key]) =>
    $(id).addEventListener("change", (event) => { filters[key] = event.target.checked; filters.activePreset = null; saveFilters(); renderFilterControls(); renderRows(); }));
  $("scan-search").addEventListener("input", (event) => { filters.query = event.target.value; filters.activePreset = null; saveFilters(); renderRows(); });
  document.querySelectorAll("#scan-results th[data-sort]").forEach((header) =>
    header.addEventListener("click", () => {
      const key = header.dataset.sort;
      filters.sortDir = filters.sortKey === key ? filters.sortDir === "asc" ? "desc" : "asc" : key === "symbol" ? "asc" : "desc";
      filters.sortKey = key; saveFilters(); renderRows();
    }));
  $("scan-export-tv").addEventListener("click", () => downloadText(
    "sepa-tradingview-watchlist.txt", visibleRows.map((row) => `NSE:${row.symbol}`).join(","), "text/plain;charset=utf-8"));
  $("scan-export-csv").addEventListener("click", exportCsv);
}

async function initScreener() {
  bindScreener();
  try {
    const response = await fetch(siteUrl("/data/screener.json"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    scanData = await response.json();
  } catch (error) {
    $("scan-count").textContent = "Screener data unavailable";
    $("scan-results-body").innerHTML = `<tr><td colspan="14" class="scan-no-results negative"><b>Could not load screener data.</b><span>${esc(error.message)}</span></td></tr>`;
    return;
  }
  if (!turnoverWasSaved) {
    filters.turnover = scanData.meta?.params?.turnover_gate_cr ?? null;
    turnoverWasSaved = true;
    saveFilters();
  }
  renderFilterControls();
  renderRows();
  document.querySelectorAll("[data-preset-jump]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.presetJump;
    applyPreset(key);
    $("screener").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
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
    bars = await response.json();
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
  container.innerHTML = '<div class="chart-host"></div><div class="buy-zone-band" aria-hidden="true"><span>+5% buy zone</span></div>';
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
  const pivot = config.pivot === null || config.pivot === undefined ? null : Number(config.pivot);
  if (Number.isFinite(pivot)) candles.createPriceLine({ price: pivot, color: "#2ee6a8", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "pivot" });
  const stop = config.stop === null || config.stop === undefined ? null : Number(config.stop);
  if (Number.isFinite(stop)) candles.createPriceLine({ price: stop, color: "#ef5350", lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: "stop" });
  const positionBand = () => {
    if (!Number.isFinite(pivot)) { band.hidden = true; return; }
    const upper = candles.priceToCoordinate(pivot * 1.05);
    const lower = candles.priceToCoordinate(pivot);
    if (upper === null || lower === null) { band.hidden = true; return; }
    band.hidden = false;
    band.style.top = `${Math.min(upper, lower)}px`;
    band.style.height = `${Math.max(2, Math.abs(lower - upper))}px`;
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
