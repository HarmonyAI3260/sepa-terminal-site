/* Build Your Screen: the six filter categories and saved named screens (SPEC-AF §5).
 *
 * This module is the grouped-filter layer *on top of* the existing shared screener
 * contract in screener.js: Screener.matches still decides the trend/stage/pattern/
 * financial core, and every filter here composes with it under the same three-valued
 * rule — a filter whose input this snapshot does not carry answers "unknown", never
 * "pass". A filter with no usable input anywhere in the snapshot is blocked with its
 * reason instead of quietly matching everything.
 */
"use strict";
const ScreenFilters = (() => {
  const SCREENFILTERS_CONTRACT_VERSION = "screenfilters-contract-1.0";
  const SAVED_KEY = "sepa_saved_screens";
  const SAVED_VERSION = 1;
  const SAVED_LIMIT = 50;
  const AD_ORDER = ["E", "D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"];
  const MA_TESTS = {
    price_above_150_200: { id: 1, label: "Price above the 150d and 200d MA" },
    ma150_above_200: { id: 2, label: "150d MA above the 200d MA" },
    ma200_rising: { id: 3, label: "200d MA rising for at least a month" },
    ma50_above_150_200: { id: 4, label: "50d MA above the 150d and 200d MA" },
    price_above_50: { id: 5, label: "Price above the 50d MA" },
  };
  const BASE_STATUSES = ["forming", "near_pivot", "breakout", "extended", "failed", "none"];
  const LIFECYCLE_STATES = ["forming", "confirmed", "triggered", "extended", "failed", "invalidated"];
  const SURVEILLANCE_FLAGS = [
    ["asm", "ASM"], ["gsm", "GSM"], ["high_debt", "High debt"],
    ["low_institutional", "No or limited institutional holding"],
    ["high_pledge", "High promoter pledging"], ["low_liquidity", "Low liquidity"],
    ["heavy_institutional_selling", "Heavy institutional selling"], ["sme", "SME"],
    ["lower_band", "Lower price band (< 20 %)"], ["trade_to_trade", "Trade to trade"],
  ];
  const INDEX_KEYS = [["nifty50", "Nifty 50"], ["nifty500", "Nifty 500"],
    ["niftytotalmarket", "Nifty Total Market"], ["niftymicrocap250", "Nifty Microcap 250"]];

  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const num = (value) => (finite(value) ? value : (value === null || value === undefined || value === ""
    ? null : (Number.isFinite(Number(value)) ? Number(value) : null)));
  const ratings = (row) => (row && row.ratings) || {};
  const facts = (row) => (row && row.facts) || {};
  const base = (row) => (row && row.base) || {};
  const fund = (row) => (row && row.fund) || {};
  const qualification = (row) => (row && row.qualification) || {};
  const boolean = (value) => (typeof value === "boolean" ? value : null);

  function ttCheck(row, checkId) {
    const checks = ((row && row.tt) || {}).checks || [];
    const found = checks.find((check) => Number(check.id) === checkId);
    return found ? boolean(found.pass) : null;
  }

  /* ── the six categories ──────────────────────────────────────────────────── */
  const CATEGORIES = [
    { id: "ratings", title: "Ratings", note: null, filters: [
      { id: "composite_min", label: "Composite Score ≥", kind: "min", read: (row) => num(ratings(row).composite) },
      { id: "eps_rating_min", label: "EPS Rating ≥", kind: "min", read: (row) => num(ratings(row).eps) },
      { id: "rs_rating_min", label: "RS Rating ≥", kind: "min", read: (row) => num(ratings(row).rs) },
      { id: "ad_min", label: "A/D Rating at least", kind: "choice", options: AD_ORDER.slice().reverse(),
        read: (row) => (ratings(row).ad ? AD_ORDER.indexOf(String(ratings(row).ad)) : null),
        test: (value, read) => (read === null || read < 0 ? null : read >= AD_ORDER.indexOf(String(value))) },
      { id: "group_rank_max", label: "Group Rank ≤", kind: "max", read: (row) => num(ratings(row).group_rank) },
      { id: "eps_growth_min", label: "EPS growth rate ≥ (%)", kind: "min",
        read: (row) => num(ratings(row).eps_growth_rate) },
      { id: "stability_min", label: "Earnings stability ≥", kind: "min",
        read: (row) => num(ratings(row).earnings_stability) },
    ] },
    { id: "technical", title: "Technical", note: null, filters: [
      { id: "price_min", label: "Price ≥ (₹)", kind: "min", read: (row) => num(row.close) },
      { id: "price_max", label: "Price ≤ (₹)", kind: "max", read: (row) => num(row.close) },
      { id: "off_high_min", label: "% off 52-week high ≥", kind: "min", read: (row) => num(row.pct_off_high) },
      { id: "above_low_min", label: "% above 52-week low ≥", kind: "min", read: (row) => num(row.pct_above_low) },
      { id: "rupee_volume_min", label: "Average ₹ volume ≥ (Cr)", kind: "min",
        read: (row) => num(facts(row).avg_rupee_volume_cr) },
      { id: "ud_min", label: "U/D volume ratio ≥", kind: "min", read: (row) => num(facts(row).ud_vol_ratio) },
      { id: "alpha_min", label: "Alpha ≥ (%)", kind: "min", read: (row) => num(facts(row).alpha) },
      { id: "beta_max", label: "Beta ≤", kind: "max", read: (row) => num(facts(row).beta) },
      { id: "ma", label: "Moving-average relationships", kind: "multi",
        options: Object.entries(MA_TESTS).map(([key, entry]) => ({ value: key, label: entry.label })),
        read: () => null,
        test: (value, _read, row) => {
          const results = (Array.isArray(value) ? value : [value])
            .map((key) => (MA_TESTS[key] ? ttCheck(row, MA_TESTS[key].id) : null));
          if (results.includes(false)) return false;
          return results.includes(null) ? null : true;
        } },
      { id: "at_52w_high", label: "At the 52-week high", kind: "bool",
        read: (row) => boolean(facts(row).at_52w_high) },
      { id: "up_on_volume", label: "Up on ≥ 1.5× average volume", kind: "bool",
        read: (row) => {
          const relative = num(facts(row).rel_volume);
          const up = boolean(facts(row).up_day);
          if (relative === null || up === null) return null;
          return up && relative >= 1.5;
        } },
      { id: "gap_up", label: "Gapped up today", kind: "bool", read: (row) => boolean(facts(row).gap_up) },
      { id: "rs_line_high", label: "RS line at a 252-session high", kind: "bool",
        read: (row) => boolean(row.rs_line_nh) },
    ] },
    { id: "fundamental", title: "Fundamental",
      note: "Year-on-year growth comes from the latest reported quarter. This build "
        + "publishes no rolling four-quarter growth rate, so a TTM *growth* filter is not "
        + "offered; the TTM sales figure itself is.",
      filters: [
        { id: "sales_yoy_min", label: "Sales YoY ≥ (%)", kind: "min", read: (row) => num(fund(row).sales_yoy) },
        { id: "eps_yoy_min", label: "EPS YoY ≥ (%)", kind: "min", read: (row) => num(fund(row).eps_yoy) },
        { id: "pat_yoy_min", label: "PAT YoY ≥ (%)", kind: "min", read: (row) => num(fund(row).pat_yoy) },
        { id: "sales_ttm_min", label: "Sales TTM ≥ (₹ Cr)", kind: "min",
          read: (row) => num(facts(row).sales_ttm_cr) },
        { id: "opm_min", label: "Operating margin ≥ (%)", kind: "min", read: (row) => num(fund(row).opm_pct) },
        { id: "roe_min", label: "Return on equity ≥ (%)", kind: "min", read: (row) => num(facts(row).roe_pct) },
        { id: "de_max", label: "Debt / equity ≤ (%)", kind: "max", read: (row) => num(facts(row).ltdebt_equity_pct) },
        { id: "yield_min", label: "Dividend yield ≥ (%)", kind: "min",
          read: (row) => num(facts(row).dividend_yield_pct) },
        { id: "mcap_min", label: "Market cap ≥ (₹ Cr)", kind: "min", read: (row) => num(facts(row).market_cap_cr) },
        { id: "mcap_max", label: "Market cap ≤ (₹ Cr)", kind: "max", read: (row) => num(facts(row).market_cap_cr) },
        { id: "pe_max", label: "P/E ≤", kind: "max", read: (row) => num(facts(row).pe) },
        { id: "pe_min", label: "P/E ≥", kind: "min", read: (row) => num(facts(row).pe) },
      ] },
    { id: "pattern", title: "Pattern", note: null, filters: [
      { id: "base_status", label: "Base status", kind: "multi",
        options: BASE_STATUSES.map((value) => ({ value, label: value.replace(/_/g, " ") })),
        read: (row) => String(base(row).status || "none"),
        test: (value, read) => (read === null ? null
          : (Array.isArray(value) ? value : [value]).includes(read)) },
      { id: "lifecycle", label: "Lifecycle state", kind: "multi",
        options: LIFECYCLE_STATES.map((value) => ({ value, label: value })),
        read: (row) => base(row).lifecycle_state || qualification(row).lifecycle_state || null,
        test: (value, read) => (read === null ? null
          : (Array.isArray(value) ? value : [value]).includes(String(read))) },
      { id: "proper_vcp", label: "Proper VCP", kind: "bool", read: (row) => boolean(base(row).proper_vcp) },
      { id: "vcp_trend_qualified", label: "VCP, trend qualified", kind: "bool",
        read: (row) => boolean(base(row).vcp_trend_qualified) },
      { id: "power_play", label: "Power play", kind: "bool",
        read: (row) => boolean((row.power_play || {}).flag) },
      { id: "near_pivot", label: "Near the pivot", kind: "bool",
        read: (row) => (qualification(row).entry_state ? qualification(row).entry_state === "near" : null) },
      { id: "breakout", label: "Breakout (triggered)", kind: "bool",
        read: (row) => (qualification(row).entry_state ? qualification(row).entry_state === "triggered" : null) },
      { id: "extended", label: "Extended", kind: "bool",
        read: (row) => (qualification(row).entry_state ? qualification(row).entry_state === "extended" : null) },
      { id: "failed", label: "Failed", kind: "bool",
        read: (row) => (qualification(row).entry_state ? qualification(row).entry_state === "failed" : null) },
      { id: "in_base", label: "In a base", kind: "bool", read: (row) => boolean(base(row).in_base) },
      { id: "ready", label: "Readiness approved", kind: "bool",
        read: (row) => boolean(qualification(row).ready) },
    ] },
    { id: "indices", title: "Market Indices",
      note: "Membership comes from the NSE index constituent CSVs the industry crawl reads.",
      filters: [
        { id: "index_member", label: "Member of", kind: "multi",
          options: INDEX_KEYS.map(([value, label]) => ({ value, label })),
          read: (row) => (Array.isArray(row.indices) ? row.indices : null),
          test: (value, read) => (read === null ? null
            : (Array.isArray(value) ? value : [value]).some((key) => read.includes(key))) },
      ] },
    { id: "surveillance", title: "Surveillance",
      note: "Exchange and balance-sheet flags as published on the stock page.",
      filters: SURVEILLANCE_FLAGS.map(([key, label]) => ({
        id: `surv_${key}`, label, kind: "state", options: ["flagged", "clear"],
        read: (row) => boolean(((row.surveillance || {})[key])),
        test: (value, read) => (read === null ? null : (value === "flagged" ? read === true : read === false)),
      })) },
  ];

  const FILTERS = new Map();
  for (const category of CATEGORIES) {
    for (const filter of category.filters) FILTERS.set(filter.id, { ...filter, category: category.id });
  }

  function defaults() {
    return {};
  }

  /* Only known filter ids with a usable value survive; everything else is dropped so a
     stale or hand-edited saved screen can never mean something the page cannot show. */
  function normalize(state) {
    const clean = {};
    for (const [id, value] of Object.entries(state || {})) {
      const filter = FILTERS.get(id);
      if (!filter) continue;
      if (filter.kind === "bool") {
        if (value === true) clean[id] = true;
      } else if (filter.kind === "multi") {
        const options = new Set((filter.options || []).map((option) => option.value ?? option));
        const chosen = [...new Set((Array.isArray(value) ? value : [value]).map(String))]
          .filter((entry) => options.has(entry)).sort();
        if (chosen.length) clean[id] = chosen;
      } else if (filter.kind === "choice" || filter.kind === "state") {
        const options = (filter.options || []).map((option) => option.value ?? option);
        if (options.includes(String(value))) clean[id] = String(value);
      } else {
        const parsed = num(value);
        if (parsed !== null) clean[id] = parsed;
      }
    }
    return clean;
  }

  function active(state) {
    return Object.entries(normalize(state))
      .map(([id, value]) => ({ filter: FILTERS.get(id), value }))
      .sort((a, b) => a.filter.id.localeCompare(b.filter.id));
  }

  function evaluate(filter, value, row) {
    const read = filter.read ? filter.read(row) : null;
    if (filter.test) return filter.test(value, read, row);
    if (filter.kind === "bool") return read === null ? null : read === true;
    if (read === null) return null;
    return filter.kind === "max" ? read <= value : read >= value;
  }

  /* Kleene AND over the active filters: one definite failure fails the row; otherwise
     any missing input makes the row unknown rather than a pass. */
  function verdict(row, state) {
    const failed = [];
    const unknown = [];
    for (const { filter, value } of active(state)) {
      const result = evaluate(filter, value, row);
      if (result === false) failed.push(filter.id);
      else if (result === null) unknown.push(filter.id);
    }
    return { state: failed.length ? "fail" : unknown.length ? "unknown" : "pass", failed, unknown };
  }

  function matches(row, state) {
    return verdict(row, state).state === "pass";
  }

  /* A filter whose input no row in the snapshot carries is blocked: running it would
     silently return nothing (or everything) for a reason the reader cannot see. */
  function availability(state, data) {
    const rows = (data && data.rows) || [];
    const meta = (data && data.meta) || {};
    const blocked = [];
    for (const { filter } of active(state)) {
      if (filter.category === "indices") {
        const membership = meta.index_membership || {};
        if (membership.available === false || (!membership.available && !rows.some((row) => (row.indices || []).length))) {
          blocked.push({ key: filter.id, label: filter.label,
            reason: membership.reason || "this snapshot carries no index membership" });
          continue;
        }
      }
      const known = rows.filter((row) => evaluate(filter, normalize(state)[filter.id], row) !== null).length;
      if (!known) {
        blocked.push({ key: filter.id, label: filter.label,
          reason: `${filter.label} cannot be evaluated in this snapshot (no row carries this input)` });
      }
    }
    return { blocked, evaluable: blocked.length === 0 };
  }

  function coverage(rows, state) {
    const counts = { candidates: (rows || []).length, passed: 0, failed: 0, unknown: 0 };
    for (const row of rows || []) {
      const result = verdict(row, state).state;
      counts[result === "pass" ? "passed" : result === "fail" ? "failed" : "unknown"] += 1;
    }
    return counts;
  }

  function coverageText(rows, state, data) {
    const filters = active(state);
    if (!filters.length) return "no category filter is active";
    const blocked = availability(state, data || { rows }).blocked;
    if (blocked.length) return `blocked: ${blocked.map((item) => item.reason).join("; ")}`;
    const counts = coverage(rows, state);
    return `category filters ${filters.length} · passed ${counts.passed} · failed ${counts.failed} `
      + `· unknown ${counts.unknown} of ${counts.candidates}`;
  }

  function describe(state) {
    return active(state).map(({ filter, value }) =>
      `${filter.label} ${Array.isArray(value) ? value.join("/") : value === true ? "yes" : value}`).join(" · ");
  }

  /* ── controls (shared by the site and the local app) ─────────────────────── */
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character]));

  /* One HTML builder for both clients: the same categories, ids and labels, so a
     filter can never exist in one client and not the other. */
  function controlHtml(filter, value) {
    const id = `cat-${filter.id}`;
    if (filter.kind === "bool") {
      return `<label class="filter-toggle"><input type="checkbox" id="${escapeHtml(id)}" `
        + `data-filter="${escapeHtml(filter.id)}"${value === true ? " checked" : ""}> `
        + `${escapeHtml(filter.label)}</label>`;
    }
    if (filter.kind === "multi") {
      const options = (filter.options || []).map((option) => {
        const key = option.value ?? option;
        const label = option.label ?? option;
        const on = Array.isArray(value) && value.includes(String(key));
        return `<label class="filter-toggle"><input type="checkbox" `
          + `data-filter="${escapeHtml(filter.id)}" data-option="${escapeHtml(key)}"`
          + `${on ? " checked" : ""}> ${escapeHtml(label)}</label>`;
      }).join("");
      return `<fieldset class="category-multi"><legend>${escapeHtml(filter.label)}</legend>${options}</fieldset>`;
    }
    if (filter.kind === "choice" || filter.kind === "state") {
      const options = ["", ...(filter.options || []).map((option) => option.value ?? option)]
        .map((option) => `<option value="${escapeHtml(option)}"`
          + `${String(value ?? "") === String(option) ? " selected" : ""}>`
          + `${escapeHtml(option || "any")}</option>`).join("");
      return `<label class="scan-filter-input">${escapeHtml(filter.label)} `
        + `<select id="${escapeHtml(id)}" data-filter="${escapeHtml(filter.id)}">${options}</select></label>`;
    }
    return `<label class="scan-filter-input">${escapeHtml(filter.label)} `
      + `<input type="number" step="any" id="${escapeHtml(id)}" data-filter="${escapeHtml(filter.id)}" `
      + `value="${value === undefined ? "" : escapeHtml(value)}" placeholder="off"></label>`;
  }

  function categoriesHtml(state) {
    const clean = normalize(state);
    return CATEGORIES.map((category) => `<section class="filter-category" `
      + `data-category="${escapeHtml(category.id)}"><h3>${escapeHtml(category.title)}</h3>`
      + (category.note ? `<p class="fineprint">${escapeHtml(category.note)}</p>` : "")
      + `<div class="scan-filters">`
      + category.filters.map((filter) => controlHtml(filter, clean[filter.id])).join("")
      + `</div></section>`).join("");
  }

  /* ``controls`` is the list of rendered inputs; only dataset/checked/value are read,
     so the same reader works in a browser and in the offline test harness. */
  function readControls(controls) {
    const state = {};
    for (const control of controls || []) {
      const id = (control.dataset || {}).filter;
      const filter = FILTERS.get(id);
      if (!filter) continue;
      if ((control.dataset || {}).option !== undefined) {
        if (control.checked) (state[id] = state[id] || []).push(control.dataset.option);
      } else if (filter.kind === "bool") {
        if (control.checked) state[id] = true;
      } else if (control.value !== "" && control.value !== undefined && control.value !== null) {
        state[id] = filter.kind === "choice" || filter.kind === "state"
          ? control.value : Number(control.value);
      }
    }
    return normalize(state);
  }

  /* ── saved named screens ─────────────────────────────────────────────────── */
  function loadSaved(storage) {
    let parsed = null;
    try {
      parsed = JSON.parse((storage || {}).getItem(SAVED_KEY) || "null");
    } catch { /* a corrupt entry is simply no saved screens */ }
    const screens = Array.isArray(parsed && parsed.screens) ? parsed.screens : [];
    return {
      version: SAVED_VERSION,
      screens: screens.filter((screen) => screen && screen.name).slice(0, SAVED_LIMIT).map((screen) => ({
        name: String(screen.name).slice(0, 60),
        created_at: screen.created_at ? String(screen.created_at) : null,
        filters: normalize(screen.filters),
        screener: screen.screener && typeof screen.screener === "object" ? screen.screener : null,
      })),
    };
  }

  function saveSaved(storage, saved) {
    try {
      (storage || {}).setItem(SAVED_KEY, JSON.stringify({ version: SAVED_VERSION,
        screens: (saved.screens || []).slice(0, SAVED_LIMIT) }));
      return true;
    } catch {
      return false;
    }
  }

  function saveScreen(storage, name, filters, screener = null) {
    const clean = String(name || "").trim().slice(0, 60);
    if (!clean) return { ok: false, error: "a saved screen needs a name" };
    const saved = loadSaved(storage);
    const entry = { name: clean, created_at: new Date().toISOString(),
      filters: normalize(filters), screener };
    const existing = saved.screens.findIndex((screen) => screen.name === clean);
    if (existing >= 0) saved.screens[existing] = entry;
    else saved.screens.push(entry);
    saved.screens.sort((a, b) => a.name.localeCompare(b.name));
    saveSaved(storage, saved);
    return { ok: true, document: saved, replaced: existing >= 0 };
  }

  function deleteScreen(storage, name) {
    const saved = loadSaved(storage);
    const before = saved.screens.length;
    saved.screens = saved.screens.filter((screen) => screen.name !== name);
    saveSaved(storage, saved);
    return { ok: saved.screens.length < before, document: saved };
  }

  function getScreen(storage, name) {
    return loadSaved(storage).screens.find((screen) => screen.name === name) || null;
  }

  return {
    contractVersion: SCREENFILTERS_CONTRACT_VERSION, SAVED_KEY, SAVED_VERSION, CATEGORIES,
    FILTERS, AD_ORDER, MA_TESTS, SURVEILLANCE_FLAGS, INDEX_KEYS, BASE_STATUSES, LIFECYCLE_STATES,
    defaults, normalize, active, evaluate, verdict, matches, availability, coverage,
    coverageText, describe, controlHtml, categoriesHtml, readControls, escapeHtml,
    loadSaved, saveSaved, saveScreen, deleteScreen, getScreen,
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ScreenFilters;
