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

  function emptyPosicion(){ return { banco: null, cartera: null, depositos: null, nrd: null, fecha: null, updatedAt: null }; }

  function rowToWeek(r){
    return {
      id: r.id,
      start: r.start_date,
      pagos: Number(r.pagos)||0,
      objetivo: Number(r.objetivo)||0,
      objetivoCustom: !!r.objetivo_custom,
      cartera: r.techo_cartera === null ? null : Number(r.techo_cartera),
      ffnProy: r.cobranza_ffn === null ? null : Number(r.cobranza_ffn),
      real: r.cobranza_real === null ? null : Number(r.cobranza_real),
      updatedAt: r.updated_at || null
    };
  }

  function fmtUpdatedAt(dateLike){
    if (!dateLike) return "Sin datos cargados todavía";
    var d = new Date(dateLike);
    return "Última actualización: " + d.toLocaleDateString("es-AR", { day:"numeric", month:"short" }) + ", " + d.toLocaleTimeString("es-AR", {hour:"2-digit", minute:"2-digit"});
  }
  function maxUpdatedAt(list, field){
    var latest = null;
    list.forEach(function(item){
      var v = field ? item[field] : item;
      if (!v) return;
      var d = new Date(v);
      if (!latest || d > latest) latest = d;
    });
    return latest;
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
      fecha: res.data.fecha,
      updatedAt: res.data.updated_at || null
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

  /* ---------------- clientes (análisis de cartera / mora) ---------------- */
  var clientes = [];
  var clientesLoaded = false;
  var clientesSort = { field: "tot_credito", dir: "desc" };
  var clientesSearchDebounce = null;

  var nfARS = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });
  function fmtARS(v){
    if (v === null || v === undefined || isNaN(v)) return "—";
    return "$ " + nfARS.format(v);
  }

  async function fetchClientes(){
    var all = [];
    var page = 1000, from = 0;
    while (true){
      var res = await supa.from("clientes_credito").select("*").range(from, from + page - 1);
      if (res.error){ toast("No se pudo cargar clientes: " + res.error.message); break; }
      all = all.concat(res.data);
      if (res.data.length < page) break;
      from += page;
    }
    return all;
  }

  function rawLabel(s){ return (s||"").toString().toLowerCase().trim(); }

  function extractClientesWorkbook(wb, sheetName){
    sheetName = sheetName || wb.SheetNames[0];
    var rows = sheetRows(wb, sheetName);
    var headerIdx = -1, header = null;
    for (var i=0;i<rows.length;i++){
      var r = rows[i];
      if (!r) continue;
      if (r.some(function(c){ return rawLabel(c) === "cliente"; })){ headerIdx = i; header = r; break; }
    }
    if (headerIdx === -1) throw new Error("no encontré la fila de encabezados (columna 'Cliente')");

    var col = {};
    header.forEach(function(cell, idx){
      var n = rawLabel(cell);
      if (n === "id") col.id = idx;
      else if (n === "cliente") col.cliente = idx;
      else if (n === "cadena") col.cadena = idx;
      else if (n === "zona") col.zona = idx;
      else if (n === "zona comercial") col.zona_comercial = idx;
      else if (n === "prov." || n === "prov") col.provincia = idx;
      else if (n === "activo") col.activo = idx;
      else if (/^d.as mora$/.test(n)) col.dias_mora = idx;
      else if (n === "% mora") col.pct_mora = idx;
      else if (n === "venci men 30") col.venci_30 = idx;
      else if (n === "venci men 60") col.venci_60 = idx;
      else if (n === "venci men 90") col.venci_90 = idx;
      else if (n.indexOf("venci may") === 0) col.venci_may90 = idx;
      else if (n === "no vdos") col.no_vencido = idx;
      else if (n === "sin res") col.sin_res = idx;
      else if (n.indexOf("tot") !== -1 && n.indexOf("credito") !== -1) col.tot_credito = idx;
    });

    var required = ["id","cliente","venci_30","venci_60","venci_90","venci_may90","tot_credito"];
    var missing = required.filter(function(k){ return col[k] === undefined; });
    if (missing.length) throw new Error("no encontré estas columnas: " + missing.join(", "));

    function num(v){ return (v === null || v === undefined || v === "") ? 0 : (Number(v)||0); }
    function txt(v){ return (v === null || v === undefined) ? null : String(v).replace(/�/g, "Ñ").trim(); }

    var out = [];
    for (var j=headerIdx+1;j<rows.length;j++){
      var row = rows[j];
      if (!row) continue;
      var clienteVal = row[col.cliente];
      var idVal = row[col.id];
      if (clienteVal === null || clienteVal === undefined || clienteVal === "") continue;
      if (idVal === null || idVal === undefined) continue;
      out.push({
        id: Number(idVal),
        cliente: txt(clienteVal),
        cadena: col.cadena !== undefined ? txt(row[col.cadena]) : null,
        zona: col.zona !== undefined ? txt(row[col.zona]) : null,
        zona_comercial: col.zona_comercial !== undefined ? txt(row[col.zona_comercial]) : null,
        provincia: col.provincia !== undefined ? txt(row[col.provincia]) : null,
        activo: col.activo !== undefined ? (row[col.activo] === "SI") : null,
        dias_mora: col.dias_mora !== undefined ? Math.round(num(row[col.dias_mora])) : null,
        pct_mora: col.pct_mora !== undefined ? num(row[col.pct_mora]) : null,
        venci_30: num(row[col.venci_30]),
        venci_60: num(row[col.venci_60]),
        venci_90: num(row[col.venci_90]),
        venci_may90: num(row[col.venci_may90]),
        no_vencido: col.no_vencido !== undefined ? num(row[col.no_vencido]) : 0,
        sin_res: col.sin_res !== undefined ? num(row[col.sin_res]) : 0,
        tot_credito: num(row[col.tot_credito])
      });
    }
    return out;
  }

  async function mergeClientes(rows, sourceLabel){
    await supa.from("clientes_credito").delete().neq("id", -1);
    var CHUNK = 500;
    for (var i=0;i<rows.length;i+=CHUNK){
      var chunk = rows.slice(i, i+CHUNK);
      var res = await supa.from("clientes_credito").insert(chunk);
      if (res.error){ toast("Error cargando clientes (fila ~" + i + "): " + res.error.message); return; }
    }
    clientes = await fetchClientes();
    clientesLoaded = true;
    document.getElementById("clientesFecha").textContent = clientes.length + " clientes · " + fmtUpdatedAt(maxUpdatedAt(clientes, "updated_at"));
    renderClientesAll();
    toast(rows.length + " clientes cargados en la base compartida.");
  }

  document.getElementById("btnLoadClientes").addEventListener("click", function(){
    document.getElementById("clientesFileInput").click();
  });
  document.getElementById("clientesFileInput").addEventListener("change", async function(evt){
    var file = evt.target.files[0];
    evt.target.value = "";
    if (!file) return;
    toast("Leyendo archivo, puede tardar unos segundos...");
    try{
      var wb = await readWorkbook(file);
      var parsed = extractClientesWorkbook(wb);
      await mergeClientes(parsed, file.name);
    }catch(e){
      toast("No se pudo procesar el archivo: " + e.message);
    }
  });

  function clientesBucketTotals(){
    var t = { b30:0, b60:0, b90:0, bmay90:0, n30:0, n60:0, n90:0, nmay90:0, nMora:0 };
    clientes.forEach(function(c){
      if (c.venci_30 > 0){ t.b30 += c.venci_30; t.n30++; }
      if (c.venci_60 > 0){ t.b60 += c.venci_60; t.n60++; }
      if (c.venci_90 > 0){ t.b90 += c.venci_90; t.n90++; }
      if (c.venci_may90 > 0){ t.bmay90 += c.venci_may90; t.nmay90++; }
      if ((c.venci_30||0)+(c.venci_60||0)+(c.venci_90||0)+(c.venci_may90||0) > 0) t.nMora++;
    });
    return t;
  }

  var BUCKET_META = {
    "30":    { field: "venci_30",    label: "1-30 días",   stripe: "stripe-good" },
    "60":    { field: "venci_60",    label: "31-60 días",  stripe: "stripe-warning" },
    "90":    { field: "venci_90",    label: "61-90 días",  stripe: "stripe-warning" },
    "may90": { field: "venci_may90", label: "+90 días",    stripe: "stripe-critical" }
  };

  function renderKPIsClientes(){
    var row = document.getElementById("kpiClientesRow");
    row.innerHTML = "";
    if (!clientes.length){
      row.innerHTML = '<div class="kpi"><div class="label">Sin datos</div><div class="value">—</div><div class="sub">Cargá el archivo de análisis de clientes</div></div>';
      return;
    }
    var t = clientesBucketTotals();
    var totalVencido = t.b30 + t.b60 + t.b90 + t.bmay90;
    var filtro = document.getElementById("clientesFiltro").value;
    var bucket = BUCKET_META[filtro];
    var cards;

    if (bucket){
      var field = bucket.field;
      var enRango = clientes.filter(function(c){ return (c[field]||0) > 0; });
      var monto = enRango.reduce(function(a,c){ return a + (c[field]||0); }, 0);
      var top = enRango.slice().sort(function(a,b){ return (b[field]||0) - (a[field]||0); })[0];
      var pct = totalVencido ? (monto/totalVencido*100) : 0;

      cards = [
        { label: "Clientes en " + bucket.label, value: enRango.length.toLocaleString("es-AR"), sub: "de " + clientes.length.toLocaleString("es-AR") + " clientes totales", stripe: "" },
        { label: "Monto en " + bucket.label, value: fmtARS(monto), sub: pct.toFixed(1) + "% del total vencido", stripe: bucket.stripe },
        { label: "Cliente más grande", value: top ? top.cliente : "—", sub: top ? fmtARS(top[field]) : "", stripe: bucket.stripe },
        { label: "Días mora promedio", value: enRango.length ? Math.round(enRango.reduce(function(a,c){ return a+(c.dias_mora||0); },0)/enRango.length).toLocaleString("es-AR") : "—", sub: "en este rango", stripe: "" }
      ];
    } else {
      var topMora = clientes.slice().sort(function(a,b){ return (b.venci_may90||0) - (a.venci_may90||0); })[0];
      cards = [
        { label: "Clientes en mora", value: t.nMora.toLocaleString("es-AR"), sub: "de " + clientes.length.toLocaleString("es-AR") + " clientes totales", stripe: "" },
        { label: "Total vencido", value: fmtARS(totalVencido), sub: "suma de los 4 rangos", stripe: "stripe-warning" },
        { label: "Monto +90 días", value: fmtARS(t.bmay90), sub: t.nmay90 + " cliente(s) en este rango", stripe: "stripe-critical" },
        { label: "Cliente más atrasado", value: topMora ? topMora.cliente : "—", sub: topMora ? (fmtARS(topMora.venci_may90) + " · " + (topMora.dias_mora||0) + " días") : "", stripe: "stripe-critical" }
      ];
    }

    cards.forEach(function(c){
      var div = document.createElement("div");
      div.className = "kpi " + (c.stripe||"");
      div.innerHTML = '<div class="label">'+c.label+'</div><div class="value" style="font-size:20px;">'+c.value+'</div><div class="sub">'+c.sub+'</div>';
      row.appendChild(div);
    });
  }

  function renderChartMora(){
    var svg = document.getElementById("chartMora");
    svg.innerHTML = "";
    if (!clientes.length){ svg.setAttribute("width",0); svg.setAttribute("height",0); return; }

    var t = clientesBucketTotals();
    var data = [
      { label: "1-30 días", v: t.b30, n: t.n30, color: "var(--good)" },
      { label: "31-60 días", v: t.b60, n: t.n60, color: "var(--warning)" },
      { label: "61-90 días", v: t.b90, n: t.n90, color: "var(--warning)" },
      { label: "+90 días", v: t.bmay90, n: t.nmay90, color: "var(--critical)" }
    ];

    var barW = 90, groupW = 150, padL = 80, padR = 20, padT = 30, padB = 34;
    var h = 220;
    var w = padL + padR + data.length*groupW;
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);

    var maxVal = Math.max.apply(null, data.map(function(d){ return d.v; }).concat([1])) * 1.15;
    var plotH = h - padT - padB;
    function y(v){ return padT + plotH - (v/maxVal)*plotH; }

    var ticks = 4;
    for (var t2=0;t2<=ticks;t2++){
      var v = maxVal * t2/ticks;
      var yy = y(v);
      svg.appendChild(svgEl("line", {x1:padL, x2:w-padR, y1:yy, y2:yy, stroke:"var(--line)", "stroke-width":1}));
      var lbl = svgEl("text", {x:padL-10, y:yy+3, "text-anchor":"end", fill:"var(--muted)", "font-size":10, "font-family":"var(--font-mono)"});
      lbl.textContent = Math.round(v).toLocaleString("es-AR");
      svg.appendChild(lbl);
    }

    data.forEach(function(d, i){
      var gx = padL + i*groupW + (groupW-barW)/2;
      var barY = y(d.v);
      var rect = svgEl("rect", { x:gx, y:barY, width:barW, height: Math.max(plotH-(barY-padT),1.5), rx:6, fill:d.color, style:"cursor:pointer" });
      rect.addEventListener("mousemove", function(evt){
        showTip(evt, d.label, [fmtARS(d.v), d.n + " cliente(s)"]);
      });
      rect.addEventListener("mouseleave", hideTip);
      svg.appendChild(rect);

      var valLab = svgEl("text", {x: gx+barW/2, y: barY-9, "text-anchor":"middle", fill:"var(--ink)", "font-size":12.5, "font-weight":700, "font-family":"var(--font-mono)"});
      valLab.textContent = "$ " + (d.v/1e6).toLocaleString("es-AR", {maximumFractionDigits: 1}) + " M";
      svg.appendChild(valLab);

      var lab = svgEl("text", {x: gx+barW/2, y: h-14, "text-anchor":"middle", fill:"var(--ink-2)", "font-size":12, "font-weight":600, "font-family":"var(--font-body)"});
      lab.textContent = d.label;
      svg.appendChild(lab);
    });
  }

  function clientesFiltered(){
    var filtro = document.getElementById("clientesFiltro").value;
    var search = document.getElementById("clientesSearch").value.trim().toLowerCase();
    var list = clientes.filter(function(c){
      if (filtro === "mora") return (c.venci_30||0)+(c.venci_60||0)+(c.venci_90||0)+(c.venci_may90||0) > 0;
      if (filtro === "30") return (c.venci_30||0) > 0;
      if (filtro === "60") return (c.venci_60||0) > 0;
      if (filtro === "90") return (c.venci_90||0) > 0;
      if (filtro === "may90") return (c.venci_may90||0) > 0;
      return true;
    });
    if (search){
      list = list.filter(function(c){ return c.cliente && c.cliente.toLowerCase().indexOf(search) !== -1; });
    }
    var f = clientesSort.field, dir = clientesSort.dir === "asc" ? 1 : -1;
    list.sort(function(a,b){
      var av = a[f], bv = b[f];
      if (typeof av === "string" || typeof bv === "string"){
        av = (av||"").toString(); bv = (bv||"").toString();
        return av.localeCompare(bv) * dir;
      }
      return ((av||0) - (bv||0)) * dir;
    });
    return list;
  }

  function renderTablaClientes(){
    var tbody = document.getElementById("tbodyClientes");
    tbody.innerHTML = "";
    var list = clientesFiltered();

    document.getElementById("clientesCount").textContent = list.length.toLocaleString("es-AR") + " cliente(s) — montos en pesos";

    if (!list.length){
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 7;
      td.innerHTML = '<div class="empty-state">Sin resultados para este filtro/búsqueda.</div>';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    var frag = document.createDocumentFragment();
    list.forEach(function(c){
      var tr = document.createElement("tr");
      function cell(txt, cls){ var td = document.createElement("td"); if (cls) td.className = cls; td.textContent = txt; return td; }

      var tdCliente = document.createElement("td");
      tdCliente.className = "cliente-cell";
      tdCliente.title = (c.cliente || "—") + (c.zona ? " · " + c.zona : "");
      var nameLine = document.createElement("span");
      nameLine.textContent = c.cliente || "—";
      tdCliente.appendChild(nameLine);
      if (c.zona){
        var zonaLine = document.createElement("span");
        zonaLine.className = "zona-sub";
        zonaLine.textContent = c.zona;
        tdCliente.appendChild(zonaLine);
      }
      tr.appendChild(tdCliente);

      tr.appendChild(cell(c.venci_30 > 0 ? fmtARS(c.venci_30) : "—", "num auto-val"));
      tr.appendChild(cell(c.venci_60 > 0 ? fmtARS(c.venci_60) : "—", "num auto-val"));
      tr.appendChild(cell(c.venci_90 > 0 ? fmtARS(c.venci_90) : "—", "num auto-val"));
      var tdMay90 = cell(c.venci_may90 > 0 ? fmtARS(c.venci_may90) : "—", "num");
      if (c.venci_may90 > 0) tdMay90.style.color = "var(--critical)";
      tdMay90.style.fontWeight = "600";
      tr.appendChild(tdMay90);
      tr.appendChild(cell(c.dias_mora !== null ? c.dias_mora.toLocaleString("es-AR") : "—", "num auto-val"));
      tr.appendChild(cell(fmtARS(c.tot_credito), "num auto-val"));
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  function renderSortArrows(){
    document.querySelectorAll("#tablaClientes th[data-sort]").forEach(function(th){
      var base = th.textContent.replace(/[▲▼]\s*$/,"").trim();
      if (th.dataset.sort === clientesSort.field){
        th.innerHTML = base + '<span class="sort-arrow">' + (clientesSort.dir === "asc" ? "▲" : "▼") + '</span>';
      } else {
        th.textContent = base;
      }
    });
  }

  function renderClientesAll(){
    renderKPIsClientes();
    renderChartMora();
    renderSortArrows();
    renderTablaClientes();
  }

  document.querySelectorAll("#tablaClientes th[data-sort]").forEach(function(th){
    th.addEventListener("click", function(){
      var field = th.dataset.sort;
      if (clientesSort.field === field){
        clientesSort.dir = clientesSort.dir === "asc" ? "desc" : "asc";
      } else {
        clientesSort.field = field;
        clientesSort.dir = (field === "cliente" || field === "zona") ? "asc" : "desc";
      }
      renderSortArrows();
      renderTablaClientes();
    });
  });
  document.getElementById("clientesFiltro").addEventListener("change", function(){
    renderKPIsClientes();
    renderTablaClientes();
  });
  document.getElementById("clientesSearch").addEventListener("input", function(){
    clearTimeout(clientesSearchDebounce);
    clientesSearchDebounce = setTimeout(renderTablaClientes, 200);
  });

  /* ---------------- campañas (envíos masivos de cobranza) ---------------- */
  var MENSAJE_DEFAULT = {
    "30": "Hola {{nombre}}! Te escribimos de Cofarsur para recordarte que tenés un saldo pendiente de {{monto}}. Cualquier consulta o si ya lo abonaste, avisanos. ¡Gracias!",
    "60": "Hola {{nombre}}, desde Cofarsur nos comunicamos porque registrás una deuda de {{monto}} con más de 30 días de atraso. Te pedimos que regularices tu cuenta a la brevedad para poder seguir operando sin inconvenientes. Ante cualquier duda, contactanos.",
    "90": "Hola {{nombre}}, te contactamos de Cofarsur. Tu cuenta presenta un saldo vencido de {{monto}} con {{dias_mora}} días de atraso. Es importante que te pongas al día a la brevedad para evitar la suspensión de tu línea de crédito. Esperamos tu respuesta.",
    "may90": "Hola {{nombre}}, nos comunicamos de Cofarsur respecto a tu cuenta con un saldo vencido de {{monto}} y {{dias_mora}} días de mora. De no regularizar la situación en los próximos días, nos veremos obligados a girar tu caso a nuestro estudio jurídico para iniciar las acciones legales correspondientes. Te pedimos que te comuniques a la brevedad para evitar esta instancia."
  };
  var RESULTADO_OPTS = [
    { value: "", label: "Pendiente" },
    { value: "pago", label: "Pagó" },
    { value: "promesa", label: "Prometió pago" },
    { value: "sin_respuesta", label: "Sin respuesta" }
  ];

  var loteActual = null;
  var ultimoContacto = {};
  var campanasCache = [];
  var campanasLoaded = false;

  function componerMensaje(template, cliente){
    return (template||"")
      .replace(/\{\{nombre\}\}/g, cliente.cliente || "")
      .replace(/\{\{monto\}\}/g, fmtARS(cliente.monto))
      .replace(/\{\{dias_mora\}\}/g, String(cliente.dias_mora||0));
  }

  async function cargarUltimoContacto(){
    var resCamp = await supa.from("campanas").select("id, created_at");
    var fechaPorCampana = {};
    (resCamp.data||[]).forEach(function(c){ fechaPorCampana[c.id] = c.created_at; });
    var resCli = await supa.from("campana_clientes").select("cliente_id, campana_id");
    var map = {};
    (resCli.data||[]).forEach(function(row){
      var f = fechaPorCampana[row.campana_id];
      if (!f) return;
      if (!map[row.cliente_id] || new Date(f) > new Date(map[row.cliente_id])) map[row.cliente_id] = f;
    });
    ultimoContacto = map;
  }

  document.getElementById("campRango").addEventListener("change", function(){
    document.getElementById("campMensaje").value = MENSAJE_DEFAULT[this.value] || "";
  });
  document.getElementById("campMensaje").value = MENSAJE_DEFAULT["may90"];

  document.getElementById("btnArmarLote").addEventListener("click", function(){
    if (!clientes.length){ toast("Primero cargá el análisis de clientes."); return; }
    var rango = document.getElementById("campRango").value;
    var batchSize = Math.max(1, Number(document.getElementById("campBatchSize").value)||150);
    var cooldown = Math.max(0, Number(document.getElementById("campCooldown").value)||0);
    var bucket = BUCKET_META[rango];
    var field = bucket.field;
    var now = Date.now();

    var elegibles = clientes.filter(function(c){
      if (!((c[field]||0) > 0)) return false;
      var last = ultimoContacto[c.id];
      if (!last) return true;
      var dias = (now - new Date(last).getTime()) / 86400000;
      return dias >= cooldown;
    });
    elegibles.sort(function(a,b){
      var sa = (a[field]||0) * (a.dias_mora||1);
      var sb = (b[field]||0) * (b.dias_mora||1);
      return sb - sa;
    });
    var seleccion = elegibles.slice(0, batchSize);

    loteActual = seleccion.map(function(c){
      return { id: c.id, cliente: c.cliente, telefono: c.telefono || null, monto: c[field]||0, dias_mora: c.dias_mora||0 };
    });

    renderKPIsCampana(rango, elegibles.length);
    renderLote();
    document.getElementById("panelMensaje").hidden = false;
    document.getElementById("panelLote").hidden = false;
    toast(loteActual.length + " clientes seleccionados para el rango " + bucket.label + (elegibles.length > batchSize ? " (había " + elegibles.length + " elegibles, se tomaron los " + batchSize + " de mayor prioridad)" : "."));
  });

  function renderKPIsCampana(rango, elegiblesCount){
    var row = document.getElementById("kpiCampanaRow");
    row.innerHTML = "";
    if (!loteActual || !loteActual.length){ return; }
    var montoTotal = loteActual.reduce(function(a,c){ return a + c.monto; }, 0);
    var sinTel = loteActual.filter(function(c){ return !c.telefono; }).length;
    var diasProm = Math.round(loteActual.reduce(function(a,c){ return a + c.dias_mora; }, 0) / loteActual.length);
    var cards = [
      { label: "Clientes en el lote", value: loteActual.length.toLocaleString("es-AR"), sub: elegiblesCount + " elegibles en total para este rango", stripe: "stripe-accent" },
      { label: "Monto del lote", value: fmtARS(montoTotal), sub: "suma de los " + loteActual.length + " clientes", stripe: "stripe-warning" },
      { label: "Días de mora promedio", value: diasProm.toLocaleString("es-AR"), sub: "en este lote", stripe: "" },
      { label: "Sin teléfono cargado", value: sinTel.toLocaleString("es-AR"), sub: sinTel ? "vas a tener que completarlos a mano" : "todos tienen teléfono", stripe: sinTel ? "stripe-warning" : "stripe-good" }
    ];
    cards.forEach(function(c){
      var div = document.createElement("div");
      div.className = "kpi " + (c.stripe||"");
      div.innerHTML = '<div class="label">'+c.label+'</div><div class="value" style="font-size:20px;">'+c.value+'</div><div class="sub">'+c.sub+'</div>';
      row.appendChild(div);
    });
  }

  function renderLote(){
    var tbody = document.getElementById("tbodyLote");
    tbody.innerHTML = "";
    var template = document.getElementById("campMensaje").value;
    document.getElementById("loteResumen").textContent = loteActual.length + " cliente(s) · vista previa del mensaje para el primero: \"" + (loteActual[0] ? componerMensaje(template, loteActual[0]).slice(0,90) + "..." : "") + "\"";
    loteActual.forEach(function(c, idx){
      var tr = document.createElement("tr");
      var tdCliente = document.createElement("td");
      tdCliente.className = "cliente-cell";
      tdCliente.textContent = c.cliente + (c.telefono ? "" : " (sin teléfono)");
      if (!c.telefono) tdCliente.style.color = "var(--muted)";
      tr.appendChild(tdCliente);
      var tdMonto = document.createElement("td"); tdMonto.className = "num auto-val"; tdMonto.textContent = fmtARS(c.monto);
      tr.appendChild(tdMonto);
      var tdDias = document.createElement("td"); tdDias.className = "num auto-val"; tdDias.textContent = c.dias_mora;
      tr.appendChild(tdDias);
      var tdDel = document.createElement("td");
      var btnDel = document.createElement("button");
      btnDel.className = "danger-ghost"; btnDel.textContent = "✕"; btnDel.title = "Sacar del lote";
      btnDel.addEventListener("click", function(){
        loteActual.splice(idx,1);
        renderLote();
      });
      tdDel.appendChild(btnDel);
      tr.appendChild(tdDel);
      tbody.appendChild(tr);
    });
  }

  document.getElementById("campMensaje").addEventListener("input", function(){
    if (loteActual && loteActual.length) renderLote();
  });

  document.getElementById("btnDescargarLote").addEventListener("click", function(){
    if (!loteActual || !loteActual.length) return;
    var template = document.getElementById("campMensaje").value;
    var rows = loteActual.map(function(c){
      return { Cliente: c.cliente, Telefono: c.telefono || "", Monto: c.monto, DiasMora: c.dias_mora, Mensaje: componerMensaje(template, c) };
    });
    var ws = XLSX.utils.json_to_sheet(rows);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Lote");
    var rango = document.getElementById("campRango").value;
    XLSX.writeFile(wb, "campana-" + rango + "-" + toISO(new Date()) + ".xlsx");
    toast("Excel descargado.");
  });

  document.getElementById("btnConfirmarEnvio").addEventListener("click", async function(){
    if (!loteActual || !loteActual.length) return;
    if (!confirm("¿Marcar esta campaña de " + loteActual.length + " clientes como enviada? No se va a poder deshacer.")) return;
    var rango = document.getElementById("campRango").value;
    var template = document.getElementById("campMensaje").value;
    var montoTotal = loteActual.reduce(function(a,c){ return a + c.monto; }, 0);
    var diasMin = Math.min.apply(null, loteActual.map(function(c){ return c.dias_mora; }));
    var montoMin = Math.min.apply(null, loteActual.map(function(c){ return c.monto; }));

    var session = await supa.auth.getSession();
    var email = session.data.session ? session.data.session.user.email : null;

    var resCamp = await supa.from("campanas").insert({
      rango: rango,
      monto_min: montoMin,
      dias_min: diasMin,
      batch_size: loteActual.length,
      mensaje_template: template,
      cantidad_clientes: loteActual.length,
      monto_total: montoTotal,
      creado_por: email
    }).select().single();

    if (resCamp.error){ toast("Error creando la campaña: " + resCamp.error.message); return; }
    var campanaId = resCamp.data.id;

    var payload = loteActual.map(function(c){
      return {
        campana_id: campanaId,
        cliente_id: c.id,
        cliente_nombre: c.cliente,
        telefono: c.telefono,
        monto: c.monto,
        dias_mora: c.dias_mora,
        mensaje: componerMensaje(template, c)
      };
    });
    var CHUNK = 500;
    for (var i=0;i<payload.length;i+=CHUNK){
      var res = await supa.from("campana_clientes").insert(payload.slice(i, i+CHUNK));
      if (res.error){ toast("Error guardando clientes de la campaña: " + res.error.message); return; }
    }

    await cargarUltimoContacto();
    loteActual = null;
    document.getElementById("panelMensaje").hidden = true;
    document.getElementById("panelLote").hidden = true;
    document.getElementById("kpiCampanaRow").innerHTML = "";
    campanasLoaded = false;
    await cargarHistorialCampanas();
    toast("Campaña registrada. Ya no se van a repetir estos clientes hasta pasado el enfriamiento.");
  });

  async function cargarHistorialCampanas(){
    if (campanasLoaded) return;
    campanasLoaded = true;
    var res = await supa.from("campanas").select("*").order("created_at", { ascending: false });
    campanasCache = res.data || [];
    renderHistorialCampanas();
    var latest = maxUpdatedAt(campanasCache, "created_at");
    document.getElementById("campanasUpdated").textContent = campanasCache.length ? fmtUpdatedAt(latest) : "Todavía no armaste ninguna campaña.";
  }

  function renderHistorialCampanas(){
    var cont = document.getElementById("historialCampanas");
    cont.innerHTML = "";
    if (!campanasCache.length){
      cont.innerHTML = '<div class="empty-state">Todavía no se armó ninguna campaña.</div>';
      return;
    }
    campanasCache.forEach(function(camp){
      var bucket = BUCKET_META[camp.rango];
      var card = document.createElement("div");
      card.className = "campana-card";
      var d = new Date(camp.created_at);
      var fecha = d.toLocaleDateString("es-AR", {day:"numeric", month:"short", year:"numeric"}) + " " + d.toLocaleTimeString("es-AR", {hour:"2-digit", minute:"2-digit"});
      card.innerHTML =
        '<div class="campana-card-head">' +
          '<div><div class="campana-card-info">' + fecha + ' · ' + (bucket?bucket.label:camp.rango) + ' · ' + camp.cantidad_clientes + ' clientes</div>' +
          '<div class="campana-card-sub">' + fmtARS(camp.monto_total) + ' en total' + (camp.creado_por ? ' · ' + camp.creado_por : '') + '</div></div>' +
          '<span class="sort-arrow">▼</span>' +
        '</div>' +
        '<div class="campana-detail" id="detalle-'+camp.id+'"></div>';
      card.querySelector(".campana-card-head").addEventListener("click", function(){
        toggleDetalleCampana(camp.id);
      });
      cont.appendChild(card);
    });
  }

  async function toggleDetalleCampana(campanaId){
    var el = document.getElementById("detalle-"+campanaId);
    var isOpen = el.classList.contains("open");
    if (isOpen){ el.classList.remove("open"); return; }
    if (!el.dataset.loaded){
      el.innerHTML = '<div class="empty-state">Cargando...</div>';
      el.classList.add("open");
      var res = await supa.from("campana_clientes").select("*").eq("campana_id", campanaId).order("monto", {ascending:false});
      var rows = res.data || [];
      var table = document.createElement("table");
      table.innerHTML =
        '<thead><tr><th>Cliente</th><th class="num">Monto</th><th class="num">Días mora</th><th>Resultado</th></tr></thead>';
      var tbody = document.createElement("tbody");
      rows.forEach(function(r){
        var tr = document.createElement("tr");
        var tdC = document.createElement("td"); tdC.className="cliente-cell"; tdC.textContent = r.cliente_nombre;
        tr.appendChild(tdC);
        var tdM = document.createElement("td"); tdM.className="num auto-val"; tdM.textContent = fmtARS(r.monto);
        tr.appendChild(tdM);
        var tdD = document.createElement("td"); tdD.className="num auto-val"; tdD.textContent = r.dias_mora;
        tr.appendChild(tdD);
        var tdR = document.createElement("td");
        var sel = document.createElement("select");
        sel.className = "resultado-select";
        RESULTADO_OPTS.forEach(function(opt){
          var o = document.createElement("option");
          o.value = opt.value; o.textContent = opt.label;
          if ((r.resultado||"") === opt.value) o.selected = true;
          sel.appendChild(o);
        });
        sel.addEventListener("change", async function(){
          await supa.from("campana_clientes").update({ resultado: sel.value || null, resultado_actualizado_at: new Date().toISOString() }).eq("id", r.id);
          toast("Resultado actualizado.");
        });
        tdR.appendChild(sel);
        tr.appendChild(tdR);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      el.innerHTML = "";
      el.appendChild(table);
      el.dataset.loaded = "1";
    } else {
      el.classList.add("open");
    }
  }

  /* ---------------- section tabs (segmented control) ---------------- */
  var TAB_SECTIONS = { dashboard: "tabDashboard", cobranzas: "tabCobranzas", clientes: "tabClientes", campanas: "tabCampanas" };
  function moveTabIndicator(btn){
    var indicator = document.getElementById("tabIndicator");
    if (!btn || !indicator) return;
    indicator.style.width = btn.offsetWidth + "px";
    indicator.style.transform = "translateX(" + btn.offsetLeft + "px)";
  }
  document.getElementById("tabNav").addEventListener("click", async function(e){
    var btn = e.target.closest(".tab-pill");
    if (!btn) return;
    var key = btn.dataset.tab;
    document.querySelectorAll(".tab-pill").forEach(function(p){ p.classList.toggle("active", p === btn); });
    Object.keys(TAB_SECTIONS).forEach(function(k){
      document.getElementById(TAB_SECTIONS[k]).hidden = (k !== key);
    });
    moveTabIndicator(btn);
    if ((key === "clientes" || key === "campanas") && !clientesLoaded){
      clientesLoaded = true;
      document.getElementById("clientesFecha").textContent = "Cargando...";
      clientes = await fetchClientes();
      document.getElementById("clientesFecha").textContent = clientes.length ? (clientes.length + " clientes · " + fmtUpdatedAt(maxUpdatedAt(clientes, "updated_at"))) : "Cargá el export de \"Análisis de clientes\" para completar esto.";
      renderClientesAll();
    }
    if (key === "campanas"){
      await cargarUltimoContacto();
      await cargarHistorialCampanas();
    }
  });
  window.addEventListener("resize", function(){
    moveTabIndicator(document.querySelector(".tab-pill.active"));
  });

  /* ---------------- clock ---------------- */
  function renderClock(){
    var el = document.getElementById("todayLine");
    var now = new Date();
    el.textContent = now.toLocaleDateString("es-AR", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
  }

  function renderUpdatedLines(){
    var latest = maxUpdatedAt(weeks, "updatedAt");
    if (posicionHoy.updatedAt){
      var pd = new Date(posicionHoy.updatedAt);
      if (!latest || pd > latest) latest = pd;
    }
    var txt = fmtUpdatedAt(latest);
    document.getElementById("dashUpdated").textContent = txt;
    document.getElementById("cobranzasUpdated").textContent = txt;
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
    renderUpdatedLines();
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
    requestAnimationFrame(function(){ moveTabIndicator(document.querySelector(".tab-pill.active")); });
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
