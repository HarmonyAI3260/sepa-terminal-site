/* Shared, DOM-free screener contract for the local app and published snapshot. */
"use strict";
const Screener = (() => {
  const readyExplanation = "Ready = trend + active pattern + entry (near/triggered) + risk ≤ 8% + financial gate. Catalyst is informational; unknown when the memo is historical or missing.";
  const defaults = {
    tier: "8/8", rs: 70, stages: ["2"], turnover: null, includeUnknownRs: false,
    inBase: false, nearPivot: false, breakout: false, forming: false,
    recentBreakout: false, powerPlay: false, tightening: false, properVcp: false,
    ready: false, currentOnly: false, minHistory: null, isNew: false, rsLineNh: false,
    salesYoy: null, patYoy: null, accelerating: false, growthMode: "thresholds",
    query: "", sortKey: "tt", sortDir: "desc",
  };
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const numericKeys = ["rs", "turnover", "minHistory", "salesYoy", "patYoy"];
  function normalize(saved = {}) {
    const state = { ...defaults, stages: [...defaults.stages] };
    for (const key of Object.keys(defaults)) {
      if (!Object.prototype.hasOwnProperty.call(saved, key)) continue;
      if (typeof defaults[key] === "boolean") state[key] = saved[key] === true;
      else if (numericKeys.includes(key)) state[key] = finite(saved[key]) ? saved[key] : null;
      else if (key === "stages" && Array.isArray(saved[key])) {
        state.stages = [...new Set(saved[key].map(String).filter(s => ["1", "2", "3", "4"].includes(s)))].sort();
      } else if (typeof saved[key] === "string") state[key] = saved[key];
    }
    if (!["8/8", "≥7", "≥6", "All"].includes(state.tier)) state.tier = defaults.tier;
    if (!["thresholds", "code33", "either"].includes(state.growthMode)) state.growthMode = "thresholds";
    if (!["symbol", "close", "chg_pct", "rs", "tt", "stage", "pct_off_high", "pct_above_low",
      "turnover_cr", "fund", "sepa", "base", "pivot"].includes(state.sortKey)) state.sortKey = "tt";
    if (!["asc", "desc"].includes(state.sortDir)) state.sortDir = "desc";
    if (state.rs === null) state.rs = 0;
    state.query = state.query.trim();
    return state;
  }
  function preset(name, meta = {}) {
    const state = normalize({ ...defaults, tier: "All", rs: 0, stages: [] });
    const common = { turnover: meta.params?.turnover_gate_cr ?? 20, currentOnly: true, minHistory: 250 };
    if (name === "reset") return normalize({ ...defaults, turnover: meta.params?.turnover_gate_cr ?? null });
    if (name === "ready") state.ready = true;
    if (name === "fresh") Object.assign(state, common, { tier: "≥7", rs: 70, recentBreakout: true });
    if (name === "power") Object.assign(state, common, { powerPlay: true });
    if (name === "earnings") Object.assign(state, { tier: "≥7", rs: 70, salesYoy: 20, patYoy: 20 });
    const toggles = { forming: "forming", "in-base": "inBase", "near-pivot": "nearPivot",
      breakout: "breakout", tightening: "tightening" };
    if (toggles[name]) state[toggles[name]] = true;
    if (name === "tightening") state.currentOnly = true;
    return state;
  }
  function activePreset(state, name, meta = {}) {
    const actual = normalize(state), expected = preset(name, meta);
    return Object.keys(defaults).filter(key => !["sortKey", "sortDir"].includes(key))
      .every(key => JSON.stringify(actual[key]) === JSON.stringify(expected[key]));
  }
  function forSnapshot(state, data) {
    return normalize(state);
  }
  function availability(state, data) {
    const known = coverage(data), blocked = [];
    if (state.rsLineNh && !known.rsUsable) blocked.push({ key: "rsLineNh", label: "RS-line NH",
      reason: `RS-line new-high cannot be evaluated in this snapshot (${known.rsKnown.toLocaleString("en-US")} known, ${known.rsUsable.toLocaleString("en-US")} usable at the snapshot date, of ${known.total.toLocaleString("en-US")})` });
    if (state.isNew && !known.previous) blocked.push({ key: "isNew", label: "New since previous scan",
      reason: "New since previous scan cannot be evaluated in this snapshot (no previous distinct price session)" });
    return { blocked, evaluable: blocked.length === 0 };
  }
  function financialOn(state) {
    return finite(state.salesYoy) || finite(state.patYoy) || state.growthMode !== "thresholds"
      || state.accelerating || state.ready;
  }
  function usableFund(row) {
    const fund = row.fund;
    return !!fund && fund.stale !== true
      && ["current", "lagging"].includes(fund.status || fund.financial_status || row.fund_status);
  }
  // null is unknown. Logical decisions and input completeness are independent.
  const and = (values) => values.includes(false) ? false : values.includes(null) ? null : true;
  const or = (values) => values.includes(true) ? true : values.includes(null) ? null : false;
  const boolean = (value) => typeof value === "boolean" ? value : null;
  function financialVerdict(row, state) {
    if (!usableFund(row)) return { verdict: "unknown", complete: false };
    const fund = row.fund, requested = [], tests = [];
    if (state.growthMode !== "code33") {
      if (finite(state.salesYoy)) tests.push(finite(fund.sales_yoy) ? fund.sales_yoy >= state.salesYoy : null);
      if (finite(state.patYoy)) tests.push(finite(fund.pat_yoy) ? fund.pat_yoy >= state.patYoy : null);
      requested.push(...tests);
    }
    const code = boolean(fund.code33_lite);
    if (state.growthMode !== "thresholds") requested.push(code);
    // A growth branch only takes part when it was requested: with no numeric
    // cutoff set, "either" reduces to the Code 33-lite test instead of a vacuous pass.
    const branches = [];
    if (tests.length) branches.push(and(tests));
    if (state.growthMode !== "thresholds") branches.push(code);
    let result = state.growthMode === "either" ? or(branches) : and(branches);
    if (state.accelerating) {
      const sales = boolean(fund.sales_acc3), pat = boolean(fund.pat_acc3);
      requested.push(sales, pat);
      result = and([result, sales === null || pat === null ? null : sales && pat]);
    }
    if (state.ready) {
      const ready = boolean(row.qualification?.fund_ok);
      requested.push(ready);
      result = and([result, ready]);
    }
    return { verdict: result === true ? "pass" : result === false ? "fail" : "unknown",
      complete: requested.every(value => value !== null) };
  }
  function financialEvaluated(row, state) { return financialVerdict(row, state).complete; }
  function financialCoverage(data, state) {
    const rows = data?.rows || [], blocked = availability(state, data).blocked;
    const candidates = blocked.length ? [] : rows.filter(row => matches(row, state, data?.meta || {}, true));
    const result = { candidates: candidates.length, passed: 0, failed: 0, unknown: 0,
      noRecord: 0, indeterminate: 0, complete: 0, global: rows.filter(usableFund).length,
      total: rows.length, blocked };
    for (const row of candidates) {
      const decision = financialVerdict(row, state);
      if (decision.complete) result.complete++;
      // With no financial condition, every technical candidate passes the screen.
      const verdict = financialOn(state) ? decision.verdict : "pass";
      result[verdict === "pass" ? "passed" : verdict === "fail" ? "failed" : "unknown"]++;
      if (verdict === "unknown") result[usableFund(row) ? "indeterminate" : "noRecord"]++;
    }
    return result;
  }
  function coverageText(data, state) {
    const c = financialCoverage(data, state);
    if (c.blocked.length) return `blocked: ${c.blocked.map(item => item.reason).join("; ")}`;
    return `candidates ${c.candidates} · passed ${c.passed} · failed ${c.failed} · unknown ${c.unknown} (no financial record ${c.noRecord}, indeterminate ${c.indeterminate}) · inputs complete for ${c.complete} · global coverage ${c.global.toLocaleString("en-US")} of ${c.total.toLocaleString("en-US")}`;
  }

  function coverage(data) {
    const rows = data?.rows || [], asOf = data?.meta?.as_of;
    const known = rows.filter(row => typeof row.rs_line_nh === "boolean");
    const usable = known.filter(row => row.stale !== true && (!asOf || row.last_date === asOf));
    return { rsKnown: known.length, rsUsable: usable.length, total: rows.length,
      previous: !!data?.meta?.prev_as_of && data.meta.prev_as_of !== asOf };
  }
  function matches(row, state, meta = {}, nonFinancialOnly = false) {
    const passed = row.tt?.passed;
    const tierOk = state.tier === "All" || state.tier === "8/8" && passed === 8
      || state.tier === "≥7" && passed >= 7 || state.tier === "≥6" && passed >= 6;
    const rsOk = finite(row.rs) ? row.rs >= (state.rs || 0) : state.includeUnknownRs;
    const query = state.query.trim().toLowerCase();
    const statuses = [[state.nearPivot, "near_pivot"], [state.breakout, "breakout"], [state.forming, "forming"]]
      .filter(([on]) => on).map(([, status]) => status);
    return tierOk && rsOk && (!state.stages.length || state.stages.some(s => String(row.stage || "").startsWith(`Stage ${s}`)))
      && (!(state.turnover > 0) || finite(row.turnover_cr) && row.turnover_cr >= state.turnover)
      && (!(state.minHistory > 0) || finite(row.history_sessions) && row.history_sessions >= state.minHistory)
      && (!state.currentOnly || row.stale !== true)
      && (!query || String(row.symbol || "").toLowerCase().includes(query) || String(row.name || "").toLowerCase().includes(query))
      && (!state.inBase || row.base?.in_base === true)
      && (!statuses.length || statuses.includes(row.base?.status))
      && (!(state.tightening || state.properVcp) || row.base?.vcp_trend_qualified === true)
      && (!state.recentBreakout || row.qualification?.entry_state === "triggered")
      && (!state.ready || (nonFinancialOnly
        ? row.qualification?.trend_ok === true && !!row.qualification?.pattern?.id
          && ["near", "triggered"].includes(row.qualification?.entry_state) && row.qualification?.risk_ok === true
        : row.qualification?.ready === true))
      && (!state.powerPlay || row.power_play?.flag === true)
      && (nonFinancialOnly || !financialOn(state) || financialVerdict(row, state).verdict === "pass")
      && (!state.isNew || !!meta.prev_as_of && meta.prev_as_of !== meta.as_of && row.new_since_prev === true)
      && (!state.rsLineNh || row.rs_line_nh === true && row.stale !== true && (!meta.as_of || row.last_date === meta.as_of));
  }
  function distance(close, pivot) {
    return finite(close) && close > 0 && finite(pivot) && pivot > 0 ? 100 * (pivot - close) / pivot : null;
  }
  function distanceText(value) {
    return finite(value) ? `${Math.abs(value).toFixed(1)}% ${value >= 0 ? "below" : "above"} pivot` : "distance unavailable";
  }
  function displayedPivot(row) {
    return row.qualification?.pattern?.pivot ?? (row.power_play?.flag === true ? row.power_play.pivot : row.base?.pivot_hint);
  }
  function monthDelta(row, meta = {}) {
    const available = meta.rs_1m_available_from;
    if (available && (meta.rs_1m_ready === false || (meta.as_of || row.last_date || "") < available)) return `n/a until ${available}`;
    return finite(row.rs_chg_1m) ? `${row.rs_chg_1m > 0 ? "+" : ""}${row.rs_chg_1m}` : "n/a";
  }
  function eventText(event) {
    if (!event) return "breakout date unavailable";
    return `breakout ${event.date || "date unavailable"} · vol ${finite(event.vol_ratio) ? event.vol_ratio.toFixed(2) : "n/a"}× · closed ${finite(event.close_range_pos) ? (event.close_range_pos * 100).toFixed(0) : "n/a"}% of range`;
  }
  function legMarkers(legs, dates) {
    const visible = new Set(dates);
    return (legs || []).flatMap((leg, i) => [
      { time: leg.high_date, position: "aboveBar", color: "#f5a623", shape: "arrowDown", text: `L${i + 1} H ${leg.high}` },
      { time: leg.low_date, position: "belowBar", color: "#4da3ff", shape: "arrowUp", text: `L${i + 1} L ${leg.low}` },
    ]).filter(marker => visible.has(marker.time)).sort((a, b) => a.time.localeCompare(b.time));
  }
  function description(state) { return JSON.stringify(normalize(state)); }
  function csvCell(value) {
    let text = String(value ?? "");
    if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = "'" + text;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }
  function csv(rows, state, meta = {}, blocked = []) {
    const headers = ["symbol", "name", "close", "chg_pct", "rs", "rs_chg_1w", "rs_chg_1m", "tt", "stage",
      "turnover_cr", "sales_yoy", "pat_yoy", "code33_lite", "sepa_score", "ready", "price_date", "fund_period",
      "fund_basis", "fund_status", "pattern_id", "pattern_pivot", "stop", "risk_pct", "reference_pivot", "pct_below_pivot", "pct_to_pivot", "stale"];
    const note = blocked.length ? `; blocked: ${blocked.map(item => item.reason).join("; ")}` : "";
    const lines = [`# filters=${description(state)}; snapshot=${JSON.stringify({ as_of: meta.as_of, generated_at: meta.generated_at })}${note}`, headers.join(",")];
    for (const row of blocked.length ? [] : rows) {
      const q = row.qualification || {}, p = q.pattern || {}, f = row.fund || {};
      lines.push([row.symbol, row.name, row.close, row.chg_pct, row.rs, row.rs_chg_1w, row.rs_chg_1m,
        row.tt?.passed, row.stage, row.turnover_cr, f.sales_yoy, f.pat_yoy, f.code33_lite, row.sepa?.score,
        q.ready, row.last_date, f.period_end || f.latest_period, f.basis || row.fund_basis || "unknown",
        f.stale ? "stale" : f.status || f.financial_status || row.fund_status || (row.fund ? "available" : "unknown"),
        p.id, p.pivot, p.stop, p.risk_pct, displayedPivot(row), distance(row.close, displayedPivot(row)),
        finite(displayedPivot(row)) && row.close > 0 ? 100 * (displayedPivot(row) - row.close) / row.close : null, row.stale].map(csvCell).join(","));
    }
    return lines.join("\n") + "\n";
  }
  return { readyExplanation, defaults, normalize, preset, activePreset, forSnapshot, availability, financialOn, financialVerdict, financialEvaluated, usableFund, coverage,
    financialCoverage, coverageText, matches, distance, distanceText, displayedPivot, monthDelta, eventText, legMarkers, description, csvCell, csv };
})();
