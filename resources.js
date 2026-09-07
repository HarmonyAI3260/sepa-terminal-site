/* Shared, DOM-free compatibility check for every published JSON (SPEC-AI §3).
 *
 * Every file this site publishes carries a ``resource`` envelope: what it is, which build
 * wrote it, the last observation inside it, how fresh that is, and the content hash of
 * its inputs. One validator reads that envelope for the daily series, the weekly series,
 * both index feeds, the per-symbol stock JSON, the route manifest, the list payloads and
 * the financial chart models, so an older file can never render silently as current.
 *
 * Compatibility is a declared dependency relationship, not build-id equality: a resource
 * from another build is usable when it observes exactly the date this page claims AND
 * its input hash is the one this build's manifest records for it. Anything else is
 * foreign and the dependent view is blocked or explicitly limited — never mixed with a
 * current pattern, stop or risk map.
 */
"use strict";
const Resources = (() => {
  const SCHEMA_VERSION = "resource-1.0";
  const KINDS = ["series", "weekly", "index", "stock", "routes", "list", "chart_model",
    "screener"];
  // ok  : the payload may render (status says how it must be labelled)
  // !ok : the dependent view must be blocked or replaced by a stated fallback
  const STATUSES = {
    current: { ok: true, label: "current" },
    compatible: { ok: true, label: "compatible with this build" },
    lagging: { ok: true, label: "one session behind" },
    stale: { ok: true, label: "more than one session behind" },
    foreign: { ok: false, label: "from another build" },
    missing: { ok: false, label: "no resource envelope" },
    conflicted: { ok: false, label: "a different resource than the one requested" },
  };

  const text = (value) => (value === null || value === undefined ? "" : String(value));

  function envelopeOf(payload) {
    const envelope = payload && typeof payload === "object" ? payload.resource : null;
    return envelope && typeof envelope === "object" ? envelope : null;
  }

  /* The per-resource hash this build's manifest records, when it records one. Only the
     dated inputs (the indices, the benchmark, the deals and industry feeds) are listed
     individually; a per-symbol series is summarised by kind, so it can never be declared
     compatible across builds — it is either this build's file or it is foreign. */
  function manifestHash(manifest, id) {
    const inputs = ((manifest || {}).resources || {}).inputs || {};
    const entry = inputs[text(id)];
    return entry && entry.input_hash ? text(entry.input_hash) : null;
  }

  function manifestObserved(manifest, id) {
    const inputs = ((manifest || {}).resources || {}).inputs || {};
    const entry = inputs[text(id)];
    return entry && entry.observed_through ? text(entry.observed_through) : null;
  }

  function result(status, reason, envelope) {
    return { ok: Boolean((STATUSES[status] || {}).ok), status, reason, envelope: envelope || null };
  }

  /* ``expectation``: { kind, buildId, asOf, instrument, manifest }. Every field is
     optional; a check with no expectation to compare against is simply not made. */
  function validate(payload, expectation = {}) {
    const envelope = envelopeOf(payload);
    const wanted = text(expectation.kind);
    if (!envelope) {
      return result("missing", `${wanted || "this resource"} carries no resource envelope, `
        + "so its build and its last observation cannot be checked", null);
    }
    if (wanted && text(envelope.kind) !== wanted) {
      return result("conflicted", `expected a ${wanted} resource but ${text(envelope.id)} is a `
        + `${text(envelope.kind) || "kind-less"} resource`, envelope);
    }
    if (expectation.instrument && text(envelope.instrument)
      && text(envelope.instrument) !== text(expectation.instrument)) {
      return result("conflicted", `${text(envelope.id)} carries ${text(envelope.instrument)}, `
        + `not ${text(expectation.instrument)}`, envelope);
    }
    if (text(envelope.schema_version) !== SCHEMA_VERSION) {
      return result("foreign", `${text(envelope.id)} uses schema `
        + `${text(envelope.schema_version) || "none"}, this page reads ${SCHEMA_VERSION}`, envelope);
    }
    const page = text(expectation.buildId);
    const built = text(envelope.build_id);
    if (page && built && page !== built) {
      // Another build's file is usable only when it is declared compatible: the same
      // observation date as this page AND the input hash this build's manifest records.
      const asOf = text(expectation.asOf);
      const observed = text(envelope.observed_through);
      const recorded = manifestHash(expectation.manifest, envelope.id);
      const recordedDate = manifestObserved(expectation.manifest, envelope.id);
      const dateOk = Boolean(asOf) && (observed === asOf || (recordedDate && observed === recordedDate));
      const hashOk = Boolean(recorded) && recorded === text(envelope.input_hash);
      if (dateOk && hashOk) {
        return result("compatible", `${text(envelope.id)} is from build ${built}, but it `
          + `observes ${observed} with the input hash this build records `
          + `(${text(envelope.input_hash)})`, envelope);
      }
      return result("foreign", `${text(envelope.id)} is from build ${built}, not ${page}`
        + (observed ? ` (it observes ${observed}` : " (no observation date")
        + `${recorded ? `, hash ${hashOk ? "matches" : "does not match"} this build` : ""})`,
      envelope);
    }
    const status = text(envelope.status) || "current";
    if (status === "lagging" || status === "stale") {
      return result(status, `${text(envelope.id)} last observed ${text(envelope.observed_through)}`
        + `${text(expectation.asOf) ? `, this snapshot prices ${text(expectation.asOf)}` : ""}`,
      envelope);
    }
    return result("current", `${text(envelope.id)} matches this build`, envelope);
  }

  /* One sentence for the surface that shows it; the caller decides whether it is a
     blocked view, a fallback or a label. */
  function describe(check) {
    if (!check) return "";
    const envelope = check.envelope || {};
    const id = text(envelope.id) || "this resource";
    const label = (STATUSES[check.status] || {}).label || check.status;
    const observed = text(envelope.observed_through);
    const dated = observed ? ` · last ${observed}` : "";
    return `${id}: ${label}${dated}${check.reason ? ` — ${check.reason}` : ""}`;
  }

  /* The short label a chart or overlay prints beside a resource it still draws. */
  function badge(check) {
    if (!check || check.ok !== true) return "";
    const envelope = check.envelope || {};
    if (check.status === "current") return "";
    const observed = text(envelope.observed_through);
    if (check.status === "compatible") return `reused from build ${text(envelope.build_id)}`;
    const behind = check.status === "lagging" ? "1 session behind" : "more than 1 session behind";
    return `last ${observed} · ${behind}`;
  }

  return { SCHEMA_VERSION, KINDS, STATUSES, validate, describe, badge, manifestHash,
    manifestObserved, envelopeOf };
})();
if (typeof module !== "undefined" && module.exports) module.exports = Resources;
