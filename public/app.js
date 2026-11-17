/* Predictor bayesiano mano-muñeca + codo-antebrazo
   Motor: odds posterior = odds pre-test × Π LR (cada diagnóstico independiente). */
(function (root) {
  "use strict";

  // ---------- Motor (puro, testeable) ----------
  const toOdds = p => p / (1 - p);
  const toProb = o => o / (1 + o);

  function adjLR(lr, quality, kb, adjust) {
    if (!adjust) return lr;
    const f = (kb.calidad[quality] || { factor: 1 }).factor;
    return Math.exp(Math.log(lr) * f); // contrae log-LR hacia 0 según calidad
  }

  function posterior(dx, answers, kb, adjust) {
    let odds = toOdds(dx.pretest);
    const parts = [];
    for (const [fid, e] of Object.entries(dx.lr)) {
      const a = answers[fid];
      if (a !== 1 && a !== 0) continue;
      const lr = adjLR(a === 1 ? e.pos : e.neg, e.calidad, kb, adjust);
      odds *= lr;
      parts.push({ fid, lr });
    }
    return { p: toProb(odds), parts };
  }

  const H = p => (p <= 0 || p >= 1) ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));

  // Ganancia de información esperada (suma sobre diagnósticos que usan el hallazgo)
  function infoGain(fid, answers, kb, adjust) {
    let gain = 0;
    for (const dx of kb.diagnosticos) {
      const e = dx.lr[fid];
      if (!e) continue;
      const p = posterior(dx, answers, kb, adjust).p;
      const lp = adjLR(e.pos, e.calidad, kb, adjust), ln = adjLR(e.neg, e.calidad, kb, adjust);
      const spec = (lp - 1) / (lp - ln), sens = lp * (1 - spec);
      const pPos = p * sens + (1 - p) * (1 - spec);
      const postPos = toProb(toOdds(p) * lp), postNeg = toProb(toOdds(p) * ln);
      gain += H(p) - (pPos * H(postPos) + (1 - pPos) * H(postNeg));
    }
    return gain;
  }

  const level = p => p >= 0.7 ? "hi" : p >= 0.3 ? "mid" : "lo";

  function evaluateCase(c, kb, adjust) {
    const res = kb.diagnosticos.map(d => ({ d, p: posterior(d, c.respuestas, kb, adjust).p }));
    const detail = c.esperado.map(id => {
      const me = res.find(r => r.d.id === id);
      const seg = res.filter(r => r.d.segmento === me.d.segmento).sort((a, b) => b.p - a.p);
      return { id, p: me.p, top: seg[0].d.id === id, ok: seg[0].d.id === id && me.p >= 0.3 };
    });
    return { pass: detail.every(x => x.ok), detail, res };
  }

  const engine = { posterior, infoGain, evaluateCase, level, adjLR };
  if (typeof module !== "undefined" && module.exports) { module.exports = engine; return; }

  // ---------- UI ----------
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  };

  let kb, answers = {}, segFilter = "todos";
  let who = store.get("pmc_who", { paciente: true, kinesiologo: true, medico: true, laboratorio: true, imagen: true });
  const adjust = () => $("#adjQuality").checked;
  const review = () => $("#reviewMode").checked;
  const F = id => kb.hallazgos.find(h => h.id === id);
  const segOrder = ["general", "mano", "codo"];

  function usedBy(fid) { return kb.diagnosticos.filter(d => d.lr[fid]); }

  function renderQuestions() {
    const box = $("#questions");
    const open = store.get("pmc_open", { anamnesis: true });
    let html = "";
    for (const [cat, catName] of Object.entries(kb.categorias)) {
      const items = kb.hallazgos.filter(h => h.categoria === cat && (segFilter === "todos" || h.segmento === segFilter || h.segmento === "general"));
      if (!items.length) continue;
      const answered = items.filter(h => answers[h.id] === 0 || answers[h.id] === 1).length;
      html += `<details class="cat" data-cat="${cat}" ${open[cat] ? "open" : ""}><summary>${esc(catName)} <span class="count">${answered}/${items.length}</span></summary>`;
      for (const seg of segOrder) {
        const sub = items.filter(h => h.segmento === seg);
        if (!sub.length) continue;
        html += `<div class="subseg ${seg}">${esc(kb.segmentos[seg])}</div>`;
        for (const h of sub) {
          const v = answers[h.id];
          const rev = review() ? `<div class="rev">${usedBy(h.id).map(d => `${esc(d.nombre.split(" (")[0])}: LR+ ${d.lr[h.id].pos} / LR− ${d.lr[h.id].neg} [${d.lr[h.id].calidad}]`).join(" · ")}</div>` : "";
          html += `<div class="q" id="q-${h.id}"><div class="t">${esc(h.texto)}<span class="meta">${esc(kb.evaluadores[h.evaluador])}</span>${rev}</div>
            <div class="tri" data-f="${h.id}">
              <button data-v="1" class="${v === 1 ? "on" : ""}">Sí</button><button data-v="0" class="${v === 0 ? "on" : ""}">No</button><button data-v="" class="${v !== 1 && v !== 0 ? "on" : ""}">?</button>
            </div></div>`;
        }
      }
      html += `</details>`;
    }
    box.innerHTML = html;
  }

  function renderResults() {
    const out = [];
    const mini = [];
    for (const seg of ["mano", "codo"]) {
      const rows = kb.diagnosticos.filter(d => d.segmento === seg)
        .map(d => ({ d, ...posterior(d, answers, kb, adjust()) }))
        .sort((a, b) => b.p - a.p);
      const n = Object.values(answers).filter(v => v === 0 || v === 1).length;
      out.push(`<div class="seg-block ${seg}"><h3>${esc(kb.segmentos[seg])} <small>${n} respuestas</small></h3>` +
        rows.map(r => {
          const lv = level(r.p), pct = Math.round(r.p * 100);
          const contrib = review() && r.parts.length ? `<div class="contrib">pre ${Math.round(r.d.pretest * 100)}% · ${r.parts.map(x => `${x.fid} ×${x.lr.toFixed(2)}`).join(" · ")}</div>` : "";
          return `<div class="dx ${lv}"><div class="row"><span>${esc(r.d.nombre)}</span><span class="pct">${pct} %</span></div>
            <div class="bar"><div class="fill" style="width:${Math.max(1, pct)}%"></div><div class="mark" style="left:${r.d.pretest * 100}%" title="Pre-test ${Math.round(r.d.pretest * 100)} %"></div></div>${contrib}</div>`;
        }).join("") + `</div>`);
      const t = rows[0];
      mini.push(`<a href="#evaluar">${seg === "mano" ? "Mano" : "Codo"}: ${esc(t.d.nombre.split(" (")[0])} <b>${Math.round(t.p * 100)}%</b></a>`);
    }
    $("#results").innerHTML = out.join("");
    $("#mini").innerHTML = mini.join("");
  }

  function renderWho() {
    $("#whoFilter").innerHTML = Object.entries(kb.evaluadores).map(([k, v]) =>
      `<label><input type="checkbox" data-who="${k}" ${who[k] ? "checked" : ""}>${esc(v)}</label>`).join("");
  }

  function renderNext() {
    const cand = kb.hallazgos
      .filter(h => answers[h.id] !== 0 && answers[h.id] !== 1 && who[h.evaluador])
      .map(h => ({ h, g: infoGain(h.id, answers, kb, adjust()) }))
      .filter(x => x.g > 0.001)
      .sort((a, b) => b.g - a.g).slice(0, 7);
    $("#next").innerHTML = cand.length ? cand.map(({ h, g }) =>
      `<li>${esc(h.texto)} <span class="meta">${esc(kb.segmentos[h.segmento])} · ${esc(kb.evaluadores[h.evaluador])} · reduce ${g.toFixed(2)} bits · <button class="go" data-goto="${h.id}">responder ↓</button></span></li>`).join("")
      : `<li class="muted">No quedan hallazgos útiles para los evaluadores seleccionados.</li>`;
  }

  function renderEvidence() {
    let html = "";
    for (const seg of ["mano", "codo"]) {
      html += `<h3 style="margin-top:14px">${esc(kb.segmentos[seg])}</h3><div class="tbl-wrap"><table><tr><th>Diagnóstico</th><th>Pre-test</th><th>Hallazgo</th><th>LR+</th><th>LR−</th><th>Calidad</th><th>Ref.</th></tr>`;
      for (const d of kb.diagnosticos.filter(x => x.segmento === seg)) {
        const es = Object.entries(d.lr);
        es.forEach(([fid, e], i) => {
          html += `<tr>${i === 0 ? `<td rowspan="${es.length}"><b>${esc(d.nombre)}</b></td><td rowspan="${es.length}">${Math.round(d.pretest * 100)} %</td>` : ""}
            <td>${esc(F(fid).texto)}</td><td>${e.pos}</td><td>${e.neg}</td><td class="q-${e.calidad}" title="${esc(kb.calidad[e.calidad].texto)}">${e.calidad}</td>
            <td>${e.refs.map(r => `<a href="#ref-${r}">${esc(r)}</a>`).join(", ")}</td></tr>`;
        });
      }
      html += `</table></div>`;
    }
    html += `<p class="muted" style="margin-top:8px">Calidad: ${Object.entries(kb.calidad).map(([k, v]) => `<b>${k}</b> ${esc(v.texto)} (factor ${v.factor})`).join(" · ")}. Con el ajuste activo, el log-LR se multiplica por el factor.</p>`;
    $("#evidence").innerHTML = html;
    $("#refs").innerHTML = Object.entries(kb.referencias).map(([k, v]) => `<li id="ref-${k}"><b>${esc(k)}</b> — ${esc(v)}</li>`).join("");
    $("#proposeDx").innerHTML = kb.diagnosticos.map(d => `<option value="${d.id}">${esc(kb.segmentos[d.segmento])}: ${esc(d.nombre)}</option>`).join("");
  }

  function renderCases() {
    $("#caseSelect").innerHTML = `<option value="">Caso de ejemplo…</option>` + kb.casos.map(c => `<option value="${c.id}">${esc(c.nombre)}</option>`).join("");
  }

  function runCases() {
    const rows = kb.casos.map(c => {
      const r = evaluateCase(c, kb, adjust());
      return `<tr><td>${esc(c.nombre)}</td><td>${r.detail.map(x => `${esc(kb.diagnosticos.find(d => d.id === x.id).nombre)}: <b>${Math.round(x.p * 100)} %</b>${x.top ? "" : " (no es 1.º)"}`).join("<br>")}</td>
        <td class="${r.pass ? "ok" : "fail"}">${r.pass ? "Pasa" : "Falla"}</td><td><button class="btn ghost" data-loadcase="${c.id}">Ver</button></td></tr>`;
    });
    const n = kb.casos.filter(c => evaluateCase(c, kb, adjust()).pass).length;
    $("#caseResults").innerHTML = `<p><b>${n}/${kb.casos.length}</b> casos pasan.</p><div class="tbl-wrap"><table><tr><th>Caso</th><th>Esperado</th><th>Resultado</th><th></th></tr>${rows.join("")}</table></div>`;
  }

  function loadCase(id) {
    const c = kb.casos.find(x => x.id === id);
    if (!c) return;
    answers = { ...c.respuestas };
    save(); renderAll();
    location.hash = "#evaluar";
  }

  function save() { store.set("pmc_answers", answers); }
  function renderAll() { renderQuestions(); renderResults(); renderNext(); }

  function bind() {
    document.addEventListener("click", e => {
      const b = e.target.closest(".tri button");
      if (b) {
        const fid = b.parentElement.dataset.f, v = b.dataset.v;
        if (v === "") delete answers[fid]; else answers[fid] = Number(v);
        save(); renderAll(); return;
      }
      const s = e.target.closest(".seg-filter button");
      if (s) {
        segFilter = s.dataset.seg;
        document.querySelectorAll(".seg-filter button").forEach(x => x.classList.toggle("on", x === s));
        renderQuestions(); return;
      }
      const g = e.target.closest("[data-goto]");
      if (g) {
        const h = F(g.dataset.goto);
        if (segFilter !== "todos" && h.segmento !== segFilter && h.segmento !== "general") { segFilter = "todos"; document.querySelectorAll(".seg-filter button").forEach(x => x.classList.toggle("on", x.dataset.seg === "todos")); }
        const open = store.get("pmc_open", {}); open[h.categoria] = true; store.set("pmc_open", open);
        renderQuestions();
        const el = document.getElementById("q-" + h.id);
        if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.style.background = "#fff6e0"; setTimeout(() => el.style.background = "", 1500); }
        return;
      }
      const lc = e.target.closest("[data-loadcase]");
      if (lc) loadCase(lc.dataset.loadcase);
    });
    document.addEventListener("toggle", e => {
      if (e.target.matches && e.target.matches("details.cat")) {
        const open = store.get("pmc_open", {}); open[e.target.dataset.cat] = e.target.open; store.set("pmc_open", open);
      }
    }, true);
    $("#whoFilter").addEventListener("change", e => { who[e.target.dataset.who] = e.target.checked; store.set("pmc_who", who); renderNext(); });
    $("#adjQuality").addEventListener("change", () => { renderResults(); renderNext(); if ($("#caseResults").innerHTML) runCases(); });
    $("#reviewMode").addEventListener("change", renderAll);
    $("#loadCase").addEventListener("click", () => loadCase($("#caseSelect").value));
    $("#reset").addEventListener("click", () => { answers = {}; save(); renderAll(); });
    $("#runCases").addEventListener("click", runCases);
    $("#propose").addEventListener("submit", e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const id = String(fd.get("texto")).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
      const dx = kb.diagnosticos.find(d => d.id === fd.get("dx"));
      const snippet = {
        hallazgo: { id, segmento: dx.segmento, categoria: "fisico", evaluador: "kinesiologo", texto: fd.get("texto") },
        [`diagnosticos[${dx.id}].lr.${id}`]: { pos: Number(fd.get("pos")) || null, neg: Number(fd.get("neg")) || null, calidad: "C", refs: [fd.get("ref") || "pendiente"] }
      };
      const out = $("#proposeOut");
      out.hidden = false;
      out.textContent = "// Copie este bloque en public/data/knowledge.json tras revisión\n" + JSON.stringify(snippet, null, 2);
      const list = store.get("pmc_proposals", []); list.push(snippet); store.set("pmc_proposals", list);
    });
  }

  fetch("data/knowledge.json").then(r => r.json()).then(data => {
    kb = data;
    answers = store.get("pmc_answers", {});
    renderWho(); renderCases(); renderEvidence(); bind(); renderAll();
  }).catch(err => {
    $("#results").innerHTML = `<p class="fail">No se pudo cargar la base de evidencia: ${esc(err.message)}</p>`;
  });
})(this);
