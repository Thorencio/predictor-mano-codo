import { compute, suggestions, lrPair, caseMetrics, sameSegment } from "./engine.js";

/* ---------- estado ---------- */
const STORE_KEY = "predictor-mano:review-v1";
const SETTINGS_KEY = "predictor-mano:settings-v1";
let KB, byId, ANS = {}, stage = "anam", selDx = null, shrinkOn = true, reviewOn = false;
let openForm = null;            // id del hallazgo con el formulario de comentario abierto
let saveOpen = false;           // formulario "guardar caso" abierto
let pendingDelete = null;       // id de caso a confirmar eliminación
let segView = "todos";          // "todos" | "mano" | "codo"

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { toast("No se pudo guardar en este navegador"); } };
let REV = load(STORE_KEY, { comments: [], missing: [], cases: [] });
const persist = () => save(STORE_KEY, REV);
const settings = load(SETTINGS_KEY, {});
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- utilidades ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = p => (p == null ? "—" : (p * 100 < 1 ? "<1" : Math.round(p * 100)) + " %");
const fmt = x => x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(2);
const dxName = id => KB.diagnoses.find(d => d.id === id)?.name ?? (id === "otro" ? "Otro diagnóstico" : id === "pendiente" ? "Sin confirmar" : id);
const stageName = id => KB.stages.find(s => s.id === id)?.name ?? id;
const color = p => p >= .7 ? "var(--accent)" : p >= .3 ? "var(--amber)" : "var(--muted)";
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 2600); }
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const reviewer = () => ($("#reviewer").value || "").trim() || "Sin nombre";
const SEGS = () => KB.segments ?? [];
const segName = id => SEGS().find(s => s.id === id)?.name ?? id;
const activeSegs = () => segView === "todos" ? SEGS().map(s => s.id) : [segView];
const visible = x => !x.seg || activeSegs().includes(x.seg);
const dxSeg = id => KB.diagnoses.find(d => d.id === id)?.seg;
/** Mejor diagnóstico de cada segmento: [{seg, d, p}] */
const topBySeg = (R, segs = SEGS().map(s => s.id)) => segs.map(seg => {
  const d = KB.diagnoses.filter(x => x.seg === seg).sort((a, b) => R[b.id].post - R[a.id].post)[0];
  return { seg, d, p: R[d.id].post };
});
/** Top-1 en el segmento del diagnóstico confirmado (o el más probable en general si no hay confirmado). */
const topFor = (R, confirmed) => {
  const pool = dxSeg(confirmed) ? sameSegment(KB, confirmed) : KB.diagnoses;
  return [...pool].sort((a, b) => R[b.id].post - R[a.id].post)[0];
};
function dxOptions(selected) {
  return SEGS().map(s => `<optgroup label="${esc(s.name)}">${KB.diagnoses.filter(d => d.seg === s.id).map(d => `<option value="${d.id}"${d.id === selected ? " selected" : ""}>${esc(d.name)}</option>`).join("")}</optgroup>`).join("");
}

/* ---------- vistas ---------- */
const VIEWS = ["evaluar", "casos", "evidencia"];
function route() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "evaluar";
  VIEWS.forEach(x => { $("#view-" + x).hidden = x !== v; });
  document.querySelectorAll(".nav a").forEach(a => a.dataset.view === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
  if (v === "casos") renderCases();
  if (v === "evidencia") renderEvidence();
}

/* ---------- EVALUAR ---------- */
function renderTabs() {
  $("#tabs").innerHTML = KB.stages.map(s => {
    const qs = (s.id === "red" ? KB.redFlags : KB.findings.filter(f => f.st === s.id)).filter(visible);
    const n = qs.filter(q => ANS[q.id] != null).length;
    return `<button class="tab${s.id === "red" ? " red" : ""}" role="tab" aria-selected="${s.id === stage}" data-st="${s.id}">${esc(s.name)}<span class="n">${n}/${qs.length}</span></button>`;
  }).join("");
  $("#stageIntro").textContent = KB.stages.find(s => s.id === stage).intro;
  document.querySelectorAll("[data-segview]").forEach(b => b.setAttribute("aria-pressed", b.dataset.segview === segView));
}

function evLine(f) {
  if (f.type === "choice") return `<span>Evidencia <span class="lvl ${f.l}">${f.l}</span> · ${esc(f.r)}</span>`;
  const e = Object.entries(f.links);
  return e.slice(0, 3).map(([dx, k]) => {
    const [p, n] = lrPair(k);
    return `<span>${esc(dxName(dx))}: LR+ <b>${fmt(p)}</b> · LR− <b>${fmt(n)}</b> <span class="lvl ${k.l}">${k.l}</span></span>`;
  }).join("") + (e.length > 3 ? `<span>+${e.length - 3} más</span>` : "");
}

const commentsFor = (type, id) => REV.comments.filter(c => c.target.type === type && c.target.id === id);

function commentBlock(type, id, f) {
  const list = commentsFor(type, id);
  const listHtml = list.length ? `<div class="clist">${list.map(c => `<div class="c">${esc(c.text)}${c.proposed ? `<div class="meta">Propone: ${esc(c.proposed)}</div>` : ""}<div class="meta">${esc(c.reviewer)} · ${esc(c.date)} · base ${esc(c.kbVersion)}</div></div>`).join("")}</div>` : "";
  const key = type + ":" + id;
  if (openForm !== key) return `${listHtml}<div class="qtools"><button class="btn sm" data-comment="${key}">Comentar o proponer valores</button><span class="idtag">${esc(id)}</span>${list.length ? `<span class="cbadge">${list.length} comentario${list.length > 1 ? "s" : ""}</span>` : ""}</div>`;
  const dxOpts = f && f.links ? Object.keys(f.links) : f && f.opts ? [...new Set(f.opts.flatMap(o => Object.keys(o.lr)))] : [id];
  return `${listHtml}<form class="form" data-form="${key}">
    <label>Comentario<textarea name="text" required placeholder="¿Está bien redactado? ¿El valor coincide con la literatura? ¿Falta algo?"></textarea></label>
    ${type === "finding" ? `<div class="row">
      <label>Diagnóstico<select name="dx"><option value="">General (sin valor)</option>${dxOpts.map(d => `<option value="${d}">${esc(dxName(d))}</option>`).join("")}</select></label>
      <label>Sensibilidad<input type="text" name="se" inputmode="decimal" placeholder="0,85"></label>
      <label>Especificidad<input type="text" name="sp" inputmode="decimal" placeholder="0,90"></label>
      <label>o LR+ / LR−<input type="text" name="lr" placeholder="4,2 / 0,3"></label></div>
      <label>Fuente (DOI o PubMed)<input type="text" name="src" placeholder="https://pubmed.ncbi.nlm.nih.gov/…"></label>`
      : `<div class="row"><label>Pre-test propuesto (%)<input type="text" name="prior" inputmode="decimal" placeholder="12"></label><label>Fuente<input type="text" name="src"></label></div>`}
    <div class="actions"><button class="btn primary" type="submit">Guardar comentario</button><button class="btn" type="button" data-cancel>Cancelar</button></div></form>`;
}

let lastSeg;
function segHead(x) {
  const seg = x.seg || "general";
  if (seg === lastSeg) return "";
  lastSeg = seg;
  return `<div class="qseg ${seg}">${seg === "general" ? "General" : esc(segName(seg))}</div>`;
}

function renderQs() {
  lastSeg = undefined;
  if (stage === "red") {
    $("#qlist").innerHTML = KB.redFlags.filter(visible).map(r => {
      const a = ANS[r.id];
      return segHead(r) + `<div class="q redq${a ? " answered" : ""}" id="q-${r.id}"><div class="qhead"><div class="qtext">${esc(r.q)}</div></div>
      <div class="seg">${["si", "no"].map(v => `<button class="${v === "si" ? "yes" : ""}" aria-pressed="${a === v}" data-q="${r.id}" data-v="${v}">${v === "si" ? "Sí" : "No"}</button>`).join("")}</div>
      ${reviewOn ? commentBlock("finding", r.id, null) : ""}</div>`;
    }).join("");
    return;
  }
  $("#qlist").innerHTML = KB.findings.filter(f => f.st === stage && visible(f)).map(f => {
    const a = ANS[f.id];
    const opts = f.type === "choice" ? f.opts.map(o => [o.v, o.t]) : [["si", "Sí"], ["no", "No"]];
    opts.push(["ns", "No sé"]);
    return segHead(f) + `<div class="q${a && a !== "ns" ? " answered" : ""}" id="q-${f.id}">
      <div class="qhead"><div class="qtext">${esc(f.q)}</div><span class="chip ${f.who}">${esc(KB.whoLabels[f.who])}</span></div>
      ${f.help ? `<p class="help">${esc(f.help)}</p>` : ""}
      <div class="seg">${opts.map(([v, t]) => `<button class="${v === "ns" ? "ns" : ""}" aria-pressed="${a === v}" data-q="${f.id}" data-v="${v}">${esc(t)}</button>`).join("")}</div>
      <div class="ev">${evLine(f)}</div>
      ${reviewOn ? commentBlock("finding", f.id, f) : ""}</div>`;
  }).join("");
}

function renderResults() {
  const R = compute(KB, ANS, { shrink: shrinkOn });
  const sorted = [...KB.diagnoses].sort((a, b) => R[b.id].post - R[a.id].post);
  const vis = sorted.filter(visible);
  if (!selDx || !R[selDx] || !visible(KB.diagnoses.find(d => d.id === selDx))) selDx = vis[0].id;
  $("#nAns").textContent = KB.findings.filter(f => ANS[f.id] && ANS[f.id] !== "ns").length + " hallazgos";
  const box = $("#dxlist");
  if (!box.children.length) {
    box.innerHTML = SEGS().map(s => `<div class="segblock ${s.id}" data-segblock="${s.id}"><div class="segtitle">${esc(s.name)}</div><p class="segnote" hidden>Sin respuestas específicas de este segmento: las cifras solo reflejan el pre-test y los datos generales (edad, sexo, uso repetitivo…).</p><div class="segrows">` +
      KB.diagnoses.filter(d => d.seg === s.id).map(d => `<button class="dxrow" data-dx="${d.id}"><span class="dxname">${esc(d.name)}</span><span class="dxpct"></span><span class="bar"><span class="fill"></span><span class="prior" style="left:${d.prior * 100}%"></span></span></button>`).join("") +
      `</div></div>`).join("");
  }
  box.querySelectorAll("[data-segblock]").forEach(b => {
    const seg = b.dataset.segblock;
    b.hidden = !activeSegs().includes(seg);
    const has = [...KB.findings, ...KB.redFlags].some(f => f.seg === seg && ANS[f.id] && ANS[f.id] !== "ns");
    b.classList.toggle("nodata", !has);
    b.querySelector(".segnote").hidden = has;
  });
  for (const d of sorted) {
    const row = box.querySelector(`[data-dx="${d.id}"]`); row.parentElement.appendChild(row);
    const p = R[d.id].post;
    row.classList.toggle("sel", d.id === selDx);
    row.querySelector(".dxpct").textContent = pct(p);
    const fill = row.querySelector(".fill"); fill.style.width = (p * 100) + "%"; fill.style.backgroundColor = color(p);
    row.setAttribute("aria-label", `${d.name}: ${pct(p)}, pre-test ${pct(d.prior)}`);
  }
  renderWhy(R); renderSugg(R); renderAlarm(); renderSave(R, sorted);
}

function renderWhy(R) {
  const d = KB.diagnoses.find(x => x.id === selDx), r = R[d.id];
  const band = r.post >= .7 ? "Probabilidad alta" : r.post >= .3 ? "Posible" : r.post >= .1 ? "Poco probable" : "Muy poco probable";
  const rows = r.items.map(it => {
    const eff = Math.exp(it.c), up = it.c > 0;
    const note = it.w < 1 ? ` <span class="help">(relacionado, cuenta ${Math.round(it.w * 100)} %)</span>` : "";
    return `<tr><td>${esc(it.f.q)} <b>· ${esc(it.label)}</b>${note}</td><td class="lr ${up ? "up" : "down"}">${up ? "×" : "÷"}${fmt(up ? eff : 1 / eff)}</td></tr>`;
  }).join("");
  $("#why").innerHTML = `<div class="eyebrow">Por qué</div><h2>${esc(d.name)}</h2>
    <div class="sum">Pre-test <span class="mono">${pct(d.prior)}</span> → post-test <b class="mono">${pct(r.post)}</b> · ${band}</div>
    ${rows ? `<table>${rows}</table>` : `<p class="empty">Aún no hay hallazgos que cambien este diagnóstico.</p>`}
    <div class="next"><b>Cómo se confirma:</b> ${esc(d.next)}</div>
    ${reviewOn ? commentBlock("dx", d.id, null) : ""}`;
}

function renderSugg(R) {
  const s = suggestions(KB, ANS, R, { shrink: shrinkOn, segs: activeSegs() });
  if (!s.length) { $("#sugg").innerHTML = `<p class="empty">No quedan evaluaciones que cambien mucho las probabilidades.</p>`; return; }
  const max = s[0].score;
  $("#sugg").innerHTML = s.map(x => `<div class="sitem"><div style="min-width:0"><div class="t">${esc(x.f.q)}</div>
    <div class="s">${x.f.seg ? esc(segName(x.f.seg)) + " · " : ""}${esc(stageName(x.f.st))} · ${esc(KB.whoLabels[x.f.who])}${x.best ? ` · aclara sobre todo: ${esc(x.best.name)}` : ""}</div></div>
    <button class="btn" data-go="${x.f.id}">Responder</button>
    <div class="gain" aria-hidden="true"><span style="width:${Math.max(6, x.score / max * 100)}%"></span></div></div>`).join("");
}

function renderAlarm() {
  const hits = KB.redFlags.filter(r => ANS[r.id] === "si");
  const el = $("#alarm"); el.hidden = !hits.length;
  if (hits.length) el.innerHTML = `<h2>Consulta de urgencia</h2><p>Una o más señales de alarma son positivas. Acude hoy a un servicio de urgencia o llama al SAMU 131.</p><ul>${hits.map(h => `<li>${esc(h.msg)}</li>`).join("")}</ul>`;
}

function renderSave(R, sorted) {
  const el = $("#savePanel");
  const n = Object.keys(ANS).length;
  if (!saveOpen) {
    el.innerHTML = `<h2 style="margin-bottom:4px">Validación</h2><p class="help" style="margin-bottom:8px">Guarda estas respuestas como caso, con el diagnóstico que se confirmó, para medir el desempeño del modelo.</p>
      <button class="btn primary" data-action="open-save" ${n ? "" : "disabled"}>Guardar como caso</button>`;
    return;
  }
  el.innerHTML = `<h2 style="margin-bottom:8px">Guardar caso</h2><form class="form" id="saveForm">
    <label>Diagnóstico confirmado<select name="confirmed" required>
      <option value="pendiente">Aún sin confirmar</option>
      ${dxOptions()}
      <option value="otro">Otro diagnóstico (no está en la lista)</option></select></label>
    <div class="row"><label>Cómo se confirmó<select name="method"><option>Imagen</option><option>Electrodiagnóstico</option><option>Cirugía o artroscopía</option><option>Evolución clínica</option><option>Laboratorio</option><option>Caso ficticio docente</option></select></label>
    <label>Tipo<select name="kind"><option value="real">Real anonimizado</option><option value="ficticio">Ficticio</option></select></label></div>
    <label>Otro diagnóstico o notas<textarea name="notes" placeholder="Sin datos que identifiquen al paciente"></textarea></label>
    <p class="help">Predicción actual: ${topBySeg(R, activeSegs()).map(t => `${esc(segName(t.seg))}: ${esc(t.d.name)} ${pct(t.p)}`).join(" · ")}. Si hay un diagnóstico confirmado en cada segmento, guarda dos casos.</p>
    <div class="actions"><button class="btn primary" type="submit">Guardar caso</button><button class="btn" type="button" data-action="close-save">Cancelar</button></div></form>`;
}

function rerender() { renderTabs(); renderQs(); renderResults(); }

/* ---------- CASOS ---------- */
function renderCases() {
  const m = caseMetrics(KB, REV.cases, { shrink: shrinkOn });
  const conf = REV.cases.filter(c => c.confirmed && c.confirmed !== "pendiente").length;
  $("#tiles").innerHTML = [
    [REV.cases.length, "casos guardados"],
    [m.n, "con diagnóstico de la lista"],
    [m.n ? Math.round(m.top1 * 100) + " %" : "—", "acierto top-1"],
    [m.n ? Math.round(m.top3 * 100) + " %" : "—", "acierto top-3"],
    [m.n ? pct(m.meanP) : "—", "prob. media del dx confirmado"],
    [m.n ? m.brier.toFixed(3) : "—", "Brier (0 = perfecto)"]
  ].map(([v, k]) => `<div class="tile"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");

  const scoredById = Object.fromEntries(m.scored.map(s => [s.id, s]));
  if (!REV.cases.length) {
    $("#casesTable").innerHTML = `<tbody><tr><td class="empty">Todavía no hay casos. En Evaluar, responde un caso y usa «Guardar como caso». También puedes importar el archivo JSON de un colega.</td></tr></tbody>`;
  } else {
    $("#casesTable").innerHTML = `<thead><tr><th>Fecha</th><th>Revisor/a</th><th>Confirmado</th><th>Predicción top-1 (mismo segmento)</th><th style="text-align:right">P(dx confirmado)</th><th>Resultado</th><th>Tipo</th><th></th></tr></thead><tbody>` +
      [...REV.cases].reverse().map(c => {
        const R = compute(KB, c.answers, { shrink: shrinkOn });
        const top = topFor(R, c.confirmed);
        const s = scoredById[c.id];
        const res = !s ? `<span class="help">—</span>` : s.top1 ? `<span class="hit">Top-1</span>` : s.top3 ? `<span class="hit">Top-3</span>` : `<span class="miss">Fallo</span>`;
        const del = pendingDelete === c.id ? `<button class="btn sm danger" data-del-confirm="${c.id}">Confirmar</button> <button class="btn sm" data-del-cancel>No</button>` : `<button class="btn sm danger" data-del="${c.id}">Eliminar</button>`;
        return `<tr><td class="n" style="text-align:left">${esc(c.date)}</td><td>${esc(c.reviewer)}</td><td>${esc(dxName(c.confirmed))}${c.notes ? `<br><span class="help">${esc(c.notes)}</span>` : ""}</td>
          <td>${esc(top.name)} <span class="mono">${pct(R[top.id].post)}</span></td><td class="n">${s ? pct(s.p) : "—"}</td><td>${res}</td><td>${esc(c.kind)} · ${esc(c.method)}</td>
          <td style="white-space:nowrap"><button class="btn sm" data-loadcase="${c.id}">Abrir</button> ${del}</td></tr>`;
      }).join("") + "</tbody>";
  }

  $("#dxPerf").innerHTML = `<thead><tr><th>Diagnóstico</th><th style="text-align:right">Casos confirmados</th><th style="text-align:right">Top-1</th><th style="text-align:right">Top-3</th><th style="text-align:right">P media</th></tr></thead><tbody>` +
    KB.diagnoses.map((d, i) => {
      const head = i === 0 || KB.diagnoses[i - 1].seg !== d.seg ? `<tr class="dxh"><td colspan="5">${esc(segName(d.seg))}</td></tr>` : "";
      const ss = m.scored.filter(s => REV.cases.find(c => c.id === s.id)?.confirmed === d.id);
      const n = ss.length, avg = k => n ? ss.reduce((a, s) => a + (+s[k]), 0) / n : null;
      return head + `<tr><td>${esc(d.name)}</td><td class="n">${n}</td><td class="n">${n ? Math.round(avg("top1") * 100) + " %" : "—"}</td><td class="n">${n ? Math.round(avg("top3") * 100) + " %" : "—"}</td><td class="n">${n ? pct(avg("p")) : "—"}</td></tr>`;
    }).join("") + `</tbody>`;
  if (conf === 0 && REV.cases.length) $("#dxPerf").insertAdjacentHTML("beforeend", `<tbody><tr><td colspan="5" class="empty">Ningún caso tiene diagnóstico confirmado todavía.</td></tr></tbody>`);
}

function casesCSV() {
  const fids = KB.findings.map(f => f.id).concat(KB.redFlags.map(r => r.id));
  const head = ["id", "fecha", "revisor", "tipo", "metodo", "confirmado", "notas", "kb_version", "top1_pred", "p_top1", "p_confirmado", ...KB.diagnoses.map(d => "p_" + d.id), ...fids];
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = REV.cases.map(c => {
    const R = compute(KB, c.answers, { shrink: shrinkOn });
    const top = topFor(R, c.confirmed);
    return [c.id, c.date, c.reviewer, c.kind, c.method, c.confirmed, c.notes, c.kbVersion, top.id, R[top.id].post.toFixed(3), R[c.confirmed]?.post.toFixed(3) ?? "",
      ...KB.diagnoses.map(d => R[d.id].post.toFixed(3)), ...fids.map(id => c.answers[id] ?? "")].map(q).join(",");
  });
  return "﻿" + [head.map(q).join(","), ...rows].join("\n");
}

/* ---------- EVIDENCIA ---------- */
function renderEvidence() {
  let html = `<thead><tr><th>Hallazgo</th><th>Etapa</th><th style="text-align:right">Sens.</th><th style="text-align:right">Espec.</th><th style="text-align:right">LR+</th><th style="text-align:right">LR−</th><th>Nivel</th><th>Fuente</th><th style="text-align:right">Coment.</th></tr></thead><tbody>`;
  let prevSeg;
  for (const d of KB.diagnoses) {
    if (d.seg !== prevSeg) { prevSeg = d.seg; html += `<tr class="segh"><td colspan="9">${esc(segName(d.seg))}</td></tr>`; }
    const dc = commentsFor("dx", d.id).length;
    html += `<tr class="dxh"><td colspan="9">${esc(d.name)} · pre-test ${pct(d.prior)}${dc ? ` · ${dc} comentario${dc > 1 ? "s" : ""}` : ""}</td></tr>`;
    for (const f of KB.findings) {
      const nc = commentsFor("finding", f.id).length || "";
      if (f.type === "choice") {
        if (!f.opts.some(o => o.lr[d.id] != null && o.lr[d.id] !== 1)) continue;
        html += `<tr><td>${esc(f.q)}<br><span class="help">${f.opts.filter(o => o.lr[d.id] != null).map(o => esc(o.t) + ": LR " + fmt(o.lr[d.id])).join(" · ")}</span></td><td>${esc(stageName(f.st))}</td><td class="n">—</td><td class="n">—</td><td class="n">—</td><td class="n">—</td><td><span class="lvl ${f.l}">${f.l}</span></td><td>${esc(f.r)}</td><td class="n">${nc}</td></tr>`;
        continue;
      }
      const k = f.links[d.id]; if (!k) continue; const [p, n] = lrPair(k);
      html += `<tr><td>${esc(f.q)}</td><td>${esc(stageName(f.st))}</td><td class="n">${k.se != null ? Math.round(k.se * 100) + " %" : "—"}</td><td class="n">${k.sp != null ? Math.round(k.sp * 1000) / 10 + " %" : "—"}</td><td class="n">${fmt(p)}</td><td class="n">${fmt(n)}</td><td><span class="lvl ${k.l}">${k.l}</span></td><td>${esc(k.r)}</td><td class="n">${nc}</td></tr>`;
    }
  }
  $("#evTable").innerHTML = html + "</tbody>";
  $("#refs").innerHTML = Object.entries(KB.references).map(([k, r]) => `<li><b class="mono">${esc(k)}</b> · ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}</li>`).join("");

  const label = c => c.target.type === "dx" ? "Diagnóstico · " + dxName(c.target.id) : (byId[c.target.id]?.q ?? KB.redFlags.find(r => r.id === c.target.id)?.q ?? c.target.id);
  $("#reviewSummary").innerHTML = REV.comments.length ? [...REV.comments].reverse().map(c => `<div class="c"><b>${esc(label(c))}</b><div>${esc(c.text)}</div>${c.proposed ? `<div class="meta">Propone: ${esc(c.proposed)}</div>` : ""}<div class="meta">${esc(c.reviewer)} · ${esc(c.date)} · base ${esc(c.kbVersion)} <button class="btn sm danger" data-delcomment="${c.id}">Quitar</button></div></div>`).join("")
    : `<p class="empty">Aún no hay comentarios. Activa «Modo revisión» y comenta desde cada pregunta o diagnóstico.</p>`;

  $("#missingForm").innerHTML = `<form class="form" id="missForm">
    <label>Pregunta o prueba<input type="text" name="q" required placeholder="Ej.: Test de compresión del nervio cubital en el canal de Guyon"></label>
    <div class="row"><label>Etapa<select name="st">${KB.stages.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></label>
    <label>Diagnóstico<select name="dx">${dxOptions()}<option value="nuevo">Diagnóstico nuevo</option></select></label></div>
    <div class="row"><label>Sens.<input type="text" name="se" placeholder="0,80"></label><label>Espec.<input type="text" name="sp" placeholder="0,90"></label><label>o LR+ / LR−<input type="text" name="lr"></label></div>
    <label>Fuente (DOI o PubMed)<input type="text" name="src"></label>
    <label>Notas<textarea name="notes" placeholder="Si es un diagnóstico nuevo, escribe su nombre aquí"></textarea></label>
    <div class="actions"><button class="btn primary" type="submit">Agregar propuesta</button></div></form>`;
  $("#missingList").innerHTML = REV.missing.map(m => `<div class="c"><b>${esc(m.q)}</b> <span class="help">· ${esc(stageName(m.st))} · ${esc(dxName(m.dx))}</span>${m.values ? `<div class="meta">${esc(m.values)}</div>` : ""}${m.notes ? `<div>${esc(m.notes)}</div>` : ""}<div class="meta">${esc(m.reviewer)} · ${esc(m.date)} <button class="btn sm danger" data-delmissing="${m.id}">Quitar</button></div></div>`).join("");
}

/* ---------- eventos ---------- */
function proposedText(fd) {
  const parts = [];
  if (fd.get("dx") && (fd.get("se") || fd.get("sp") || fd.get("lr"))) parts.push(dxName(fd.get("dx")));
  if (fd.get("se")) parts.push("sens " + fd.get("se"));
  if (fd.get("sp")) parts.push("espec " + fd.get("sp"));
  if (fd.get("lr")) parts.push("LR " + fd.get("lr"));
  if (fd.get("prior")) parts.push("pre-test " + fd.get("prior") + " %");
  if (fd.get("src")) parts.push("fuente: " + fd.get("src"));
  return parts.join(" · ");
}

document.addEventListener("click", e => {
  const t = e.target;
  const sv = t.closest("[data-segview]");
  if (sv) { segView = sv.dataset.segview; settings.seg = segView; save(SETTINGS_KEY, settings); rerender(); return; }
  const st = t.closest("[data-st]"); if (st) { stage = st.dataset.st; openForm = null; renderTabs(); renderQs(); return; }
  const b = t.closest("[data-q]");
  if (b) {
    const q = b.dataset.q, v = b.dataset.v;
    if (ANS[q] === v) delete ANS[q]; else ANS[q] = v;
    rerender(); document.getElementById("q-" + q)?.querySelector(`[data-v="${v}"]`)?.focus({ preventScroll: true }); return;
  }
  const r = t.closest("[data-dx]"); if (r) { selDx = r.dataset.dx; renderResults(); return; }
  const g = t.closest("[data-go]");
  if (g) {
    const f = byId[g.dataset.go]; stage = f.st; if (!visible(f)) segView = "todos"; renderTabs(); renderQs();
    const el = document.getElementById("q-" + f.id);
    if (el) { el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600); }
    return;
  }
  const cm = t.closest("[data-comment]"); if (cm) { openForm = cm.dataset.comment; cm.dataset.comment.startsWith("dx:") ? renderResults() : renderQs(); return; }
  if (t.closest("[data-cancel]")) { const wasDx = openForm?.startsWith("dx:"); openForm = null; wasDx ? renderResults() : renderQs(); return; }
  const lc = t.closest("[data-loadcase]");
  if (lc) { const c = REV.cases.find(x => x.id === lc.dataset.loadcase); ANS = { ...c.answers }; selDx = c.confirmed in Object.fromEntries(KB.diagnoses.map(d => [d.id, 1])) ? c.confirmed : null; location.hash = "evaluar"; rerender(); toast("Caso cargado"); return; }
  const dl = t.closest("[data-del]"); if (dl) { pendingDelete = dl.dataset.del; renderCases(); return; }
  if (t.closest("[data-del-cancel]")) { pendingDelete = null; renderCases(); return; }
  const dc = t.closest("[data-del-confirm]"); if (dc) { REV.cases = REV.cases.filter(c => c.id !== dc.dataset.delConfirm); pendingDelete = null; persist(); renderCases(); toast("Caso eliminado"); return; }
  const dcm = t.closest("[data-delcomment]"); if (dcm) { REV.comments = REV.comments.filter(c => c.id !== dcm.dataset.delcomment); persist(); renderEvidence(); return; }
  const dm = t.closest("[data-delmissing]"); if (dm) { REV.missing = REV.missing.filter(c => c.id !== dm.dataset.delmissing); persist(); renderEvidence(); return; }
  const act = t.closest("[data-action]")?.dataset.action;
  if (act === "open-save") { saveOpen = true; renderResults(); }
  if (act === "close-save") { saveOpen = false; renderResults(); }
  if (act === "export-json") download(`revision-predictor-mano-codo-${today()}-${reviewer().replace(/\W+/g, "_")}.json`, JSON.stringify({ app: "predictor-mano-codo", kbVersion: KB.version, exported: new Date().toISOString(), reviewer: reviewer(), ...REV }, null, 1), "application/json");
  if (act === "export-csv") download(`casos-predictor-mano-codo-${today()}.csv`, casesCSV(), "text/csv;charset=utf-8");
});

document.addEventListener("submit", e => {
  e.preventDefault();
  const form = e.target, fd = new FormData(form);
  if (form.dataset.form) {
    const [type, id] = form.dataset.form.split(":");
    REV.comments.push({ id: uid(), target: { type, id }, text: fd.get("text").trim(), proposed: proposedText(fd), reviewer: reviewer(), date: today(), kbVersion: KB.version });
    persist(); const wasDx = type === "dx"; openForm = null; wasDx ? renderResults() : renderQs(); toast("Comentario guardado");
  } else if (form.id === "saveForm") {
    REV.cases.push({ id: uid(), date: today(), reviewer: reviewer(), answers: { ...ANS }, confirmed: fd.get("confirmed"), method: fd.get("method"), kind: fd.get("kind"), notes: fd.get("notes").trim(), kbVersion: KB.version });
    persist(); saveOpen = false; renderResults(); toast("Caso guardado. Míralo en Validación de casos");
  } else if (form.id === "missForm") {
    const values = ["se", "sp", "lr", "src"].filter(k => fd.get(k)).map(k => ({ se: "sens ", sp: "espec ", lr: "LR ", src: "fuente: " }[k] + fd.get(k))).join(" · ");
    REV.missing.push({ id: uid(), q: fd.get("q").trim(), st: fd.get("st"), dx: fd.get("dx"), values, notes: fd.get("notes").trim(), reviewer: reviewer(), date: today(), kbVersion: KB.version });
    persist(); renderEvidence(); toast("Propuesta agregada");
  }
});

$("#importFile").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    let added = 0;
    for (const k of ["comments", "missing", "cases"]) {
      const have = new Set(REV[k].map(x => x.id));
      for (const x of data[k] ?? []) if (x && x.id && !have.has(x.id)) { REV[k].push(x); added++; }
    }
    persist(); route(); rerender(); toast(`Importado: ${added} elementos nuevos`);
  } catch { toast("El archivo no es una exportación válida de esta app"); }
  e.target.value = "";
});

$("#shrink").addEventListener("change", e => { shrinkOn = e.target.checked; rerender(); route(); });
$("#reviewMode").addEventListener("change", e => { reviewOn = e.target.checked; $("#reviewbar").hidden = !reviewOn; settings.review = reviewOn; save(SETTINGS_KEY, settings); openForm = null; rerender(); });
$("#reviewer").addEventListener("input", e => { settings.reviewer = e.target.value; save(SETTINGS_KEY, settings); });
$("#preset").addEventListener("change", e => {
  const v = e.target.value; ANS = { ...(KB.presets[v] ?? {}) }; selDx = null; segView = "todos"; stage = v === "blank" ? "ctx" : "anam"; rerender();
});
window.addEventListener("hashchange", route);

/* ---------- inicio ---------- */
async function init() {
  try {
    KB = await (await fetch("data/knowledge.json", { cache: "no-cache" })).json();
  } catch {
    $("#view-evaluar").innerHTML = `<div class="alarm"><h2>No se pudo cargar la base de conocimiento</h2><p>Abre la app desde un servidor (por ejemplo <span class="mono">npx serve public</span>) o desde su dirección en Vercel, no como archivo local.</p></div>`;
    return;
  }
  byId = Object.fromEntries(KB.findings.map(f => [f.id, f]));
  $("#kbVersion").textContent = "v" + KB.version;
  const labels = KB.presetLabels ?? {};
  $("#preset").innerHTML = Object.keys(KB.presets).map(k => `<option value="${k}">${esc(labels[k] ?? k)}</option>`).join("");
  reviewOn = !!settings.review; $("#reviewMode").checked = reviewOn; $("#reviewbar").hidden = !reviewOn;
  $("#reviewer").value = settings.reviewer ?? "";
  segView = ["todos", "mano", "codo"].includes(settings.seg) ? settings.seg : "todos";
  ANS = { ...KB.presets.ex1 };
  rerender(); route();
}
init();
