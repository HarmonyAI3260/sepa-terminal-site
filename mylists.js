/* Shared, DOM-free store for the user's own lists (SPEC-AF §2).
 *
 * Everything the visitor keeps — My Portfolio, Favorite Stocks, Recently Viewed,
 * Liked, Disliked and any list they name — lives in one versioned JSON document in
 * localStorage. The published site has no accounts and uploads nothing; the local
 * app can additionally push the same document to /api/lists, and the merge that
 * makes that safe is implemented here once so both clients agree.
 *
 * The document:
 *   {version, updated_at, lists: {id: {id, title, kind, created_at, updated_at,
 *                                      items: [{symbol, added_at, note, qty,
 *                                               avg_price, entry_date}]}}}
 */
"use strict";
const MyLists = (() => {
  const MYLISTS_CONTRACT_VERSION = "mylists-contract-1.0";
  const STORAGE_KEY = "sepa_lists";
  const VERSION = 1;
  const RECENT_LIMIT = 100;
  const ITEM_LIMIT = 2000;
  const BUILTIN = [
    { id: "portfolio", title: "My Portfolio", kind: "portfolio",
      description: "Positions you hold, with quantity, average price and entry date." },
    { id: "favorites", title: "Favorite Stocks", kind: "watch",
      description: "Names you starred; they feed the Buy Watchlist." },
    { id: "recent", title: "Recently Viewed", kind: "recent",
      description: "The last 100 stock pages you opened in this browser." },
    { id: "liked", title: "Liked", kind: "opinion", description: "Names you marked with a thumbs up." },
    { id: "disliked", title: "Disliked", kind: "opinion", description: "Names you marked with a thumbs down." },
  ];
  const BUILTIN_IDS = new Set(BUILTIN.map((entry) => entry.id));
  const KINDS = new Set([...BUILTIN.map((entry) => entry.kind), "custom"]);
  // Numeric position fields. entry_pivot/entry_stop/entry_buy_high are the pattern the
  // position was taken on, recorded when the stock page adds it, so Current Holdings can
  // show the buy range that applied at entry instead of today's pattern.
  const HOLDING_FIELDS = ["qty", "avg_price", "entry_pivot", "entry_stop", "entry_buy_high"];
  const NUMERIC_FIELDS = ["qty", "avg_price", "entry_pivot", "entry_stop", "entry_buy_high"];
  const CSV_COLUMNS = ["symbol", "qty", "avg_price", "entry_date", "entry_pivot", "entry_stop",
    "entry_buy_high", "note", "added_at"];

  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const number = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(String(value).replace(/[₹,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const now = () => new Date().toISOString();
  const symbolOf = (value) => String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9&._-]/g, "");
  const isoDate = (value) => {
    const text = String(value ?? "").trim();
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
  };

  function slug(title) {
    const base = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return base ? `user-${base}`.slice(0, 60) : `user-${Date.now().toString(36)}`;
  }

  function emptyStore() {
    const lists = {};
    for (const entry of BUILTIN) {
      lists[entry.id] = { id: entry.id, title: entry.title, kind: entry.kind,
        created_at: null, updated_at: null, items: [] };
    }
    return { version: VERSION, updated_at: null, lists };
  }

  function normalizeItem(raw) {
    const symbol = symbolOf(raw && (raw.symbol ?? raw.Symbol ?? raw));
    if (!symbol) return null;
    const item = { symbol, added_at: null, note: null };
    if (raw && typeof raw === "object") {
      item.added_at = raw.added_at ? String(raw.added_at) : null;
      item.note = raw.note ? String(raw.note).slice(0, 500) : null;
      for (const key of NUMERIC_FIELDS) {
        const value = number(raw[key]);
        if (value !== null) item[key] = value;
      }
      const entry = isoDate(raw.entry_date);
      if (entry) item.entry_date = entry;
    }
    return item;
  }

  /* A document from any earlier shape, from another browser or from the local app.
     Unknown keys are dropped; a document written by a *newer* version is preserved
     untouched and flagged read-only, so a stale tab can never overwrite it. */
  function normalize(raw) {
    const store = emptyStore();
    if (!raw || typeof raw !== "object") return store;
    const version = Number(raw.version);
    if (Number.isFinite(version) && version > VERSION) {
      return { ...store, ...raw, version, readOnly: true,
        reason: `this browser stores My Lists v${VERSION}; the saved document is v${version}` };
    }
    const source = raw.lists && typeof raw.lists === "object" ? raw.lists
      : (Array.isArray(raw) ? {} : raw);
    for (const [id, value] of Object.entries(source || {})) {
      if (!value || typeof value !== "object") continue;
      const listId = String(id).slice(0, 60);
      const definition = BUILTIN.find((entry) => entry.id === listId);
      const items = Array.isArray(value.items) ? value.items : Array.isArray(value) ? value : [];
      const kind = KINDS.has(value.kind) ? value.kind : definition ? definition.kind : "custom";
      const seen = new Set();
      const normalized = [];
      for (const candidate of items) {
        const item = normalizeItem(candidate);
        if (!item || seen.has(item.symbol)) continue;
        seen.add(item.symbol);
        normalized.push(item);
        if (normalized.length >= ITEM_LIMIT) break;
      }
      store.lists[listId] = {
        id: listId,
        title: String(value.title || (definition ? definition.title : listId)).slice(0, 80),
        kind,
        created_at: value.created_at ? String(value.created_at) : null,
        updated_at: value.updated_at ? String(value.updated_at) : null,
        items: listId === "recent" ? normalized.slice(0, RECENT_LIMIT) : normalized,
      };
    }
    store.updated_at = raw.updated_at ? String(raw.updated_at) : null;
    store.version = VERSION;
    return store;
  }

  function load(storage) {
    try {
      return normalize(JSON.parse((storage || {}).getItem(STORAGE_KEY) || "null"));
    } catch {
      return emptyStore();
    }
  }

  function save(storage, store) {
    if (store && store.readOnly) return false;
    try {
      (storage || {}).setItem(STORAGE_KEY, JSON.stringify({ ...store, updated_at: now() }));
      return true;
    } catch {
      return false;   // private mode: the page still works for this session
    }
  }

  function listsOf(store) {
    const lists = (store || {}).lists || {};
    const builtin = BUILTIN.map((entry) => lists[entry.id]).filter(Boolean);
    const custom = Object.values(lists)
      .filter((list) => !BUILTIN_IDS.has(list.id))
      .sort((a, b) => String(a.title).localeCompare(String(b.title)));
    return [...builtin, ...custom].map((list) => ({
      ...list, count: (list.items || []).length,
      description: (BUILTIN.find((entry) => entry.id === list.id) || {}).description || null,
      builtin: BUILTIN_IDS.has(list.id),
    }));
  }

  function get(store, id) {
    return ((store || {}).lists || {})[id] || null;
  }

  function ensure(store, id, title, kind) {
    const lists = store.lists || (store.lists = {});
    if (!lists[id]) {
      lists[id] = { id, title: title || id, kind: kind || "custom", created_at: now(),
        updated_at: now(), items: [] };
    }
    return lists[id];
  }

  function has(store, id, symbol) {
    return (get(store, id)?.items || []).some((item) => item.symbol === symbolOf(symbol));
  }

  function add(store, id, entry, { title = null, kind = null, front = false } = {}) {
    const item = normalizeItem(entry);
    if (!item) return store;
    const list = ensure(store, id, title, kind);
    item.added_at = item.added_at || now();
    const existing = list.items.findIndex((candidate) => candidate.symbol === item.symbol);
    if (existing >= 0) {
      list.items[existing] = { ...list.items[existing], ...item,
        added_at: list.items[existing].added_at || item.added_at };
      if (front) list.items.unshift(list.items.splice(existing, 1)[0]);
    } else if (front) {
      list.items.unshift(item);
    } else {
      list.items.push(item);
    }
    if (id === "recent") list.items = list.items.slice(0, RECENT_LIMIT);
    list.updated_at = now();
    return store;
  }

  function remove(store, id, symbol) {
    const list = get(store, id);
    if (!list) return store;
    const wanted = symbolOf(symbol);
    list.items = list.items.filter((item) => item.symbol !== wanted);
    list.updated_at = now();
    return store;
  }

  function toggle(store, id, entry, options = {}) {
    const symbol = symbolOf(entry && (entry.symbol ?? entry));
    return has(store, id, symbol) ? remove(store, id, symbol) : add(store, id, entry, options);
  }

  /* Liked and Disliked are opposites: setting one clears the other. */
  function opinion(store, symbol, verdict) {
    const other = verdict === "liked" ? "disliked" : "liked";
    remove(store, other, symbol);
    return toggle(store, verdict, { symbol });
  }

  function touchRecent(store, symbol, extra = {}) {
    return add(store, "recent", { symbol, ...extra, added_at: now() }, { front: true });
  }

  function createList(store, title) {
    const id = slug(title);
    ensure(store, id, String(title || "Untitled list").slice(0, 80), "custom");
    return id;
  }

  function renameList(store, id, title) {
    const list = get(store, id);
    if (!list || BUILTIN_IDS.has(id)) return false;
    list.title = String(title || list.title).slice(0, 80);
    list.updated_at = now();
    return true;
  }

  function deleteList(store, id) {
    if (BUILTIN_IDS.has(id) || !get(store, id)) return false;
    delete store.lists[id];
    return true;
  }

  function updateHolding(store, symbol, fields = {}) {
    const list = ensure(store, "portfolio", "My Portfolio", "portfolio");
    const wanted = symbolOf(symbol);
    let item = list.items.find((candidate) => candidate.symbol === wanted);
    if (!item) {
      add(store, "portfolio", { symbol: wanted, ...fields });
      return get(store, "portfolio").items.find((candidate) => candidate.symbol === wanted);
    }
    for (const key of [...HOLDING_FIELDS, "entry_date"]) {
      if (!(key in fields)) continue;
      const value = key === "entry_date" ? isoDate(fields[key]) : number(fields[key]);
      if (value === null) delete item[key];
      else item[key] = value;
    }
    if ("note" in fields) item.note = fields.note ? String(fields.note).slice(0, 500) : null;
    list.updated_at = now();
    return item;
  }

  /* Positions only: a My Portfolio row without a quantity is a watch item. */
  function holdings(store) {
    return (get(store, "portfolio")?.items || [])
      .filter((item) => finite(item.qty) && item.qty > 0 && finite(item.avg_price) && item.avg_price > 0);
  }

  function symbols(store, id) {
    return (get(store, id)?.items || []).map((item) => item.symbol);
  }

  /* ── import / export ─────────────────────────────────────────────────────── */
  function exportJson(store) {
    return `${JSON.stringify({ ...normalize(store), exported_at: now(),
      contract: MYLISTS_CONTRACT_VERSION }, null, 1)}\n`;
  }

  function importJson(store, text, { replace = false } = {}) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "not valid JSON", store };
    }
    const incoming = normalize(parsed);
    if (incoming.readOnly) return { ok: false, error: incoming.reason, store };
    const total = (snapshot) => Object.values(snapshot.lists)
      .reduce((count, list) => count + list.items.length, 0);
    const merged = replace ? incoming : merge(store, incoming);
    return { ok: true, store: merged, lists: Object.keys(incoming.lists).length,
      added: replace ? null : total(merged) - total(normalize(store)) };
  }

  function csvCell(value) {
    if (value === null || value === undefined) return "";
    let text = String(value);
    if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function exportCsv(store, id) {
    const list = get(store, id);
    const header = [`# ${list ? list.title : id} · ${(list?.items || []).length} rows`,
      `# exported ${now()} · ${MYLISTS_CONTRACT_VERSION}`, CSV_COLUMNS.join(",")];
    const lines = (list?.items || []).map((item) =>
      CSV_COLUMNS.map((key) => csvCell(item[key] ?? "")).join(","));
    return `${[...header, ...lines].join("\n")}\n`;
  }

  /* A tolerant CSV reader: any column order, quoted cells, comment lines skipped and
     the leading apostrophe a spreadsheet-safe export adds removed again. */
  function parseCsv(text) {
    const rows = [];
    let field = "", record = [], quoted = false;
    const source = String(text || "").replace(/\r\n?/g, "\n");
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
        else if (character === '"') quoted = false;
        else field += character;
      } else if (character === '"') quoted = true;
      else if (character === ",") { record.push(field); field = ""; }
      else if (character === "\n") { record.push(field); rows.push(record); record = []; field = ""; }
      else field += character;
    }
    if (field !== "" || record.length) { record.push(field); rows.push(record); }
    return rows.filter((row) => row.some((cell) => String(cell).trim() !== ""))
      .filter((row) => !String(row[0]).trim().startsWith("#"));
  }

  function importCsv(store, id, text, { title = null } = {}) {
    const rows = parseCsv(text);
    if (!rows.length) return { ok: false, error: "no rows in this file", store };
    const clean = (value) => String(value ?? "").trim().replace(/^'/, "");
    let header = rows[0].map((cell) => clean(cell).toLowerCase().replace(/[^a-z_]/g, "_"));
    let body = rows.slice(1);
    const knows = header.some((name) => name.includes("symbol"));
    if (!knows) { header = ["symbol", "qty", "avg_price", "entry_date", "note"]; body = rows; }
    const column = (names) => header.findIndex((name) => names.some((wanted) => name.includes(wanted)));
    const positions = { symbol: column(["symbol", "ticker"]), qty: column(["qty", "quantity", "shares"]),
      avg_price: column(["avg_price", "avgprice", "average", "cost"]),
      entry_date: column(["entry_date", "date", "added"]), note: column(["note", "comment"]),
      entry_pivot: column(["pivot"]), entry_stop: column(["stop"]) };
    if (positions.avg_price < 0) positions.avg_price = column(["price"]);
    let imported = 0, skipped = 0;
    for (const record of body) {
      const raw = { symbol: positions.symbol >= 0 ? clean(record[positions.symbol]) : "" };
      for (const key of ["qty", "avg_price", "entry_date", "note", "entry_pivot", "entry_stop"]) {
        if (positions[key] >= 0) raw[key] = clean(record[positions[key]]);
      }
      if (!symbolOf(raw.symbol)) { skipped += 1; continue; }
      add(store, id, raw, { title, kind: id === "portfolio" ? "portfolio" : "custom" });
      imported += 1;
    }
    return { ok: imported > 0, store, imported, skipped,
      error: imported ? null : "no usable symbol column" };
  }

  /* ── merge (import and local-app sync) ───────────────────────────────────── */
  const stamp = (item) => String((item || {}).added_at || "");

  /* Union by symbol. Within a symbol the newer side wins field by field, but only
     with a value it actually has: a position edited in one browser is never erased
     because the other browser merely viewed the same stock. ``added_at`` keeps the
     later touch so Recently Viewed still orders by last visit. */
  function mergeItem(a, b) {
    const newer = stamp(a) >= stamp(b) ? a : b;
    const older = newer === a ? b : a;
    const result = { ...older };
    for (const [key, value] of Object.entries(newer)) {
      if (value !== null && value !== undefined) result[key] = value;
    }
    result.added_at = [stamp(a), stamp(b)].filter(Boolean).sort().pop() || null;
    return result;
  }

  function mergeItems(mine, theirs, limit) {
    const byId = new Map();
    for (const item of [...(mine || []), ...(theirs || [])]) {
      const previous = byId.get(item.symbol);
      byId.set(item.symbol, previous ? mergeItem(previous, item) : { ...item });
    }
    const merged = [...byId.values()];
    merged.sort((a, b) => stamp(b).localeCompare(stamp(a)) || a.symbol.localeCompare(b.symbol));
    return limit ? merged.slice(0, limit) : merged;
  }

  function merge(mine, theirs) {
    const left = normalize(mine);
    const right = normalize(theirs);
    const store = emptyStore();
    for (const id of new Set([...Object.keys(left.lists), ...Object.keys(right.lists)])) {
      const a = left.lists[id];
      const b = right.lists[id];
      const base = a || b;
      store.lists[id] = { ...base,
        title: (a && b ? (String(a.updated_at || "") >= String(b.updated_at || "") ? a : b) : base).title,
        items: mergeItems(a?.items, b?.items, id === "recent" ? RECENT_LIMIT : ITEM_LIMIT),
        updated_at: [a?.updated_at, b?.updated_at].filter(Boolean).sort().pop() || null };
    }
    store.updated_at = [left.updated_at, right.updated_at].filter(Boolean).sort().pop() || null;
    return store;
  }

  function counts(store) {
    return listsOf(store).reduce((total, list) => ({ ...total, [list.id]: list.count }), {});
  }

  return {
    contractVersion: MYLISTS_CONTRACT_VERSION, STORAGE_KEY, VERSION, RECENT_LIMIT, BUILTIN,
    CSV_COLUMNS, emptyStore, normalize, load, save, listsOf, get, has, add, remove, toggle,
    opinion, touchRecent, createList, renameList, deleteList, updateHolding, holdings, symbols,
    exportJson, importJson, exportCsv, importCsv, parseCsv, csvCell, merge, mergeItems, counts,
    slug, symbolOf,
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = MyLists;
