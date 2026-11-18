import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compute, suggestions, lrPair, caseMetrics, sameSegment } from "../public/js/engine.js";

const KB = JSON.parse(readFileSync(new URL("../public/data/knowledge.json", import.meta.url)));
const rank = R => Object.entries(R).sort((a, b) => b[1].post - a[1].post).map(([id]) => id);
const segOf = id => KB.diagnoses.find(d => d.id === id).seg;
const rankSeg = (R, seg) => rank(R).filter(id => segOf(id) === seg);

test("la base de conocimiento es coherente", () => {
  const dx = new Set(KB.diagnoses.map(d => d.id));
  const ids = new Set();
  for (const f of KB.findings) {
    assert.ok(!ids.has(f.id), `id duplicado: ${f.id}`); ids.add(f.id);
    assert.ok(KB.stages.some(s => s.id === f.st), `etapa desconocida en ${f.id}`);
    const links = f.type === "choice" ? f.opts.flatMap(o => Object.keys(o.lr)) : Object.keys(f.links);
    for (const d of links) assert.ok(dx.has(d), `${f.id} apunta a un diagnóstico inexistente: ${d}`);
    const refs = f.type === "choice" ? [f.r] : Object.values(f.links).map(k => k.r);
    for (const r of refs) assert.ok(KB.references[r], `${f.id} cita una referencia inexistente: ${r}`);
  }
  for (const d of KB.diagnoses) assert.ok(d.prior > 0 && d.prior < 1, `pre-test fuera de rango: ${d.id}`);
});

test("sin respuestas, la probabilidad es el pre-test", () => {
  const R = compute(KB, {});
  for (const d of KB.diagnoses) assert.ok(Math.abs(R[d.id].post - d.prior) < 1e-9);
});

test("LR desde sensibilidad y especificidad", () => {
  const [p, n] = lrPair({ se: 0.67, sp: 0.95 });
  assert.ok(Math.abs(p - 13.4) < 0.01);
  assert.ok(Math.abs(n - 0.347) < 0.01);
});

test("caso de túnel carpiano: queda primero y sobre 80 %", () => {
  const R = compute(KB, KB.presets.ex1);
  assert.equal(rankSeg(R, "mano")[0], "cts");
  assert.ok(R.cts.post > 0.8);
});

test("caída con dolor en tabaquera: escafoides primero", () => {
  const R = compute(KB, KB.presets.ex2);
  assert.equal(rankSeg(R, "mano")[0], "esc");
});

test("dolor del lado del pulgar en posparto: De Quervain primero", () => {
  assert.equal(rankSeg(compute(KB, KB.presets.ex3), "mano")[0], "dq");
});

test("hallazgos del mismo grupo se descuentan", () => {
  const solo = compute(KB, { a_flick: "si" }).cts.post;
  const ambos = compute(KB, { a_flick: "si", e_hypal: "si" }).cts.post;
  const sinGrupo = 1 / (1 + (1 / solo - 1) / Math.pow(3.1, 1)); // si se sumara completo
  assert.ok(ambos > solo && ambos < sinGrupo);
});

test("las sugerencias no repiten preguntas respondidas", () => {
  const ans = KB.presets.ex1;
  const s = suggestions(KB, ans, compute(KB, ans));
  assert.ok(s.length > 0);
  for (const x of s) assert.equal(ans[x.f.id], undefined);
});

test("métricas de casos", () => {
  const cases = [
    { id: "a", answers: KB.presets.ex1, confirmed: "cts" },
    { id: "b", answers: KB.presets.ex2, confirmed: "rad" },
    { id: "c", answers: {}, confirmed: "pendiente" }
  ];
  const m = caseMetrics(KB, cases);
  assert.equal(m.n, 2);
  assert.equal(m.top1, 0.5);
});

/* ---------- Segmento codo-antebrazo ---------- */
test("cada diagnóstico y hallazgo con segmento usa un segmento existente", () => {
  const segs = new Set(KB.segments.map(s => s.id));
  for (const d of KB.diagnoses) assert.ok(segs.has(d.seg), `segmento inválido en ${d.id}`);
  for (const f of [...KB.findings, ...KB.redFlags]) if (f.seg) assert.ok(segs.has(f.seg), `segmento inválido en ${f.id}`);
  for (const [k, v] of Object.entries(KB.presets)) for (const id of Object.keys(v))
    assert.ok(KB.findings.some(f => f.id === id) || KB.redFlags.some(r => r.id === id), `preset ${k} usa hallazgo inexistente ${id}`);
});

test("un hallazgo de un segmento solo cambia diagnósticos de ese segmento", () => {
  for (const f of KB.findings.filter(f => f.seg)) {
    const links = f.type === "choice" ? f.opts.flatMap(o => Object.keys(o.lr)) : Object.keys(f.links);
    for (const d of links) assert.equal(segOf(d), f.seg, `${f.id} (${f.seg}) apunta a ${d} (${segOf(d)})`);
  }
});

test("codo: dolor lateral al agarrar → epicondilalgia lateral primero y sobre 70 %", () => {
  const R = compute(KB, KB.presets.ex4);
  assert.equal(rankSeg(R, "codo")[0], "epl");
  assert.ok(R.epl.post > 0.7);
});

test("codo: hormigueo en el meñique → neuropatía cubital primero", () => {
  assert.equal(rankSeg(compute(KB, KB.presets.ex5), "codo")[0], "cub");
});

test("codo: chasquido + hook test → rotura del bíceps distal primero", () => {
  assert.equal(rankSeg(compute(KB, KB.presets.ex6), "codo")[0], "bic");
});

test("codo: caída sin extensión completa → fractura de cabeza radial primero", () => {
  assert.equal(rankSeg(compute(KB, KB.presets.ex8), "codo")[0], "rh");
});

test("ambos segmentos a la vez: túnel carpiano y epicondilalgia lateral lideran cada uno", () => {
  const R = compute(KB, KB.presets.ex7);
  assert.equal(rankSeg(R, "mano")[0], "cts");
  assert.equal(rankSeg(R, "codo")[0], "epl");
});

test("responder solo preguntas de codo no cambia los diagnósticos de mano", () => {
  const R = compute(KB, KB.presets.ex6);
  for (const d of KB.diagnoses.filter(d => d.seg === "mano"))
    if (!Object.keys(KB.presets.ex6).some(id => KB.findings.find(f => f.id === id && !f.seg)))
      assert.ok(Math.abs(R[d.id].post - d.prior) < 1e-9);
  const R2 = compute(KB, { a_pop: "si", e_hook: "si" });
  for (const d of KB.diagnoses.filter(d => d.seg === "mano")) assert.ok(Math.abs(R2[d.id].post - d.prior) < 1e-9);
});

test("sugerencias filtradas por segmento", () => {
  const s = suggestions(KB, {}, compute(KB, {}), { segs: ["codo"], limit: 20 });
  assert.ok(s.length > 0);
  for (const x of s) assert.ok(!x.f.seg || x.f.seg === "codo", `${x.f.id} no es de codo`);
});

test("métricas: el top-1 se mide dentro del segmento confirmado", () => {
  assert.equal(sameSegment(KB, "epl").every(d => d.seg === "codo"), true);
  const m = caseMetrics(KB, [
    { id: "x", answers: KB.presets.ex7, confirmed: "cts" },
    { id: "y", answers: KB.presets.ex7, confirmed: "epl" }
  ]);
  assert.equal(m.n, 2);
  assert.equal(m.top1, 1);
});
