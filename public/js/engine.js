// Motor bayesiano. Sin dependencias del navegador: se usa en la app y en los tests.

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const LR_MIN = 0.02, LR_MAX = 50;
const logit = p => Math.log(p / (1 - p));
const sigmoid = x => 1 / (1 + Math.exp(-x));
const entropy = p => (p <= 0 || p >= 1) ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));

/** Devuelve [LR+, LR−] desde sensibilidad/especificidad o desde LR explícitos. */
export function lrPair(link) {
  if (link.se != null) {
    const se = clamp(link.se, 0.01, 0.99), sp = clamp(link.sp, 0.01, 0.99);
    return [se / (1 - sp), (1 - se) / sp];
  }
  return [link.p, link.n];
}

const weightOf = (kb, level, shrink) => shrink ? (kb.evidenceWeights[level] ?? 1) : 1;

/** LR de un hallazgo respondido para un diagnóstico, o null si no aplica. */
export function itemLR(finding, dxId, answer) {
  if (finding.type === "choice") {
    const opt = finding.opts.find(o => o.v === answer);
    if (!opt || opt.lr[dxId] == null) return null;
    return { lr: opt.lr[dxId], l: finding.l, r: finding.r, label: opt.t };
  }
  const link = finding.links?.[dxId];
  if (!link) return null;
  const [p, n] = lrPair(link);
  return { lr: answer === "si" ? p : n, l: link.l, r: link.r, label: answer === "si" ? "Sí" : "No" };
}

/**
 * Calcula la probabilidad post-test de cada diagnóstico.
 * Hallazgos del mismo grupo se descuentan: 100 %, 50 %, 25 %…
 */
export function compute(kb, answers, { shrink = true } = {}) {
  const out = {};
  for (const d of kb.diagnoses) {
    let lg = logit(d.prior);
    const groups = {};
    for (const f of kb.findings) {
      const a = answers[f.id];
      if (a == null || a === "ns") continue;
      const it = itemLR(f, d.id, a);
      if (!it) continue;
      const lr = clamp(it.lr, LR_MIN, LR_MAX);
      const e = Math.log(lr) * weightOf(kb, it.l, shrink);
      const g = f.grp || f.id;
      (groups[g] ||= []).push({ f, lr, e, l: it.l, r: it.r, label: it.label });
    }
    const items = [];
    for (const g in groups) {
      groups[g].sort((a, b) => Math.abs(b.e) - Math.abs(a.e));
      groups[g].forEach((it, i) => { it.w = Math.pow(0.5, i); it.c = it.e * it.w; lg += it.c; items.push(it); });
    }
    out[d.id] = { post: clamp(sigmoid(lg), 0.001, 0.999), items: items.sort((a, b) => Math.abs(b.c) - Math.abs(a.c)) };
  }
  return out;
}

/** Ordena las preguntas sin responder por ganancia de información esperada / costo de acceso. */
export function suggestions(kb, answers, results, { shrink = true, limit = 5, segs = null } = {}) {
  const segOk = x => !segs || !x.seg || segs.includes(x.seg);
  const answeredGroups = new Set(kb.findings.filter(f => answers[f.id] && answers[f.id] !== "ns" && f.grp).map(f => f.grp));
  const list = [];
  for (const f of kb.findings) {
    if (answers[f.id] != null || !segOk(f)) continue;
    let score = 0, best = null, bestV = 0;
    for (const d of kb.diagnoses) {
      if (!segOk(d)) continue;
      const p = results[d.id].post;
      let ig = 0;
      if (f.type === "choice") {
        const k = f.opts.length, w = weightOf(kb, f.l, shrink);
        const lrs = f.opts.map(o => Math.exp(Math.log(clamp(o.lr[d.id] ?? 1, LR_MIN, LR_MAX)) * w));
        if (lrs.every(x => Math.abs(x - 1) < 1e-6)) continue;
        const sum = lrs.reduce((a, b) => a + b, 0);
        let expected = 0;
        for (const x of lrs) { const pd = x / sum, po = p * pd + (1 - p) / k; expected += po * entropy(p * pd / po); }
        ig = entropy(p) - expected;
      } else {
        const link = f.links?.[d.id];
        if (!link) continue;
        let [lp, ln] = lrPair(link);
        const w = weightOf(kb, link.l, shrink);
        lp = Math.exp(Math.log(clamp(lp, LR_MIN, LR_MAX)) * w);
        ln = Math.exp(Math.log(clamp(ln, LR_MIN, LR_MAX)) * w);
        if (Math.abs(lp - ln) < 1e-3) continue;
        const spec = clamp((lp - 1) / (lp - ln), 0, 1), sens = clamp(lp * (1 - spec), 0, 1);
        const pp = p * sens + (1 - p) * (1 - spec);
        if (pp <= 0 || pp >= 1) continue;
        ig = entropy(p) - (pp * entropy(p * sens / pp) + (1 - pp) * entropy(p * (1 - sens) / (1 - pp)));
      }
      if (f.grp && answeredGroups.has(f.grp)) ig *= 0.5;
      const v = ig * (0.5 + p);
      score += v;
      if (v > bestV) { bestV = v; best = d; }
    }
    score /= kb.accessCost[f.who] ?? 1;
    if (score > 0.003) list.push({ f, score, best });
  }
  return list.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Diagnósticos del mismo segmento que `dxId` (o todos, si la base no tiene segmentos). */
export const sameSegment = (kb, dxId) => {
  const seg = kb.diagnoses.find(d => d.id === dxId)?.seg;
  return seg ? kb.diagnoses.filter(d => d.seg === seg) : kb.diagnoses;
};

/** Métricas de validación sobre casos guardados con diagnóstico confirmado.
 *  El ranking top-1/top-3 se calcula dentro del segmento del diagnóstico confirmado. */
export function caseMetrics(kb, cases, opts = {}) {
  const known = new Set(kb.diagnoses.map(d => d.id));
  const scored = cases.filter(c => known.has(c.confirmed)).map(c => {
    const R = compute(kb, c.answers, opts);
    const ranking = [...sameSegment(kb, c.confirmed)].sort((a, b) => R[b.id].post - R[a.id].post).map(d => d.id);
    const p = R[c.confirmed]?.post ?? 0;
    return { id: c.id, top1: ranking[0] === c.confirmed, top3: ranking.slice(0, 3).includes(c.confirmed), p, brier: (1 - p) ** 2, ranking };
  });
  const n = scored.length;
  const avg = k => n ? scored.reduce((a, s) => a + (typeof s[k] === "boolean" ? +s[k] : s[k]), 0) / n : null;
  return { n, top1: avg("top1"), top3: avg("top3"), brier: avg("brier"), meanP: avg("p"), scored };
}
