(function(){
  "use strict";

  var supa = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  var MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

  function parseISO(s){
    var p = s.split("-").map(Number);
    return new Date(p[0], p[1]-1, p[2]);
  }
  function toISO(d){
    var y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), da = String(d.getDate()).padStart(2,"0");
    return y + "-" + m + "-" + da;
  }
  function addDays(d, n){ var r = new Date(d); r.setDate(r.getDate()+n); return r; }
  function nextMonday(d){
    var day = d.getDay();
    var diff = (8 - day) % 7 || 7;
    return addDays(d, day === 1 ? 0 : diff);
  }

  function weekLabel(startISO){
    var d0 = parseISO(startISO), d1 = addDays(d0,6);
    var sameMonth = d0.getMonth() === d1.getMonth();
    var m0 = MESES[d0.getMonth()], m1 = MESES[d1.getMonth()];
    var dd0 = String(d0.getDate()).padStart(2,"0"), dd1 = String(d1.getDate()).padStart(2,"0");
    return sameMonth ? (dd0 + "–" + dd1 + " " + m0) : (dd0 + " " + m0 + " – " + dd1 + " " + m1);
  }

  var nfM = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nfPct = new Intl.NumberFormat("es-AR", { style: "percent", maximumFractionDigits: 0 });

  function fmtM(v){
    if (v === null || v === undefined || isNaN(v)) return "—";
    return "$ " + nfM.format(v) + " M";
  }
  function fmtSigned(v){
    if (v === null || v === undefined || isNaN(v)) return "—";
    var s = v > 0 ? "+" : (v < 0 ? "−" : "");
    return s + "$ " + nfM.format(Math.abs(v)) + " M";
  }

  /* ---------------- state (in-memory cache, source of truth is Supabase) ---------------- */
  var weeks = [];
  var posicionHoy = { banco: null, cartera: null, depositos: null, nrd: null, fecha: null };
  var lastFFNWorkbook = null;
  var lastCarteraWorkbook = null;

  function emptyPosicion(){ return { banco: null, cartera: null, depositos: null, nrd: null, fecha: null }; }

  function rowToWeek(r){
    return {
      id: r.id,
      start: r.start_date,
      pagos: Number(r.pagos)||0,
      objetivo: Number(r.objetivo)||0,
      objetivoCustom: !!r.objetivo_custom,
      cartera: r.techo_cartera === null ? null : Number(r.techo_cartera),
      ffnProy: r.cobranza_ffn === null ? null : Number(r.cobranza_ffn),
      real: r.cobranza_real === null ? null : Number(r.cobranza_real)
    };
  }

  function sortWeeks(){
    weeks.sort(function(a,b){ return a.start < b.start ? -1 : (a.start > b.start ? 1 : 0); });
  }

  function cushionValue(){
    var vals = [posicionHoy.banco, posicionHoy.cartera, posicionHoy.depositos, posicionHoy.nrd];
    return vals.reduce(function(a,v){ return a + (Number(v)||0); }, 0);
  }
  function hasCushionData(){
    return [posicionHoy.banco, posicionHoy.cartera, posicionHoy.depositos, posicionHoy.nrd].some(function(v){
      return v !== null && v !== undefined && v !== "";
    });
  }

  var ESTADO_META = {
    good:     { pill: "pill-good",     row: "row-good",     label: "Cubierto" },
    warning:  { pill: "pill-warning",  row: "row-warning",  label: "Ajustado" },
    critical: { pill: "pill-critical", row: "row-critical", label: "Faltante" },
    pending:  { pill: "pill-pending",  row: "row-pending",  label: "Pendiente" }
  };

  function buildSeries(){
    sortWeeks();
    var running = cushionValue();
    var map = {};
    weeks.forEach(function(w){
      var real = w.real;
      var pagos = Number(w.pagos)||0;
      var objetivo = Number(w.objetivo)||0;
      var gap = real === null ? null : (pagos - real);
      var comp = (real === null || !objetivo) ? null : (real / objetivo);
      var estado;
      if (real === null) estado = "pending";
      else if (real >= pagos) estado = "good";
      else if (real >= 0.9 * pagos) estado = "warning";
      else estado = "critical";

      var plan = real !== null ? real : objetivo;
      running = running + (plan - pagos);

      map[w.id] = { real: real, gap: gap, comp: comp, estado: estado, posicion: running };
    });
    return map;
  }

  /* ---------------- toast ---------------- */
  var toastTimer = null;
  function toast(msg){
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ el.classList.remove("show"); }, 3200);
  }
  function markSaved(){
    var el = document.getElementById("lastSaved");
    if (el) el.textContent = new Date().toLocaleTimeString("es-AR", {hour:"2-digit", minute:"2-digit"});
  }

  /* ---------------- Supabase data layer ---------------- */
  async function fetchWeeks(){
    var res = await supa.from("weeks").select("*").order("start_date");
    if (res.error){ toast("No se pudo cargar la planilla: " + res.error.message); return []; }
    return res.data.map(rowToWeek);
  }
  async function fetchPosicion(){
    var res = await supa.from("posicion_hoy").select("*").eq("id", 1).maybeSingle();
    if (res.error || !res.data){ return emptyPosicion(); }
    return {
      banco: res.data.banco === null ? null : Number(res.data.banco),
      cartera: res.data.cartera === null ? null : Number(res.data.cartera),
      depositos: res.data.depositos === null ? null : Number(res.data.depositos),
      nrd: res.data.nrd === null ? null : Number(res.data.nrd),
      fecha: res.data.fecha
    };
  }

  async function updateWeekField(w, field, value){
    var colMap = { pagos: "pagos", objetivo: "objetivo", real: "cobranza_real" };
    var patch = {};
    patch[colMap[field]] = value;
    if (field === "objetivo"){ patch.objetivo_custom = true; w.objetivoCustom = true; }
    patch.updated_at = new Date().toISOString();
    var res = await supa.from("weeks").update(patch).eq("id", w.id);
    if (res.error) toast("No se pudo guardar: " + res.error.message);
    else markSaved();
  }
  async function updateWeekDate(w, newStart){
    var res = await supa.from("weeks").update({ start_date: newStart, updated_at: new Date().toISOString() }).eq("id", w.id);
    if (res.error) toast("No se pudo guardar la fecha: " + res.error.message);
    else markSaved();
  }
  async function insertWeek(startISO){
    var res = await supa.from("weeks").insert({ start_date: startISO, pagos: 0, objetivo: 0 }).select().single();
    if (res.error){ toast("No se pudo agregar la semana: " + res.error.message); return null; }
    markSaved();
    return rowToWeek(res.data);
  }
  async function deleteWeekRow(id){
    var res = await supa.from("weeks").delete().eq("id", id);
    if (res.error) toast("No se pudo eliminar: " + res.error.message);
    else markSaved();
  }
  async function updatePosicion(patch){
    patch.updated_at = new Date().toISOString();
    var res = await supa.from("posicion_hoy").update(patch).eq("id", 1);
    if (res.error) toast("No se pudo guardar la posición de caja: " + res.error.message);
    else markSaved();
  }

  /* ---------------- posición de caja hoy ---------------- */
  function renderPosPanel(){
    var b = document.getElementById("posBanco");
    var c = document.getElementById("posCartera");
    var d = document.getElementById("posDepositos");
    var n = document.getElementById("posNrd");
    if (document.activeElement !== b) b.value = posicionHoy.banco === null ? "" : posicionHoy.banco;
    if (document.activeElement !== c) c.value = posicionHoy.cartera === null ? "" : posicionHoy.cartera;
    if (document.activeElement !== d) d.value = posicionHoy.depositos === null ? "" : posicionHoy.depositos;
    if (document.activeElement !== n) n.value = posicionHoy.nrd === null ? "" : posicionHoy.nrd;

    var colchon = document.getElementById("posColchon");
    var val = cushionValue();
    colchon.textContent = fmtM(val);
    colchon.style.color = !hasCushionData() ? "var(--muted)" : (val < 0 ? "var(--critical)" : "var(--good)");

    var dateEl = document.getElementById("posDate");
    if (posicionHoy.fecha){
      dateEl.textContent = "Datos al " + weekLabel(posicionHoy.fecha).split("–")[0].trim() + " (última carga desde archivo)";
    } else if (hasCushionData()){
      dateEl.textContent = "Cargado a mano — sin fecha de archivo asociada.";
    } else {
      dateEl.textContent = "Cargá el archivo de Pagos (FFN) para completar esto solo, o escribilo a mano.";
    }
  }

  [["posBanco","banco"],["posCartera","cartera"],["posDepositos","depositos"],["posNrd","nrd"]].forEach(function(pair){
    document.getElementById(pair[0]).addEventListener("change", async function(e){
      var v = e.target.value;
      posicionHoy[pair[1]] = v === "" ? null : Number(v);
      var patch = {}; patch[pair[1]] = posicionHoy[pair[1]];
      await updatePosicion(patch);
      renderAll();
    });
  });

  /* ---------------- render: table ---------------- */
  function fieldInput(w, field, opts){
    opts = opts || {};
    var val = w[field];
    var input = document.createElement("input");
    input.type = "number";
    input.step = "0.01";
    input.inputMode = "decimal";
    input.placeholder = opts.placeholder || "0";
    if (val !== null && val !== undefined && val !== "") input.value = val;
    input.addEventListener("change", async function(){
      var v = input.value === "" ? (opts.nullable ? null : 0) : Number(input.value);
      w[field] = v;
      await updateWeekField(w, field, v);
      renderAll();
    });
    return input;
  }

  function renderTable(series){
    var tbody = document.getElementById("tbody");
    var tfoot = document.getElementById("tfoot");
    tbody.innerHTML = "";

    if (!weeks.length){
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 11;
      td.innerHTML = '<div class="empty-state">No hay semanas cargadas todavía. Usá "Agregar semana" o cargá un archivo.</div>';
      tr.appendChild(td);
      tbody.appendChild(tr);
      tfoot.innerHTML = "";
      return;
    }

    var sums = { pagos:0, objetivo:0, real:0, cartera:0, ffnProy:0, realCount:0 };

    weeks.forEach(function(w){
      var c = series[w.id];
      var meta = ESTADO_META[c.estado];

      var tr = document.createElement("tr");
      tr.className = meta.row;

      var tdWeek = document.createElement("td");
      var lab = document.createElement("div");
      lab.className = "week-label";
      lab.textContent = weekLabel(w.start);
      var dateWrap = document.createElement("span");
      dateWrap.className = "week-date";
      var dateInput = document.createElement("input");
      dateInput.type = "date";
      dateInput.value = w.start;
      dateInput.addEventListener("change", async function(){
        w.start = dateInput.value;
        await updateWeekDate(w, w.start);
        renderAll();
      });
      dateWrap.appendChild(dateInput);
      tdWeek.appendChild(lab);
      tdWeek.appendChild(dateWrap);
      tr.appendChild(tdWeek);

      var tdPagos = document.createElement("td");
      tdPagos.className = "num";
      tdPagos.appendChild(fieldInput(w, "pagos"));
      tr.appendChild(tdPagos);

      var tdObj = document.createElement("td");
      tdObj.className = "num";
      tdObj.appendChild(fieldInput(w, "objetivo"));
      tr.appendChild(tdObj);

      var tdFFN = document.createElement("td");
      tdFFN.className = "num auto-val";
      tdFFN.textContent = fmtM(w.ffnProy);
      tr.appendChild(tdFFN);

      var tdCartera = document.createElement("td");
      tdCartera.className = "num auto-val";
      tdCartera.textContent = fmtM(w.cartera);
      tr.appendChild(tdCartera);

      var tdReal = document.createElement("td");
      tdReal.className = "num";
      tdReal.appendChild(fieldInput(w, "real", { placeholder: "vacío", nullable: true }));
      tr.appendChild(tdReal);

      var tdGap = document.createElement("td");
      tdGap.className = "num gap-cell " + (c.gap === null ? "g-muted" : (c.gap > 0 ? "g-critical" : "g-good"));
      tdGap.textContent = c.gap === null ? "—" : fmtSigned(-c.gap);
      tr.appendChild(tdGap);

      var tdPos = document.createElement("td");
      tdPos.className = "num gap-cell " + (c.posicion < 0 ? "g-critical" : "g-good");
      tdPos.textContent = fmtSigned(c.posicion);
      tr.appendChild(tdPos);

      var tdComp = document.createElement("td");
      tdComp.className = "num";
      tdComp.style.fontFamily = "var(--font-mono)";
      tdComp.style.color = c.comp === null ? "var(--muted)" : "var(--ink-2)";
      tdComp.textContent = c.comp === null ? "—" : nfPct.format(c.comp);
      tr.appendChild(tdComp);

      var tdEstado = document.createElement("td");
      var pill = document.createElement("span");
      pill.className = "pill " + meta.pill;
      pill.textContent = meta.label;
      tdEstado.appendChild(pill);
      tr.appendChild(tdEstado);

      var tdDel = document.createElement("td");
      var btnDel = document.createElement("button");
      btnDel.className = "danger-ghost rowdel";
      btnDel.title = "Eliminar semana";
      btnDel.textContent = "✕";
      btnDel.addEventListener("click", async function(){
        if (confirm("¿Eliminar la semana " + weekLabel(w.start) + "?")){
          await deleteWeekRow(w.id);
          weeks = weeks.filter(function(x){ return x.id !== w.id; });
          renderAll();
        }
      });
      tdDel.appendChild(btnDel);
      tr.appendChild(tdDel);

      tbody.appendChild(tr);

      sums.pagos += Number(w.pagos)||0;
      sums.objetivo += Number(w.objetivo)||0;
      if (w.cartera !== null && w.cartera !== undefined) sums.cartera += Number(w.cartera);
      if (w.ffnProy !== null && w.ffnProy !== undefined) sums.ffnProy += Number(w.ffnProy);
      if (c.real !== null){ sums.real += c.real; sums.realCount++; }
    });

    var totalGap = sums.pagos - sums.real;
    tfoot.innerHTML = "";
    var trf = document.createElement("tr");
    function tfCell(txt, cls){ var td = document.createElement("td"); if(cls) td.className = cls; td.textContent = txt; return td; }
    trf.appendChild(tfCell("Total período", "label"));
    trf.appendChild(tfCell(fmtM(sums.pagos)));
    trf.appendChild(tfCell(fmtM(sums.objetivo)));
    trf.appendChild(tfCell(fmtM(sums.ffnProy)));
    trf.appendChild(tfCell(fmtM(sums.cartera)));
    trf.appendChild(tfCell(sums.realCount ? fmtM(sums.real) : "—"));
    trf.appendChild(tfCell(sums.realCount ? fmtSigned(-totalGap) : "—"));
    trf.appendChild(tfCell(""));
    trf.appendChild(tfCell(""));
    trf.appendChild(tfCell(""));
    trf.appendChild(tfCell(""));
    tfoot.appendChild(trf);
  }

  /* ---------------- render: kpis ---------------- */
  function renderKPIs(series){
    var row = document.getElementById("kpiRow");
    row.innerHTML = "";

    var next = weeks.find(function(w){ return series[w.id].real === null; }) || weeks[weeks.length-1];

    var withReal = weeks.filter(function(w){ return series[w.id].real !== null; });
    var sumReal = withReal.reduce(function(a,w){ return a + series[w.id].real; }, 0);
    var sumObjReal = withReal.reduce(function(a,w){ return a + (Number(w.objetivo)||0); }, 0);
    var sumPagosReal = withReal.reduce(function(a,w){ return a + (Number(w.pagos)||0); }, 0);
    var cumplPct = sumObjReal ? (sumReal / sumObjReal) : null;
    var gapAcum = sumPagosReal - sumReal;

    var cards = [];

    var cushion = cushionValue();
    cards.push({
      label: "Colchón de hoy",
      value: fmtM(cushion),
      sub: hasCushionData() ? "banco + cartera + depósitos + NRD" : "sin datos cargados todavía",
      stripe: !hasCushionData() ? "" : (cushion < 0 ? "stripe-critical" : "stripe-good")
    });

    if (next){
      cards.push({
        label: "Próxima semana pendiente",
        value: weekLabel(next.start),
        sub: fmtM(next.pagos) + " a pagar",
        stripe: "stripe-accent"
      });
      var posNext = series[next.id].posicion;
      cards.push({
        label: "Posición al cierre de esa semana",
        value: fmtSigned(posNext),
        sub: posNext < 0 ? "no alcanza — falta salir a buscar la diferencia" : "cubierto con el objetivo cargado",
        stripe: posNext < 0 ? "stripe-critical" : "stripe-good"
      });
    } else {
      cards.push({ label: "Próxima semana pendiente", value: "—", sub: "agregá una semana", stripe: "" });
      cards.push({ label: "Posición al cierre de esa semana", value: "—", sub: "sin semanas cargadas", stripe: "" });
    }

    if (cumplPct === null){
      cards.push({ label: "Cumplimiento del período", value: "—", sub: "todavía sin cobranza real cargada", stripe: "" });
    } else {
      var cls = cumplPct >= 1 ? "stripe-good" : (cumplPct >= 0.8 ? "stripe-warning" : "stripe-critical");
      cards.push({ label: "Cumplimiento del período", value: nfPct.format(cumplPct), sub: withReal.length + " semana(s) con dato cargado", stripe: cls });
    }

    if (!withReal.length){
      cards.push({ label: "Faltante acumulado", value: "—", sub: "cargá cobranza real para calcularlo", stripe: "" });
    } else {
      var gcls = gapAcum > 0 ? "stripe-critical" : "stripe-good";
      cards.push({ label: "Faltante acumulado", value: fmtSigned(-gapAcum), sub: gapAcum > 0 ? "cubierto hoy con venta de cheques" : "cobranza alcanzó para cubrir pagos", stripe: gcls });
    }

    cards.forEach(function(c){
      var div = document.createElement("div");
      div.className = "kpi " + (c.stripe||"");
      div.innerHTML = '<div class="label">'+c.label+'</div><div class="value">'+c.value+'</div><div class="sub">'+c.sub+'</div>';
      row.appendChild(div);
    });
  }

  /* ---------------- charts (SVG) ---------------- */
  function svgEl(tag, attrs){
    var el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function showTip(evt, title, lines){
    var tip = document.getElementById("tip");
    tip.innerHTML = '<div class="tt-title">'+title+'</div>' + lines.map(function(l){ return '<div>'+l+'</div>'; }).join("");
    tip.classList.add("show");
    moveTip(evt);
  }
  function moveTip(evt){
    var tip = document.getElementById("tip");
    var x = evt.clientX + 14, y = evt.clientY + 14;
    var rect = tip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 10) x = evt.clientX - rect.width - 14;
    if (y + rect.height > window.innerHeight - 10) y = evt.clientY - rect.height - 14;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }
  function hideTip(){ document.getElementById("tip").classList.remove("show"); }

  function renderLegend(){
    var el = document.getElementById("legend1");
    el.innerHTML =
      '<span><i style="background:var(--s1)"></i>Pagos necesarios</span>' +
      '<span><i style="background:var(--s2)"></i>Objetivo cobranza</span>' +
      '<span><i style="background:var(--s3)"></i>Cobranza real</span>';
  }

  function renderChartMain(series){
    var svg = document.getElementById("chartMain");
    svg.innerHTML = "";
    if (!weeks.length){ svg.setAttribute("width", 0); svg.setAttribute("height", 0); return; }

    var groupW = 96, barW = 22, gap = 3, padL = 54, padR = 20, padT = 16, padB = 34;
    var h = 220;
    var w = padL + padR + weeks.length * groupW;
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);

    var maxVal = Math.max.apply(null, weeks.map(function(wk){
      return Math.max(Number(wk.pagos)||0, Number(wk.objetivo)||0, series[wk.id].real || 0, 1);
    }));
    maxVal = maxVal * 1.15;
    var plotH = h - padT - padB;
    function y(v){ return padT + plotH - (v/maxVal)*plotH; }

    var ticks = 4;
    for (var t=0;t<=ticks;t++){
      var v = maxVal * t/ticks;
      var yy = y(v);
      svg.appendChild(svgEl("line", {x1:padL, x2:w-padR, y1:yy, y2:yy, stroke:"var(--line)", "stroke-width":1}));
      var lbl = svgEl("text", {x:padL-8, y:yy+3, "text-anchor":"end", fill:"var(--muted)", "font-size":10, "font-family":"var(--font-mono)"});
      lbl.textContent = Math.round(v).toLocaleString("es-AR");
      svg.appendChild(lbl);
    }
    svg.appendChild(svgEl("line", {x1:padL, x2:w-padR, y1:y(0), y2:y(0), stroke:"var(--line-strong)", "stroke-width":1}));

    weeks.forEach(function(wk, i){
      var c = series[wk.id];
      var gx = padL + i*groupW + (groupW - (barW*3+gap*2))/2;
      var s = [
        { v: Number(wk.pagos)||0, color: "var(--s1)", name: "Pagos" },
        { v: Number(wk.objetivo)||0, color: "var(--s2)", name: "Objetivo" },
        { v: c.real, color: "var(--s3)", name: "Real" }
      ];
      s.forEach(function(ser, si){
        var x = gx + si*(barW+gap);
        if (ser.v === null){
          var dash = svgEl("line", {x1:x, x2:x+barW, y1:y(0), y2:y(0), stroke:"var(--muted)", "stroke-width":2, "stroke-dasharray":"3,3"});
          svg.appendChild(dash);
          return;
        }
        var bh = plotH - (y(ser.v) - padT);
        var rect = svgEl("rect", {
          x:x, y:y(ser.v), width:barW, height: Math.max(bh,1.5), rx:3, fill: ser.color, style:"cursor:pointer"
        });
        rect.addEventListener("mousemove", function(evt){
          showTip(evt, weekLabel(wk.start), [ser.name + ": " + fmtM(ser.v)]);
        });
        rect.addEventListener("mouseleave", hideTip);
        svg.appendChild(rect);
      });

      var lab = svgEl("text", {x: gx + (barW*3+gap*2)/2, y: h-14, "text-anchor":"middle", fill:"var(--ink-2)", "font-size":11, "font-family":"var(--font-body)"});
      lab.textContent = weekLabel(wk.start);
      svg.appendChild(lab);
    });
  }

  function renderDivergingBarChart(svgId, values, tipFn){
    var svg = document.getElementById(svgId);
    svg.innerHTML = "";
    if (!weeks.length){ svg.setAttribute("width",0); svg.setAttribute("height",0); return; }

    var barW = 34, groupW = 62, padL = 60, padR = 16, padT = 14, padB = 34;
    var h = 200;
    var w = padL + padR + weeks.length*groupW;
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);

    var nums = values.filter(function(v){ return v !== null; });
    var maxAbs = Math.max.apply(null, nums.map(Math.abs).concat([1])) * 1.2;
    var plotH = h - padT - padB;
    var zeroY = padT + plotH/2;
    function y(v){ return zeroY - (v/maxAbs)*(plotH/2); }

    svg.appendChild(svgEl("line", {x1:padL, x2:w-padR, y1:zeroY, y2:zeroY, stroke:"var(--line-strong)", "stroke-width":1}));
    var zl = svgEl("text", {x:padL-8, y:zeroY+3, "text-anchor":"end", fill:"var(--muted)", "font-size":10, "font-family":"var(--font-mono)"});
    zl.textContent = "0";
    svg.appendChild(zl);

    weeks.forEach(function(wk, i){
      var val = values[i];
      var gx = padL + i*groupW + (groupW-barW)/2;
      if (val === null){
        var dash = svgEl("line", {x1:gx, x2:gx+barW, y1:zeroY, y2:zeroY, stroke:"var(--muted)", "stroke-width":2, "stroke-dasharray":"3,3"});
        svg.appendChild(dash);
      } else {
        var color = val < 0 ? "var(--critical)" : "var(--good)";
        var top = Math.min(zeroY, y(val));
        var bh = Math.abs(y(val) - zeroY);
        var rect = svgEl("rect", { x:gx, y: top, width: barW, height: Math.max(bh,1.5), rx:3, fill: color, style:"cursor:pointer" });
        rect.addEventListener("mousemove", function(evt){ showTip(evt, weekLabel(wk.start), [tipFn(val)]); });
        rect.addEventListener("mouseleave", hideTip);
        svg.appendChild(rect);
      }
      var lab = svgEl("text", {x: gx+barW/2, y: h-14, "text-anchor":"middle", fill:"var(--ink-2)", "font-size":10.5, "font-family":"var(--font-body)"});
      lab.textContent = weekLabel(wk.start);
      svg.appendChild(lab);
    });
  }

  function renderChartGap(series){
    renderDivergingBarChart("chartGap", weeks.map(function(wk){
      var c = series[wk.id];
      return c.gap === null ? null : -c.gap;
    }), function(v){ return (v < 0 ? "Faltan " : "Sobran ") + fmtM(Math.abs(v)); });
  }

  function renderChartPos(series){
    renderDivergingBarChart("chartPos", weeks.map(function(wk){ return series[wk.id].posicion; }), function(v){
      return (v < 0 ? "Faltante acumulado: " : "Posición: ") + fmtM(Math.abs(v));
    });
  }

  function renderChartComp(series){
    var svg = document.getElementById("chartComp");
    svg.innerHTML = "";
    var withReal = weeks.filter(function(w){ return series[w.id].real !== null; });
    if (!withReal.length){
      svg.setAttribute("width", 360); svg.setAttribute("height", 200);
      var t = svgEl("text", {x:180, y:100, "text-anchor":"middle", fill:"var(--muted)", "font-size":12, "font-family":"var(--font-body)"});
      t.textContent = "Sin semanas con cobranza real cargada todavía";
      svg.appendChild(t);
      return;
    }

    var barW = 34, groupW = 62, padL = 44, padR = 16, padT = 14, padB = 34;
    var h = 200;
    var w = padL + padR + withReal.length*groupW;
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);

    var maxPct = Math.max.apply(null, withReal.map(function(wk){ return series[wk.id].comp||0; }).concat([1])) * 1.15;
    var plotH = h - padT - padB;
    function y(v){ return padT + plotH - (v/maxPct)*plotH; }

    var refY = y(1);
    svg.appendChild(svgEl("line", {x1:padL, x2:w-padR, y1:refY, y2:refY, stroke:"var(--line-strong)", "stroke-width":1, "stroke-dasharray":"2,3"}));
    var refLbl = svgEl("text", {x:padL-8, y:refY+3, "text-anchor":"end", fill:"var(--muted)", "font-size":10, "font-family":"var(--font-mono)"});
    refLbl.textContent = "100%";
    svg.appendChild(refLbl);

    withReal.forEach(function(wk,i){
      var c = series[wk.id];
      var gx = padL + i*groupW + (groupW-barW)/2;
      var color = c.comp >= 1 ? "var(--good)" : (c.comp >= 0.8 ? "var(--warning)" : "var(--critical)");
      var rect = svgEl("rect", { x:gx, y:y(c.comp), width:barW, height: Math.max(plotH-(y(c.comp)-padT),1.5), rx:3, fill:color, style:"cursor:pointer" });
      rect.addEventListener("mousemove", function(evt){
        showTip(evt, weekLabel(wk.start), ["Cumplimiento: " + nfPct.format(c.comp), "Real: " + fmtM(c.real) + " / Objetivo: " + fmtM(wk.objetivo)]);
      });
      rect.addEventListener("mouseleave", hideTip);
      svg.appendChild(rect);
      var lab = svgEl("text", {x: gx+barW/2, y: h-14, "text-anchor":"middle", fill:"var(--ink-2)", "font-size":10.5, "font-family":"var(--font-body)"});
      lab.textContent = weekLabel(wk.start);
      svg.appendChild(lab);
    });
  }

  document.addEventListener("mousemove", function(evt){
    var tip = document.getElementById("tip");
    if (tip.classList.contains("show")) moveTip(evt);
  });

  /* ---------------- add / reset ---------------- */
  document.getElementById("btnAdd").addEventListener("click", async function(){
    var last = weeks[weeks.length-1];
    var start = last ? toISO(addDays(parseISO(last.start), 7)) : toISO(nextMonday(new Date()));
    var row = await insertWeek(start);
    if (row){
      weeks.push(row);
      renderAll();
      toast("Semana agregada — cargá los montos");
    }
  });

  document.getElementById("btnReset").addEventListener("click", async function(){
    if (!confirm("Esto reemplaza la planilla actual (y la posición de caja) por las 4 semanas de agosto 2026. ¿Continuar?")) return;
    var SEED = [
      { start: "2026-08-03", pagos: 7150.02, objetivo: 7150.02, techo_cartera: 4985.44, cobranza_ffn: 3085.04 },
      { start: "2026-08-10", pagos: 3509.58, objetivo: 3509.58, techo_cartera: 4672.19, cobranza_ffn: 4695.31 },
      { start: "2026-08-17", pagos: 3055.83, objetivo: 3055.83, techo_cartera: 4130.63, cobranza_ffn: 2485.81 },
      { start: "2026-08-24", pagos: 5383.94, objetivo: 5383.94, techo_cartera: 2796.00, cobranza_ffn: 3901.08 }
    ];
    await supa.from("weeks").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    var payload = SEED.map(function(s){
      return { start_date: s.start, pagos: s.pagos, objetivo: s.objetivo, objetivo_custom: false, techo_cartera: s.techo_cartera, cobranza_ffn: s.cobranza_ffn };
    });
    await supa.from("weeks").insert(payload);
    await supa.from("posicion_hoy").update({ banco: null, cartera: null, depositos: null, nrd: null, fecha: null }).eq("id", 1);
    await bootData();
    toast("Semillas restauradas");
  });

  /* ---------------- xlsx import helpers ---------------- */
  function normLabel(s){
    return (s||"").toString().toLowerCase()
      .replace(/[íÍ]/g,"i").replace(/[áÁ]/g,"a").replace(/[éÉ]/g,"e").replace(/[óÓ]/g,"o").replace(/[úÚ]/g,"u")
      .replace(/\s+/g," ").trim();
  }
  function readWorkbook(file){
    return new Promise(function(resolve, reject){
      var reader = new FileReader();
      reader.onload = function(){
        try{
          var data = new Uint8Array(reader.result);
          var wb = XLSX.read(data, { type: "array", cellDates: true });
          resolve(wb);
        }catch(e){ reject(e); }
      };
      reader.onerror = function(){ reject(new Error("no se pudo leer el archivo")); };
      reader.readAsArrayBuffer(file);
    });
  }
  function sheetRows(wb, name){
    return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
  }
  function dateSheetCandidates(wb){
    var re = /^\d{2}-\d{2}-\d{2}$/;
    return wb.SheetNames.filter(function(n){ return re.test(n.trim()); }).sort(function(a,b){
      return parseDDMMYY(b) - parseDDMMYY(a);
    });
  }
  function parseDDMMYY(name){
    var m = name.trim().match(/^(\d{2})-(\d{2})-(\d{2})$/);
    if (!m) return 0;
    return new Date(2000 + Number(m[3]), Number(m[2])-1, Number(m[1])).getTime();
  }

  function extractFFNSheet(wb, sheetName){
    var rows = sheetRows(wb, sheetName);
    var header = rows[0] || [];

    function findRow(label){
      var target = normLabel(label);
      return rows.find(function(r){ return r[0] && normLabel(r[0]).indexOf(target) !== -1; });
    }
    function findAllRows(label){
      var target = normLabel(label);
      return rows.filter(function(r){ return r[0] && normLabel(r[0]).indexOf(target) !== -1; });
    }

    var weekCols = [];
    for (var i=4;i<header.length;i++){
      if (header[i] instanceof Date) weekCols.push(i); else if (weekCols.length) break;
    }

    var rBanco = findRow("saldo bcos");
    var rCartera = findRow("cheq en cartera");
    var rDepositos = findRow("valores depositados");
    var rNrd = findRow("nrd");
    var subtotals = findAllRows("subtotal");
    var rPagos = subtotals[0] || null;
    var rCobranza = subtotals[1] || null;

    var missing = [];
    if (!rBanco) missing.push("Saldo en banco");
    if (!rCartera) missing.push("Cheques en cartera");
    if (!rDepositos) missing.push("Depósitos en tránsito");
    if (!rNrd) missing.push("NRD/cesiones");
    if (!rPagos) missing.push("Fila de pagos (SUBTOTAL)");
    if (!rCobranza) missing.push("Fila de cobranza proyectada (SUBTOTAL)");

    var weekly = weekCols.map(function(colIdx){
      var dateVal = header[colIdx];
      return {
        start: toISO(dateVal),
        pagos: rPagos && rPagos[colIdx] != null ? Math.abs(Number(rPagos[colIdx]))/1e6 : null,
        ffnProy: rCobranza && rCobranza[colIdx] != null ? Number(rCobranza[colIdx])/1e6 : null
      };
    });

    return {
      fileDate: header[1] instanceof Date ? toISO(header[1]) : null,
      posicionHoy: {
        banco: rBanco && rBanco[1] != null ? Number(rBanco[1])/1e6 : null,
        cartera: rCartera && rCartera[1] != null ? Number(rCartera[1])/1e6 : null,
        depositos: rDepositos && rDepositos[1] != null ? Number(rDepositos[1])/1e6 : null,
        nrd: rNrd && rNrd[1] != null ? Number(rNrd[1])/1e6 : null
      },
      weekly: weekly.filter(function(e){ return e.pagos !== null || e.ffnProy !== null; }),
      missing: missing
    };
  }

  async function mergeFFN(parsed, sheetName){
    var patch = {};
    if (parsed.posicionHoy.banco !== null) patch.banco = parsed.posicionHoy.banco;
    if (parsed.posicionHoy.cartera !== null) patch.cartera = parsed.posicionHoy.cartera;
    if (parsed.posicionHoy.depositos !== null) patch.depositos = parsed.posicionHoy.depositos;
    if (parsed.posicionHoy.nrd !== null) patch.nrd = parsed.posicionHoy.nrd;
    if (parsed.fileDate) patch.fecha = parsed.fileDate;
    if (Object.keys(patch).length) await updatePosicion(patch);

    var created = 0, updated = 0;
    for (var i=0;i<parsed.weekly.length;i++){
      var entry = parsed.weekly[i];
      var row = weeks.find(function(w){ return w.start === entry.start; });
      var wpatch = {};
      if (entry.pagos !== null){
        wpatch.pagos = Math.round(entry.pagos*100)/100;
        if (!row || !row.objetivoCustom) wpatch.objetivo = wpatch.pagos;
      }
      if (entry.ffnProy !== null) wpatch.cobranza_ffn = Math.round(entry.ffnProy*100)/100;
      wpatch.updated_at = new Date().toISOString();

      if (row){
        await supa.from("weeks").update(wpatch).eq("id", row.id);
        updated++;
      } else {
        wpatch.start_date = entry.start;
        await supa.from("weeks").insert(wpatch);
        created++;
      }
    }

    posicionHoy = await fetchPosicion();
    weeks = await fetchWeeks();
    renderAll();

    var msg = "Cargado desde hoja " + sheetName + " — colchón " + fmtM(cushionValue()) + ", " + (created+updated) + " semana(s) actualizadas.";
    if (parsed.missing.length) msg += " No encontré: " + parsed.missing.join(", ") + ".";
    toast(msg);
  }

  function setupSheetPicker(selectEl, sheets, defaultSheet, onPick){
    selectEl.innerHTML = "";
    sheets.forEach(function(name){
      var opt = document.createElement("option");
      opt.value = name; opt.textContent = name;
      if (name === defaultSheet) opt.selected = true;
      selectEl.appendChild(opt);
    });
    selectEl.style.display = sheets.length > 1 ? "inline-flex" : "none";
    selectEl.onchange = function(){ onPick(selectEl.value); };
  }

  document.getElementById("btnLoadFFN").addEventListener("click", function(){
    document.getElementById("ffnFileInput").click();
  });
  document.getElementById("ffnFileInput").addEventListener("change", async function(evt){
    var file = evt.target.files[0];
    evt.target.value = "";
    if (!file) return;
    try{
      var wb = await readWorkbook(file);
      lastFFNWorkbook = wb;
      var candidates = dateSheetCandidates(wb);
      var sheetName = candidates[0] || wb.SheetNames[0];
      var parsed = extractFFNSheet(wb, sheetName);
      await mergeFFN(parsed, sheetName);
      setupSheetPicker(document.getElementById("ffnSheetPicker"), candidates.length ? candidates : wb.SheetNames, sheetName, function(chosen){
        mergeFFN(extractFFNSheet(lastFFNWorkbook, chosen), chosen);
      });
    }catch(e){
      toast("No se pudo leer el archivo. ¿Es un .xlsx válido?");
    }
  });

  function extractCarteraWorkbook(wb){
    var byDate = {};
    var sheetsUsed = [];
    wb.SheetNames.forEach(function(name){
      var rows;
      try{ rows = sheetRows(wb, name); }catch(e){ return; }
      var row1 = rows[0], row3 = rows[2];
      if (!row1 || !row3) return;
      if (normLabel(row1[0]) !== "fecha") return;
      var startIdx = -1;
      for (var i=0;i<row3.length;i++){ if (row3[i] instanceof Date){ startIdx = i; break; } }
      if (startIdx === -1) return;
      sheetsUsed.push(name);
      for (var j=startIdx;j<row3.length;j++){
        var d = row3[j];
        if (!(d instanceof Date)) continue;
        var monday = addDays(d, 1);
        var key = toISO(monday);
        var v = row1[j];
        if (v == null) continue;
        byDate[key] = (byDate[key]||0) + Number(v);
      }
    });
    var weekly = Object.keys(byDate).map(function(k){ return { start: k, cartera: byDate[k]/1e6 }; });
    return { sheetsUsed: sheetsUsed, weekly: weekly };
  }

  async function mergeCartera(parsed, label){
    var updated = 0, skipped = 0;
    for (var i=0;i<parsed.weekly.length;i++){
      var entry = parsed.weekly[i];
      var row = weeks.find(function(w){ return w.start === entry.start; });
      if (!row){ skipped++; continue; }
      await supa.from("weeks").update({ techo_cartera: Math.round(entry.cartera*100)/100, updated_at: new Date().toISOString() }).eq("id", row.id);
      updated++;
    }
    weeks = await fetchWeeks();
    renderAll();
    var msg = "Cartera cargada desde " + label + " — " + updated + " semana(s) actualizadas.";
    if (skipped) msg += " " + skipped + " semana(s) del archivo no tienen fila en la planilla todavía (cargá primero el FFN de esa semana).";
    toast(msg);
  }

  document.getElementById("btnLoadCartera").addEventListener("click", function(){
    document.getElementById("carteraFileInput").click();
  });
  document.getElementById("carteraFileInput").addEventListener("change", async function(evt){
    var file = evt.target.files[0];
    evt.target.value = "";
    if (!file) return;
    try{
      var wb = await readWorkbook(file);
      lastCarteraWorkbook = wb;
      var parsed = extractCarteraWorkbook(wb);
      if (!parsed.sheetsUsed.length){
        toast("No encontré hojas con el formato de cartera esperado (fecha + vencimientos por semana).");
        return;
      }
      await mergeCartera(parsed, parsed.sheetsUsed.join(" + "));
    }catch(e){
      toast("No se pudo leer el archivo. ¿Es un .xlsx válido?");
    }
  });

  /* ---------------- clock ---------------- */
  function renderClock(){
    var el = document.getElementById("todayLine");
    var now = new Date();
    el.textContent = now.toLocaleDateString("es-AR", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
  }

  function renderAll(){
    var series = buildSeries();
    renderPosPanel();
    renderKPIs(series);
    renderLegend();
    renderTable(series);
    renderChartMain(series);
    renderChartPos(series);
    renderChartGap(series);
    renderChartComp(series);
  }

  async function bootData(){
    weeks = await fetchWeeks();
    posicionHoy = await fetchPosicion();
    renderClock();
    renderAll();
  }

  /* ---------------- auth ---------------- */
  function showLogin(){
    document.getElementById("loginScreen").hidden = false;
    document.getElementById("appScreen").hidden = true;
  }
  function showApp(session){
    document.getElementById("loginScreen").hidden = true;
    document.getElementById("appScreen").hidden = false;
    document.getElementById("userLine").textContent = session.user.email;
    bootData();
  }

  document.getElementById("loginForm").addEventListener("submit", async function(e){
    e.preventDefault();
    var email = document.getElementById("loginEmail").value.trim();
    var password = document.getElementById("loginPassword").value;
    var btn = document.getElementById("loginSubmit");
    var errEl = document.getElementById("loginError");
    errEl.classList.remove("show");
    btn.disabled = true; btn.textContent = "Entrando...";
    var res = await supa.auth.signInWithPassword({ email: email, password: password });
    btn.disabled = false; btn.textContent = "Entrar";
    if (res.error){
      errEl.textContent = "Mail o contraseña incorrectos.";
      errEl.classList.add("show");
    }
  });

  document.getElementById("btnLogout").addEventListener("click", async function(){
    await supa.auth.signOut();
  });

  supa.auth.onAuthStateChange(function(event, session){
    if (session) showApp(session); else showLogin();
  });

  supa.auth.getSession().then(function(res){
    if (res.data.session) showApp(res.data.session); else showLogin();
  });

})();
