/* Shared, DOM-free Model Portfolio and Portfolio Evaluation model (SPEC-AF §3, §4).
 *
 * Everything here is deterministic and reads only this snapshot's published rows plus
 * the visitor's own positions. There is no research-team pick list: Current Holdings
 * are the positions entered in My Portfolio, the watchlists are rules over the
 * snapshot, and the evaluation grade is a stated weighted mix — never a judgement
 * this build cannot show its inputs for.
 */
"use strict";
const Portfolio = (() => {
  const PORTFOLIO_CONTRACT_VERSION = "portfolio-contract-1.0";
  const GRADE_BANDS = [["A", 85], ["B", 70], ["C", 55], ["D", 40], ["E", 0]];
  // Weights of the per-stock score; renormalised over the components a row has.
  const STOCK_WEIGHTS = { composite: 0.55, stage: 0.20, readiness: 0.15, sell: 0.10 };
  const PORTFOLIO_WEIGHTS = { holdings: 0.70, concentration: 0.20, breaches: 0.10 };
  const STAGE_POINTS = { 1: 55, 2: 100, 3: 30, 4: 0 };
  const ENTRY_POINTS = { triggered: 70, near: 80, forming: 55, extended: 45, failed: 20, none: 50 };
  const CONCENTRATION_LIMIT = 25;      // % of portfolio value in one position
  const GROUP_LIMIT = 40;              // % of portfolio value in one industry group
  const STOP_LOSS_PCT = -8;            // the project's own 8 % maximum loss rule
  const NO_EPS_CALENDAR = "n/a (no results-calendar feed)";
  const AI_EVALUATION_LIMIT = 8;

  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const number = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(String(value).replace(/[₹,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const ratingsOf = (row) => (row && row.ratings) || {};
  const factsOf = (row) => (row && row.facts) || {};
  const baseOf = (row) => (row && row.base) || {};
  const qualificationOf = (row) => (row && row.qualification) || {};
  const patternOf = (row) => qualificationOf(row).pattern || {};

  function grade(score) {
    if (!finite(score)) return null;
    return (GRADE_BANDS.find(([, floor]) => score >= floor) || ["E"])[0];
  }

  function stageNumber(row) {
    const match = String((row || {}).stage || "").match(/Stage (\d)/);
    return match ? Number(match[1]) : null;
  }

  function index(rows) {
    const byId = new Map();
    for (const row of rows || []) byId.set(String(row.symbol), row);
    return byId;
  }

  /* ── sell rules (§3 Sell Watchlist, reused by the evaluation) ─────────────── */
  function stopOf(item, row) {
    const recorded = number((item || {}).entry_stop);
    if (recorded !== null) return { stop: recorded, source: "the stop recorded with the position" };
    const pattern = number(patternOf(row).stop);
    if (pattern !== null) return { stop: pattern, source: "this snapshot's active pattern stop" };
    return { stop: null, source: null };
  }

  function gainPct(item, row) {
    const cost = number((item || {}).avg_price);
    const close = number((row || {}).close);
    // finite(), never truthiness: a close of 0 is a real (catastrophic) observation and
    // must not be reported as "no gain data".
    return finite(cost) && cost > 0 && finite(close) ? ((close - cost) / cost) * 100 : null;
  }

  /* Every rule is three-valued: true (breached), false (clear) or null (the input is
     not in this snapshot). A missing input is never reported as a clear rule. */
  function sellRules(item, row) {
    const close = number((row || {}).close);
    const { stop, source } = stopOf(item, row);
    const gain = gainPct(item, row);
    const stage = stageNumber(row);
    const rs = number(ratingsOf(row).rs);
    const base = baseOf(row);
    const climax = base.climax_run === true || ((row || {}).power_play || {}).climax_run === true;
    const failed = base.status === "failed" || qualificationOf(row).entry_state === "failed"
      || base.pivot_lost === true;
    const rules = [
      { id: "stop", label: "Close below the stop",
        state: close === null || stop === null ? null : close < stop,
        detail: stop === null ? "no stop recorded with the position and no active pattern stop"
          : `close ₹${close} vs stop ₹${stop} (${source})` },
      { id: "loss8", label: "Loss of 8 % or more from the average price",
        state: gain === null ? null : gain <= STOP_LOSS_PCT,
        detail: gain === null ? "no average price on this position" : `${gain.toFixed(1)} % vs entry` },
      { id: "climax", label: "Climax run",
        state: base.climax_run === undefined && !(row || {}).power_play ? null : climax,
        detail: climax ? "a climax run is flagged on this base" : "no climax run flagged" },
      { id: "stage34", label: "Stage 3 or Stage 4",
        state: stage === null ? null : stage >= 3,
        detail: stage === null ? "no stage in this snapshot" : `${(row || {}).stage}` },
      { id: "rs40", label: "RS Rating below 40",
        state: rs === null ? null : rs < 40,
        detail: rs === null ? "no RS percentile for this row" : `RS ${rs}` },
      { id: "baseFailed", label: "The base failed",
        state: (row || {}).base ? failed : null,
        detail: failed ? `base status ${base.status || "failed"}` : "the base has not failed" },
    ];
    return { rules, triggered: rules.filter((rule) => rule.state === true),
      unknown: rules.filter((rule) => rule.state === null) };
  }

  function distanceToStop(item, row) {
    const { stop } = stopOf(item, row);
    const close = number((row || {}).close);
    return stop === null || close === null || close <= 0 ? null : ((close - stop) / close) * 100;
  }

  /* ── §3 Current Holdings ─────────────────────────────────────────────────── */
  function buyRange(item) {
    const pivot = number((item || {}).entry_pivot);
    const high = number((item || {}).entry_buy_high);
    if (pivot === null) {
      return { text: "n/a", reason: "no pattern was recorded when this position was added" };
    }
    return { text: high === null ? `₹${pivot}` : `₹${pivot} – ₹${high}`, reason: null,
      pivot, high };
  }

  function holdingCard(item, row) {
    const close = number((row || {}).close);
    const qty = number(item.qty);
    const cost = number(item.avg_price);
    const gain = gainPct(item, row);
    const decision = sellRules(item, row);
    return {
      symbol: item.symbol, name: (row || {}).name || item.symbol, missing: !row,
      close, chg_pct: (row || {}).chg_pct ?? null,
      qty, avg_price: cost,
      value: finite(qty) && finite(close) ? qty * close : null,
      cost: finite(qty) && finite(cost) ? qty * cost : null,
      gain_pct: gain,
      gain_value: finite(qty) && finite(close) && finite(cost) ? qty * (close - cost) : null,
      buy_range: buyRange(item),
      addition_date: item.entry_date || (item.added_at ? String(item.added_at).slice(0, 10) : null),
      ratings: { composite: ratingsOf(row).composite ?? null, rs: ratingsOf(row).rs ?? null,
        eps: ratingsOf(row).eps ?? null, ad: ratingsOf(row).ad ?? null },
      stage: (row || {}).stage || null,
      group: ((row || {}).group || {}).name || null,
      group_rank: ((row || {}).group || {}).rank ?? null,
      eps_due: NO_EPS_CALENDAR,
      distance_to_stop: distanceToStop(item, row),
      sell: decision,
      note: item.note || null,
      reason: row ? null : "this symbol is not in the published snapshot",
    };
  }

  function currentHoldings(holdings, rows) {
    const byId = rows instanceof Map ? rows : index(rows);
    return (holdings || []).map((item) => holdingCard(item, byId.get(String(item.symbol)) || null));
  }

  function sellWatchlist(holdings, rows) {
    return currentHoldings(holdings, rows).filter((card) => card.sell.triggered.length > 0);
  }

  /* Buy Watchlist = the system's Growth 50 near-buy names plus the visitor's own
     favorites that are Stage 2 with a base forming or near its pivot. */
  function buyWatchlist(favorites, rows, systemSymbols = []) {
    const byId = rows instanceof Map ? rows : index(rows);
    const entries = [];
    const seen = new Set();
    for (const symbol of systemSymbols || []) {
      const row = byId.get(String(symbol));
      if (!row || seen.has(String(symbol))) continue;
      seen.add(String(symbol));
      entries.push({ symbol: String(symbol), row, source: "Growth 50 · Near Buy Point" });
    }
    for (const symbol of favorites || []) {
      const key = String(symbol);
      const row = byId.get(key);
      if (!row || seen.has(key)) continue;
      const stage = stageNumber(row);
      const status = baseOf(row).status;
      const state = qualificationOf(row).entry_state;
      if (stage !== 2) continue;
      if (!["forming", "near_pivot", "breakout"].includes(String(status))
        && !["near", "forming"].includes(String(state))) continue;
      seen.add(key);
      entries.push({ symbol: key, row, source: "Favorite · Stage 2 base" });
    }
    return entries.map((entry) => ({
      symbol: entry.symbol, name: entry.row.name, source: entry.source,
      close: entry.row.close ?? null, chg_pct: entry.row.chg_pct ?? null,
      pivot: patternOf(entry.row).pivot ?? baseOf(entry.row).pivot_hint ?? null,
      buy_zone_high: patternOf(entry.row).buy_zone_high ?? null,
      stop: patternOf(entry.row).stop ?? null,
      pct_to_pivot: entry.row.pct_to_pivot ?? null,
      base_status: baseOf(entry.row).status || "none",
      ratings: ratingsOf(entry.row),
    }));
  }

  /* ── §4 Portfolio Evaluation ─────────────────────────────────────────────── */
  function stockScore(item, row) {
    const parts = [];
    const composite = number(ratingsOf(row).composite);
    if (composite !== null) parts.push(["composite", composite]);
    const stage = stageNumber(row);
    if (stage !== null) parts.push(["stage", STAGE_POINTS[stage] ?? 50]);
    const qualification = qualificationOf(row);
    if (qualification.ready === true) parts.push(["readiness", 100]);
    else if (qualification.entry_state) parts.push(["readiness", ENTRY_POINTS[qualification.entry_state] ?? 50]);
    const decision = sellRules(item, row);
    if (decision.unknown.length < decision.rules.length) {
      parts.push(["sell", Math.max(0, 100 - 40 * decision.triggered.length)]);
    }
    const weight = parts.reduce((total, [key]) => total + STOCK_WEIGHTS[key], 0);
    if (!weight) return { score: null, grade: null, components: [], reason: "no rated inputs for this row" };
    const score = parts.reduce((total, [key, value]) => total + STOCK_WEIGHTS[key] * value, 0) / weight;
    return { score: Math.round(score * 10) / 10, grade: grade(score),
      components: parts.map(([key, value]) => ({ key, value, weight: STOCK_WEIGHTS[key] / weight })),
      reason: null };
  }

  function action(card, scored) {
    if (card.sell.triggered.length) {
      return { state: "sell-rule triggered",
        why: card.sell.triggered.map((rule) => rule.label).join("; ") };
    }
    if (card.missing) return { state: "watch", why: card.reason };
    if (scored.grade === "D" || scored.grade === "E") {
      return { state: "watch", why: `evaluation grade ${scored.grade}` };
    }
    if (card.sell.unknown.length >= 3) {
      return { state: "watch", why: "too many sell-rule inputs are unavailable to clear this position" };
    }
    return { state: "hold", why: "no sell rule is breached and the leadership grade holds" };
  }

  function concentration(cards) {
    const valued = cards.filter((card) => finite(card.value) && card.value > 0);
    const total = valued.reduce((sum, card) => sum + card.value, 0);
    if (!total) {
      return { total_value: 0, top_weight: null, top_symbol: null, group_weights: [],
        top_group: null, top_group_weight: null, score: null,
        reason: "no position carries both a quantity and a price" };
    }
    const weights = valued.map((card) => ({ symbol: card.symbol, weight: (card.value / total) * 100 }))
      .sort((a, b) => b.weight - a.weight);
    const groups = new Map();
    for (const card of valued) {
      const key = card.group || "unmapped";
      groups.set(key, (groups.get(key) || 0) + (card.value / total) * 100);
    }
    const groupWeights = [...groups.entries()].map(([name, weight]) => ({ name, weight }))
      .sort((a, b) => b.weight - a.weight);
    const top = weights[0];
    const topGroup = groupWeights[0];
    const score = Math.max(0, Math.min(100,
      100 - Math.max(0, top.weight - CONCENTRATION_LIMIT) * 2
      - Math.max(0, (topGroup ? topGroup.weight : 0) - GROUP_LIMIT) * 1.5));
    return { total_value: total, top_weight: top.weight, top_symbol: top.symbol,
      weights, group_weights: groupWeights, top_group: topGroup ? topGroup.name : null,
      top_group_weight: topGroup ? topGroup.weight : null,
      score: Math.round(score * 10) / 10, reason: null };
  }

  /* ── §4 Portfolio Evaluation: coverage first, grade second ─────────────────
     Policy (SPEC-AG §5), stated here because the page states it too:

       · a position is *valued* only when a row exists, the quantity is a real number
         greater than zero, the snapshot carries a finite close, and that close is not
         stale. A stale close is reported as ``stale_priced``, never as valued.
       · a position is *scorable* only when it is valued and the per-stock score exists.
       · no scorable position  → status ``insufficient_data``: grade and score are null.
       · some scorable         → status ``partial``: the whole-portfolio grade is
         withheld and every unresolved position is named with its reason. The caller may
         re-run with ``{subset: true}`` for an explicitly labelled subset grade.
       · every position scorable → status ``ok``.
       · a component that cannot be computed is absent, and the remaining weights
         renormalise — but never from fewer than two components: one component is a
         restatement of itself, not a portfolio grade.

     Unknown is never treated as clear, and a position that cannot be priced makes total
     exposure unknown instead of smaller. */
  const MIN_COMPONENTS = 2;

  function quantityReason(value) {
    if (value === null || value === undefined || value === "") return "no quantity recorded";
    const parsed = number(value);
    if (!finite(parsed)) return `quantity ${JSON.stringify(String(value))} is not a number`;
    if (parsed === 0) return "quantity is zero";
    return `quantity ${parsed} is not greater than zero`;
  }

  /* Two lots of one symbol are one position: quantities add, the cost basis is
     quantity-weighted over the lots that carry both, and the entry date is the earliest. */
  function mergeHoldings(holdings) {
    const order = [];
    const groups = new Map();
    for (const entry of holdings || []) {
      const item = entry || {};
      const symbol = String(item.symbol || "").toUpperCase();
      if (!groups.has(symbol)) { groups.set(symbol, []); order.push(symbol); }
      groups.get(symbol).push(item);
    }
    return order.map((symbol) => {
      const lots = groups.get(symbol);
      const quantities = lots.map((lot) => number(lot.qty));
      const usable = quantities.filter((value) => finite(value) && value > 0);
      const qty = usable.length ? usable.reduce((total, value) => total + value, 0)
        : lots.length === 1 ? lots[0].qty : null;
      let costValue = 0;
      let costQty = 0;
      lots.forEach((lot, position) => {
        const price = number(lot.avg_price);
        const quantity = quantities[position];
        if (finite(price) && price > 0 && finite(quantity) && quantity > 0) {
          costValue += price * quantity;
          costQty += quantity;
        }
      });
      const avg_price = costQty > 0 ? costValue / costQty
        : lots.length === 1 ? lots[0].avg_price : null;
      const dates = lots
        .map((lot) => lot.entry_date || (lot.added_at ? String(lot.added_at).slice(0, 10) : null))
        .filter(Boolean).sort();
      return { ...lots[0], symbol, qty, avg_price, entry_date: dates[0] || null, lots: lots.length };
    });
  }

  function evaluate(holdings, rows, options = {}) {
    const byId = rows instanceof Map ? rows : index(rows);
    const items = mergeHoldings(holdings);
    const submitted = items.length;
    const unresolved = [];
    const cards = items.map((item) => {
      const row = byId.get(String(item.symbol)) || null;
      const matched = Boolean(row);
      const quantity = number(item.qty);
      const validQuantity = finite(quantity) && quantity > 0;
      const close = number((row || {}).close);
      const priced = matched && finite(close);
      const stale = matched && (row || {}).stale === true;
      const valued = matched && validQuantity && priced && !stale;
      const stalePriced = matched && validQuantity && priced && stale;
      const card = holdingCard(item, row);
      const scored = stockScore(item, row);
      const rulesKnown = card.sell.rules.some((rule) => rule.state === true || rule.state === false);
      const scorable = valued && finite(scored.score);
      const reason = !matched ? "no row for this symbol in this snapshot"
        : !validQuantity ? quantityReason(item.qty)
        : !priced ? "this snapshot carries no close for the symbol"
        : stale ? `the close is stale (last data ${(row || {}).last_date || "unknown"})`
        : !finite(scored.score) ? (scored.reason || "no rated input to score this row")
        : null;
      if (reason) unresolved.push({ symbol: item.symbol, reason });
      return {
        ...card,
        lots: item.lots || 1,
        // Only a valued position carries weight: an unpriced one makes exposure unknown,
        // it does not make the portfolio look smaller.
        value: valued ? quantity * close : null,
        observed_value: card.value,
        score: scored.score, grade: scored.grade,
        score_components: scored.components, score_reason: scored.reason,
        lifecycle_state: baseOf(row).lifecycle_state || qualificationOf(row).lifecycle_state || null,
        entry_state: qualificationOf(row).entry_state || null,
        coverage: { matched, valid_quantity: validQuantity, priced, valued,
          stale_priced: stalePriced, scorable, rules_known: rulesKnown },
        unresolved_reason: reason,
        action: action(card, scored),
      };
    });

    const valuedCards = cards.filter((card) => card.coverage.valued);
    const scorableCards = cards.filter((card) => card.coverage.scorable);
    const valuedTotal = valuedCards.reduce((total, card) => total + card.value, 0);
    const scorableValue = scorableCards.reduce((total, card) => total + card.value, 0);
    const spread = concentration(cards);
    const coverage = {
      submitted,
      matched: cards.filter((card) => card.coverage.matched).length,
      valid_quantity: cards.filter((card) => card.coverage.valid_quantity).length,
      valued: valuedCards.length,
      stale_priced: cards.filter((card) => card.coverage.stale_priced).length,
      scorable: scorableCards.length,
      rules_known: cards.filter((card) => card.coverage.rules_known).length,
      unresolved,
      valued_share: valuedTotal > 0 && scorableValue > 0 ? (scorableValue / valuedTotal) * 100 : null,
    };

    const holdingsScore = scorableValue > 0
      ? scorableCards.reduce((total, card) => total + card.score * (card.value / scorableValue), 0)
      : null;
    // Concentration needs a known total exposure. For a whole-portfolio grade that means
    // every submitted position; for an explicitly labelled subset it means every position
    // in the subset — the coverage line says which population the number covers.
    const subsetRequested = options.subset === true;
    const allValued = valuedCards.length > 0
      && valuedCards.length === (subsetRequested ? valuedCards.length : submitted);
    const concentrationScore = allValued ? spread.score : null;
    const concentrationReason = !allValued
      ? `${submitted - valuedCards.length} of ${submitted} positions have no usable price, `
        + "so total exposure is unknown"
      : valuedCards.length < submitted
        ? `computed over the ${valuedCards.length} valued positions only`
        : spread.reason;
    const ruleCards = valuedCards.filter((card) => card.coverage.rules_known);
    const ruleTotal = ruleCards.reduce((total, card) => total + card.value, 0);
    const breachedValue = ruleCards.filter((card) => card.sell.triggered.length)
      .reduce((total, card) => total + card.value, 0);
    const breachScore = valuedTotal > 0 && ruleTotal > 0
      ? 100 - (breachedValue / ruleTotal) * 100 : null;
    const breachReason = valuedTotal > 0 && ruleTotal > 0 ? null
      : "no valued position has a single known sell-rule input";

    const parts = [];
    if (finite(holdingsScore)) parts.push(["holdings", holdingsScore]);
    if (finite(concentrationScore)) parts.push(["concentration", concentrationScore]);
    if (finite(breachScore)) parts.push(["breaches", breachScore]);
    const weight = parts.reduce((total, [key]) => total + PORTFOLIO_WEIGHTS[key], 0);

    let status;
    let reason = null;
    if (!submitted) {
      status = "insufficient_data";
      reason = "no position was submitted";
    } else if (!coverage.scorable) {
      status = "insufficient_data";
      reason = `none of the ${submitted} positions could be valued and scored against this snapshot`;
    } else if (coverage.scorable === submitted) {
      status = "ok";
    } else if (subsetRequested) {
      status = "subset";
    } else {
      status = "partial";
      reason = `${submitted - coverage.scorable} of ${submitted} positions are unresolved, so no `
        + "whole-portfolio grade is published";
    }

    let score = null;
    if ((status === "ok" || status === "subset") && weight) {
      if (parts.length >= MIN_COMPONENTS) {
        score = parts.reduce((total, [key, value]) => total + PORTFOLIO_WEIGHTS[key] * value, 0) / weight;
      } else {
        reason = `only ${parts.length} of 3 grade components could be computed `
          + `(${parts.map(([key]) => key).join(", ") || "none"}), so no grade is published`;
      }
    }
    const published = finite(score);

    return {
      as_of: options.asOf || null,
      version: 2,
      status,
      subset: status === "subset",
      cards,
      concentration: { ...spread, score: concentrationScore, reason: concentrationReason },
      coverage,
      score: published ? Math.round(score * 10) / 10 : null,
      grade: published ? grade(score) : null,
      components: published
        ? parts.map(([key, value]) => ({ key, value: Math.round(value * 10) / 10,
          weight: PORTFOLIO_WEIGHTS[key] / weight }))
        : [],
      available_components: parts.map(([key, value]) => ({ key, value: Math.round(value * 10) / 10 })),
      breaches: { score: breachScore, reason: breachReason,
        valued_total: valuedTotal, breached_value: breachedValue },
      counts: {
        positions: cards.length,
        unmatched: cards.filter((card) => !card.coverage.matched).length,
        sell: cards.filter((card) => card.action.state === "sell-rule triggered").length,
        watch: cards.filter((card) => card.action.state === "watch").length,
        hold: cards.filter((card) => card.action.state === "hold").length,
      },
      reason,
    };
  }

  /* Paste or upload: "SYMBOL, qty, avg price, date" per line, or a CSV with a header
     row. Anything that is not a symbol is reported, never silently dropped. */
  function parseHoldings(text, parseCsv) {
    const rows = typeof parseCsv === "function" ? parseCsv(text)
      : String(text || "").trim().split(/\n+/).map((line) => line.split(/[,\t;]/));
    const items = [];
    const errors = [];
    let header = null;
    for (const [position, record] of (rows || []).entries()) {
      const cells = record.map((cell) => String(cell ?? "").trim().replace(/^'/, ""));
      if (!cells.length || cells.every((cell) => cell === "")) continue;
      if (position === 0 && /symbol|ticker/i.test(cells[0])) {
        header = cells.map((cell) => cell.toLowerCase());
        continue;
      }
      const at = (names, fallback) => {
        if (!header) return cells[fallback];
        const found = header.findIndex((name) => names.some((wanted) => name.includes(wanted)));
        return found >= 0 ? cells[found] : undefined;
      };
      const symbol = String(at(["symbol", "ticker"], 0) || "").toUpperCase().replace(/[^A-Z0-9&._-]/g, "");
      if (!symbol) { errors.push({ line: position + 1, text: cells.join(","), reason: "no symbol" }); continue; }
      const item = { symbol };
      const qty = number(at(["qty", "quantity", "shares"], 1));
      const price = number(at(["avg", "price", "cost"], 2));
      const date = String(at(["date", "entry"], 3) || "").slice(0, 10);
      if (qty !== null) item.qty = qty;
      if (price !== null) item.avg_price = price;
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) item.entry_date = date;
      items.push(item);
    }
    return { items, errors };
  }

  /* ── shared renderers ────────────────────────────────────────────────────
     The site and the local app pass their own escaping/formatting helpers and get
     byte-identical markup, so the two clients cannot drift apart. ``helpers`` needs
     ``esc``, ``fmt(value, digits)``, ``signed(value)``, ``cls(value)`` and
     ``url(path)``. ``stockUrl(symbol)`` is optional: a client that knows which symbols
     own a full page passes it so every link resolves; without it the caller's own
     ``url`` rewrite applies, exactly as before. */
  function renderers(helpers) {
    const { esc, fmt, signed, cls, url } = helpers;
    const money = (value, digits = 2) => (finite(value) ? `₹${fmt(value, digits)}` : "–");
    const href = (symbol) => (typeof helpers.stockUrl === "function"
      ? helpers.stockUrl(symbol) : url(`/s/${symbol}.html`));
    const link = (symbol) => `<a class="list-symbol" href="${esc(href(symbol))}">${esc(symbol)}</a>`;
    /* A row inside one of the reader's own lists links with that list as its keyboard
       context, so Space/→ walks Favorites exactly as it walks a published list. */
    const contextLink = (listId, symbol, index) => (helpers.contextUrl
      ? `<a class="list-symbol" href="${esc(helpers.contextUrl(listId, symbol, index))}">${esc(symbol)}</a>`
      : link(symbol));

    /* A rule this snapshot cannot answer reads "unknown". A set of unknown rules is
       never summarised as "clear" — that was the fifth audit's A4 in miniature. */
    function sellCell(card) {
      if (card.sell.triggered.length) {
        return `<span class="negative">${esc(card.sell.triggered.map((rule) => rule.label).join("; "))}</span>`;
      }
      if (card.sell.unknown.length === card.sell.rules.length) {
        return '<span class="muted">unknown — no sell-rule input in this snapshot</span>';
      }
      return card.sell.unknown.length
        ? `<span class="muted">not triggered (${card.sell.unknown.length} inputs unknown)</span>`
        : '<span class="positive">not triggered</span>';
    }

    function holdingsTable(cards) {
      if (!cards.length) {
        return `<p class="list-empty">No positions yet. Open a stock page and use "Record position…", `
          + `or import a CSV on <a href="${esc(url("/my/my-lists.html"))}">My Lists</a>.</p>`;
      }
      const rows = cards.map((card) => `<tr><td>${link(card.symbol)}</td><td>${esc(card.name)}</td>
        <td>${money(card.close)}</td><td class="${esc(cls(card.chg_pct))}">${esc(signed(card.chg_pct))}</td>
        <td>${fmt(card.qty, 0)}</td><td>${money(card.avg_price)}</td>
        <td class="${esc(cls(card.gain_pct))}">${esc(signed(card.gain_pct))}</td>
        <td>${esc(card.buy_range.text)}${card.buy_range.reason
          ? `<small class="muted"> ${esc(card.buy_range.reason)}</small>` : ""}</td>
        <td>${esc(card.addition_date || "–")}</td>
        <td>${fmt(card.ratings.composite, 0)}/${fmt(card.ratings.rs, 0)}/${fmt(card.ratings.eps, 0)}/${esc(card.ratings.ad || "–")}</td>
        <td>${esc(card.eps_due)}</td><td>${sellCell(card)}</td></tr>`).join("");
      return `<div class="detail-table-wrap"><table class="detail-table"><thead><tr>
        <th>Symbol</th><th>Name</th><th>CMP</th><th>1D %</th><th>Qty</th><th>Avg price</th><th>Gain %</th>
        <th>Buy range at entry</th><th>Added</th><th>Comp/RS/EPS/AD</th><th>EPS due</th><th>Sell rules</th>
        </tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    function buyWatchlistTable(entries) {
      if (!entries.length) {
        return `<p class="list-empty">Nothing on the buy watchlist: this snapshot's Growth 50 has no `
          + `near-buy name and none of your favorites is a Stage 2 base.</p>`;
      }
      const rows = entries.map((entry) => `<tr><td>${link(entry.symbol)}</td>
        <td>${esc(entry.name)}</td><td>${esc(entry.source)}</td><td>${money(entry.close)}</td>
        <td class="${esc(cls(entry.chg_pct))}">${esc(signed(entry.chg_pct))}</td>
        <td>${money(entry.pivot)}</td><td>${money(entry.buy_zone_high)}</td><td>${money(entry.stop)}</td>
        <td>${fmt(entry.pct_to_pivot, 1)}%</td>
        <td>${esc(String(entry.base_status).replace(/_/g, " "))}</td>
        <td>${fmt(entry.ratings.composite, 0)}/${fmt(entry.ratings.rs, 0)}/${fmt(entry.ratings.eps, 0)}</td>
        </tr>`).join("");
      return `<div class="detail-table-wrap"><table class="detail-table"><thead><tr>
        <th>Symbol</th><th>Name</th><th>Source</th><th>Price</th><th>1D %</th><th>Pivot</th>
        <th>Buy limit</th><th>Stop</th><th>% to pivot</th><th>Base</th><th>Comp/RS/EPS</th>
        </tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    function evaluation(result) {
      if (!result.cards.length) return `<p class="list-empty">No positions to evaluate yet.</p>`;
      const spread = result.concentration;
      const coverage = result.coverage || { submitted: result.cards.length, unresolved: [] };
      const unresolved = coverage.unresolved || [];
      const weight = (card) => (finite(card.value) && spread.total_value
        ? `${fmt((card.value / spread.total_value) * 100, 1)}%` : "–");
      const policy = "Policy: a position counts only when this snapshot carries a row, a "
        + "quantity above zero and a fresh close. Unknown is neither failed nor clear, an "
        + "unpriced position makes total exposure unknown, and a grade needs at least two "
        + "components.";
      const counts = `Coverage: ${coverage.submitted} submitted · ${coverage.matched} matched · `
        + `${coverage.valid_quantity} with a usable quantity · ${coverage.valued} valued · `
        + `${coverage.stale_priced} stale-priced · ${coverage.scorable} scorable · `
        + `${coverage.rules_known} with a known sell rule.`;
      const list = unresolved.map((entry) => `${entry.symbol} (${entry.reason})`).join(", ");
      const resolved = coverage.submitted - unresolved.length;
      const banner = result.status === "insufficient_data"
        ? `<div class="evaluation-banner negative"><b>Cannot evaluate</b>
            <p>${esc(result.reason || "nothing in this input could be scored against this snapshot.")}</p>
            ${unresolved.length ? `<p class="fineprint">${esc(list)}</p>` : ""}</div>`
        : result.status === "partial"
          ? `<div class="evaluation-banner negative"><b>Portfolio grade withheld</b>
              <p>${unresolved.length} of ${coverage.submitted} positions unresolved: ${esc(list)}</p>
              <button type="button" data-evaluation-subset="1">Evaluate the ${resolved} resolved
                positions as a subset</button></div>`
          : result.status === "subset"
            ? `<div class="evaluation-banner"><b>Subset grade ${esc(result.grade || "–")}</b>
                <p>${result.score === null ? "no score" : `${fmt(result.score, 1)} / 100`} ·
                covers ${coverage.scorable} of ${coverage.submitted} positions
                (${coverage.valued_share === null ? "unknown" : `${fmt(coverage.valued_share, 1)} %`}
                of resolved value)</p>
                ${unresolved.length ? `<p class="fineprint">Excluded: ${esc(list)}</p>` : ""}</div>`
            : "";
      const headline = result.grade === null
        ? `<div class="evaluation-grade"><span>Portfolio grade</span><b>–</b>
            <em>${esc(result.status === "insufficient_data" ? "not evaluated" : "withheld")}</em></div>`
        : `<div class="evaluation-grade"><span>${result.status === "subset" ? "Subset grade" : "Portfolio grade"}</span>
            <b>${esc(result.grade)}</b><em>${fmt(result.score, 1)} / 100</em></div>`;
      const summary = `<div class="evaluation-summary">${banner}${headline}
        <div class="geometry-grid">
          <div class="brief-metric"><span>Positions</span><b>${result.counts.positions}</b></div>
          <div class="brief-metric"><span>Valued</span><b>${coverage.valued}</b></div>
          <div class="brief-metric"><span>Sell-rule triggered</span>
            <b class="${result.counts.sell ? "negative" : "positive"}">${result.counts.sell}</b></div>
          <div class="brief-metric"><span>Watch</span><b>${result.counts.watch}</b></div>
          <div class="brief-metric"><span>Hold</span><b>${result.counts.hold}</b></div>
          <div class="brief-metric"><span>Top position</span><b>${spread.top_symbol
            ? `${esc(spread.top_symbol)} ${fmt(spread.top_weight, 1)}%` : "–"}</b></div>
          <div class="brief-metric"><span>Top group</span><b>${spread.top_group
            ? `${esc(spread.top_group)} ${fmt(spread.top_group_weight, 1)}%` : "–"}</b></div>
        </div>
        <p class="fineprint">Grade = ${result.components.map((part) =>
          `${esc(part.key)} ${fmt(part.value, 1)} × ${fmt(part.weight * 100, 0)}%`).join(" + ")
          || "no component available"}. Bands A ≥ 85 · B ≥ 70 · C ≥ 55 · D ≥ 40 · E below.
          ${esc(result.reason || "")}</p>
        <p class="fineprint">${esc(counts)}</p>
        <p class="fineprint">${esc(policy)}</p></div>`;
      const cards = result.cards.map((card) => `<article class="evaluation-card">
        <header>${link(card.symbol)}<b class="grade-${esc(card.grade || "none")}">${esc(card.grade || "–")}</b></header>
        <p class="muted">${esc(card.name)}${card.unresolved_reason ? ` — ${esc(card.unresolved_reason)}` : ""}
          ${card.lots > 1 ? `<small>lots: ${card.lots}</small>` : ""}</p>
        <dl>
          <div><dt>Composite</dt><dd>${fmt(card.ratings.composite, 0)}</dd></div>
          <div><dt>RS</dt><dd>${fmt(card.ratings.rs, 0)}</dd></div>
          <div><dt>EPS</dt><dd>${fmt(card.ratings.eps, 0)}</dd></div>
          <div><dt>A/D</dt><dd>${esc(card.ratings.ad || "–")}</dd></div>
          <div><dt>Stage</dt><dd>${esc(card.stage || "–")}</dd></div>
          <div><dt>Lifecycle</dt><dd>${esc(card.lifecycle_state || "–")}</dd></div>
          <div><dt>Group rank</dt><dd>${fmt(card.group_rank, 0)}</dd></div>
          <div><dt>To stop</dt><dd>${finite(card.distance_to_stop) ? `${fmt(card.distance_to_stop, 1)}%` : "–"}</dd></div>
          <div><dt>Gain</dt><dd class="${esc(cls(card.gain_pct))}">${esc(signed(card.gain_pct))}</dd></div>
          <div><dt>Weight</dt><dd>${weight(card)}</dd></div>
        </dl>
        <p class="evaluation-action ${card.action.state === "hold" ? "positive"
          : card.action.state === "watch" ? "muted" : "negative"}">
          ${esc(card.action.state)} — ${esc(card.action.why)}</p>
        <ul class="sell-rules">${card.sell.rules.map((rule) => `<li class="${rule.state === true
          ? "negative" : rule.state === false ? "positive" : "muted"}">${esc(rule.label)}: ${rule.state === true
          ? "triggered" : rule.state === false ? "not triggered" : "unknown"} <small>${esc(rule.detail)}</small></li>`).join("")}</ul>
        </article>`).join("");
      return `${summary}<div class="evaluation-cards">${cards}</div>`;
    }

    /* ``lists`` is MyLists.listsOf(store): the module boundary stays one-way. */
    function myLists(lists) {
      return (lists || []).map((list) => {
        const rows = (list.items || []).map((item, index) => `<tr><td>${contextLink(list.id, item.symbol, index)}</td>
          <td>${item.qty === undefined ? "–" : fmt(item.qty, 0)}</td>
          <td>${item.avg_price === undefined ? "–" : money(item.avg_price)}</td>
          <td>${esc(item.entry_date || String(item.added_at || "").slice(0, 10) || "–")}</td>
          <td>${esc(item.note || "")}</td>
          <td><button type="button" data-remove-list="${esc(list.id)}" data-remove-symbol="${esc(item.symbol)}">remove</button></td>
          </tr>`).join("");
        return `<section class="card user-list" data-list="${esc(list.id)}">
          <div class="card-head"><div><span class="eyebrow">${esc(list.builtin ? list.kind : "custom")}</span>
            <h2>${esc(list.title)} <small>${list.count}</small></h2></div>
            <div class="user-actions">
              <button type="button" data-export-list="${esc(list.id)}">CSV</button>
              <label class="file-button">Import CSV<input type="file" data-import-list="${esc(list.id)}" accept=".csv,text/csv,text/plain"></label>
              ${list.builtin ? "" : `<button type="button" data-delete-list="${esc(list.id)}">delete list</button>`}
            </div></div>
          ${list.description ? `<p class="fineprint">${esc(list.description)}</p>` : ""}
          ${list.count ? `<div class="detail-table-wrap"><table class="detail-table"><thead><tr>
            <th>Symbol</th><th>Qty</th><th>Avg price</th><th>Date</th><th>Note</th><th></th></tr></thead>
            <tbody>${rows}</tbody></table></div>` : `<p class="list-empty">This list is empty.</p>`}
          </section>`;
      }).join("");
    }

    return { holdingsTable, buyWatchlistTable, evaluation, myLists };
  }

  return {
    contractVersion: PORTFOLIO_CONTRACT_VERSION, GRADE_BANDS, STOCK_WEIGHTS, PORTFOLIO_WEIGHTS,
    STAGE_POINTS, ENTRY_POINTS, CONCENTRATION_LIMIT, GROUP_LIMIT, STOP_LOSS_PCT,
    NO_EPS_CALENDAR, AI_EVALUATION_LIMIT,
    grade, stageNumber, index, sellRules, stopOf, gainPct, distanceToStop, buyRange,
    holdingCard, currentHoldings, sellWatchlist, buyWatchlist, stockScore, action,
    concentration, evaluate, mergeHoldings, quantityReason, parseHoldings, renderers,
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = Portfolio;
