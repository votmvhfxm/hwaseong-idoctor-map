/**
 * js/policy.js - policy view logic: gap ranking, placement simulation,
 * isochrone toggle, 24-hour coverage trend, deterministic recommendations,
 * and Gemini-backed explanation of calculated scenarios.
 */
(function(){
  "use strict";
  const S = window.Shared;

  const recState = {
    count: 1,
    goal: "coverage",
    recommendations: [],
    selected: null,
    aiRequestId: 0,
  };
  const strategyLabels = {
    coverage: "커버리지형",
    balance: "균형형",
    vulnerable: "취약지 보완형",
  };
  const goalLabels = {
    coverage: "커버리지 최대화",
    balance: "지역 균형",
    vulnerable: "취약지역 우선",
  };
  const fmt = value => S.formatNumber ? S.formatNumber(value) : Number(value || 0).toLocaleString("ko-KR");
  const zoneChildPop = z => S.zoneDemand ? S.zoneDemand(z) : Number(z.childPop || z.childPopulation || z.pop || 0);

  function isPediatricClinic(c){
    const text = [
      c.type,
      c.name,
      Array.isArray(c.departments) ? c.departments.join(" ") : c.departments,
    ].filter(Boolean).join(" ");
    return /소아|청소년/.test(text);
  }

  function clinicsInZone(zid){
    return S.clinics.filter(c => (c.zone === zid || c.zoneId === zid) && isPediatricClinic(c));
  }

  function childrenPerClinic(z){
    const count = clinicsInZone(z.id).length;
    if (!count) return "없음";
    return fmt(Math.round(zoneChildPop(z) / count))+"명";
  }

  function gapZones(){
    return S.zones.filter(z => !S.zoneCovered(z.id)).sort((a,b) => zoneChildPop(b)-zoneChildPop(a));
  }

  function renderRank(){
    const wrap = document.getElementById("rank");
    const gaps = gapZones();
    wrap.innerHTML = "";
    if (gaps.length===0) wrap.innerHTML = '<div class="empty">이 시각에는 모든 지역이 커버돼요.</div>';
    gaps.forEach((z,i)=>{
      const row = document.createElement("div");
      row.className = "rankrow";
      const clinicCount = clinicsInZone(z.id).length;
      row.innerHTML =
        '<span class="r">'+(i+1)+'</span>'+
        '<span class="z">'+z.name+'</span>'+
        '<span class="p">0-9세 '+fmt(zoneChildPop(z))+'명 · 소아청소년과 '+clinicCount+'곳 · 1곳당 '+childrenPerClinic(z)+' · 공백</span>';
      wrap.appendChild(row);
    });
  }

  function combos(items, size, start, prefix, out){
    if (prefix.length === size) {
      out.push(prefix.slice());
      return out;
    }
    for (let i=start; i<items.length; i++) {
      prefix.push(items[i]);
      combos(items, size, i+1, prefix, out);
      prefix.pop();
    }
    return out;
  }

  function gapCount(extra){
    return S.zones.filter(z => !S.zoneCovered(z.id, S.state.hour, extra)).length;
  }

  function addedPop(combo){
    const beforeExtra = S.state.extraNight;
    const afterExtra = new Set([...beforeExtra, ...combo.map(z => z.id)]);
    return S.zones.reduce((sum, z) => {
      const before = S.zoneCovered(z.id, S.state.hour, beforeExtra);
      const after = S.zoneCovered(z.id, S.state.hour, afterExtra);
      return sum + (!before && after ? zoneChildPop(z) : 0);
    }, 0);
  }

  function sidePenalty(combo){
    const east = combo.filter(z => z.lng >= 127).length;
    const west = combo.length - east;
    return Math.abs(east - west);
  }

  function evaluateCombo(combo, strategy){
    const beforeExtra = S.state.extraNight;
    const afterExtra = new Set([...beforeExtra, ...combo.map(z => z.id)]);
    const beforeCoverage = S.coveragePct(S.state.hour, beforeExtra);
    const afterCoverage = S.coveragePct(S.state.hour, afterExtra);
    const beforeGaps = gapCount(beforeExtra);
    const afterGaps = gapCount(afterExtra);
    const added = addedPop(combo);
    let score = (afterCoverage - beforeCoverage) * 10 + (added / 1000) * 4 + (beforeGaps - afterGaps) * 5;
    if (strategy === "balance") score += (combo.length - sidePenalty(combo)) * 6;
    if (strategy === "vulnerable") score += combo.reduce((s,z)=>s + Math.pow(zoneChildPop(z) / 1000, 2), 0);
    return { strategy, zones: combo, beforeCoverage, afterCoverage, beforeGaps, afterGaps, added, score };
  }

  function buildRecommendations(){
    const gaps = gapZones();
    const candidates = gaps.length ? gaps : S.zones.slice().sort((a,b)=>zoneChildPop(b)-zoneChildPop(a));
    const size = Math.min(recState.count, candidates.length);
    const allCombos = combos(candidates, size, 0, [], []);
    const order = [recState.goal, "coverage", "balance", "vulnerable"].filter((v,i,a)=>a.indexOf(v)===i);
    const usedKeys = new Set();
    const picks = [];

    order.forEach(strategy=>{
      const best = allCombos.map(combo => evaluateCombo(combo, strategy)).sort((a,b)=>b.score-a.score)[0];
      if (!best) return;
      const key = best.zones.map(z=>z.id).sort().join("|");
      if (usedKeys.has(key)) return;
      usedKeys.add(key);
      picks.push(best);
    });

    allCombos
      .map(combo => evaluateCombo(combo, recState.goal))
      .sort((a,b)=>b.score-a.score)
      .forEach(item=>{
        if (picks.length >= 3) return;
        const key = item.zones.map(z=>z.id).sort().join("|");
        if (usedKeys.has(key)) return;
        usedKeys.add(key);
        picks.push(item);
      });

    recState.recommendations = picks.slice(0, 3);
    recState.selected = recState.recommendations[0] || null;
  }

  function scenarioPayload(rec, index){
    return {
      rank: index + 1,
      type: strategyLabels[rec.strategy],
      regions: rec.zones.map(z => z.name),
      currentCoverage: rec.beforeCoverage,
      afterCoverage: rec.afterCoverage,
      currentGapCount: rec.beforeGaps,
      afterGapCount: rec.afterGaps,
      addedChildPopulation: rec.added,
      regionsDetail: rec.zones.map(z => ({
        name: z.name,
        childPopulation: zoneChildPop(z),
        pediatricClinics: clinicsInZone(z.id).length,
        childrenPerClinic: childrenPerClinic(z),
        currentGap: !S.zoneCovered(z.id, S.state.hour, S.state.extraNight),
      })),
    };
  }

  function policyAiPayload(){
    return {
      hour: S.state.hour,
      objective: goalLabels[recState.goal],
      count: recState.count,
      currentCoverage: recState.selected ? recState.selected.beforeCoverage : S.coveragePct(),
      selectedScenario: recState.selected ? scenarioPayload(recState.selected, recState.recommendations.indexOf(recState.selected)) : null,
      scenarios: recState.recommendations.map(scenarioPayload),
    };
  }

  function renderAiPlaceholder(message, className){
    const box = document.getElementById("policyAiExplain");
    const body = document.getElementById("policyAiBody");
    if (!box || !body) return;
    box.classList.remove("loading", "error");
    if (className) box.classList.add(className);
    body.innerHTML = '<p>'+message+'</p>';
  }

  function renderAiInsight(data){
    const box = document.getElementById("policyAiExplain");
    const body = document.getElementById("policyAiBody");
    if (!box || !body) return;
    box.classList.remove("loading", "error");
    const reasons = Array.isArray(data.reasons) ? data.reasons : [];
    body.innerHTML =
      '<h3>'+escapeHtml(data.headline || "계산 결과 기반 정책 해석")+'</h3>'+
      '<p>'+escapeHtml(data.summary || "")+'</p>'+
      '<ul>'+reasons.map(reason => '<li>'+escapeHtml(reason)+'</li>').join("")+'</ul>'+
      '<p class="caution">'+escapeHtml(data.caution || "실제 정책 적용 전 의료기관 참여 의향, 예산, 인력 확보, 교통 접근성을 검토해야 합니다.")+'</p>';
  }

  function escapeHtml(value){
    return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  async function requestPolicyInsight(){
    if (!recState.selected || !recState.recommendations.length) return;
    const requestId = ++recState.aiRequestId;
    renderAiPlaceholder("AI가 계산 결과를 해석하고 있어요...", "loading");
    try {
      const res = await fetch("/api/policy-ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(policyAiPayload()),
      });
      if (!res.ok) throw new Error("HTTP "+res.status);
      const data = await res.json();
      if (requestId !== recState.aiRequestId) return;
      renderAiInsight(data);
    } catch (error) {
      if (requestId !== recState.aiRequestId) return;
      console.error(error);
      renderAiPlaceholder("AI 해석을 불러오지 못했습니다. 계산된 추천안은 정상 표시됩니다.", "error");
    }
  }

  function renderCompare(){
    const panel = document.getElementById("recCompare");
    const rec = recState.selected;
    if (!panel || !rec) return;
    panel.hidden = false;
    document.getElementById("cmpBefore").textContent = rec.beforeCoverage+"%";
    document.getElementById("cmpAfter").textContent = rec.afterCoverage+"%";
    document.getElementById("cmpGaps").textContent = rec.beforeGaps+"곳 → "+rec.afterGaps+"곳";
    document.getElementById("cmpAdded").textContent = "+"+fmt(rec.added)+"명";
  }

  function renderRecommendationCards(){
    const wrap = document.getElementById("recResults");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!recState.recommendations.length) {
      wrap.innerHTML = '<div class="empty">추천안 생성을 누르면 후보 조합 3개를 계산해요.</div>';
      document.getElementById("recCompare").hidden = true;
      S.setRecommendationZones([]);
      renderAiPlaceholder("계산 결과 기반 AI 해석은 추천안 생성 후 표시됩니다.");
      return;
    }

    recState.recommendations.forEach((rec, i)=>{
      const card = document.createElement("button");
      card.type = "button";
      card.className = "recCard" + (rec === recState.selected ? " active" : "");
      card.innerHTML =
        '<div class="recTop"><b>'+(i+1)+'안 · '+strategyLabels[rec.strategy]+'</b><span>+'+(rec.afterCoverage-rec.beforeCoverage)+'%p</span></div>'+
        '<div class="recZones">'+rec.zones.map(z=>z.name).join(" + ")+'</div>'+
        '<div class="recMetrics">'+
          '<div>현재 → 추천 후<b>'+rec.beforeCoverage+'% → '+rec.afterCoverage+'%</b></div>'+
          '<div>공백 지역<b>'+rec.beforeGaps+'곳 → '+rec.afterGaps+'곳</b></div>'+
          '<div>추가 커버 0-9세 인구<b>+'+fmt(rec.added)+'명</b></div>'+
          '<div>추천 지역 수<b>'+rec.zones.length+'곳</b></div>'+
        '</div>';
      card.addEventListener("click", ()=>{
        recState.selected = rec;
        renderRecommendationCards();
        renderCompare();
        S.setRecommendationZones(rec.zones.map(z=>z.id));
        requestPolicyInsight();
      });
      wrap.appendChild(card);
    });

    renderCompare();
    if (recState.selected) S.setRecommendationZones(recState.selected.zones.map(z=>z.id));
  }

  function setPressed(group, attr, value){
    group.querySelectorAll("button").forEach(btn=>{
      btn.setAttribute("aria-pressed", String(btn.dataset[attr] === String(value)));
    });
  }

  function setupRecommendations(){
    const countGroup = document.getElementById("recCountGroup");
    const goalGroup = document.getElementById("recGoalGroup");
    if (!countGroup || !goalGroup) return;

    countGroup.addEventListener("click", e=>{
      const btn = e.target.closest("button[data-count]");
      if (!btn) return;
      recState.count = Number(btn.dataset.count);
      setPressed(countGroup, "count", recState.count);
    });

    goalGroup.addEventListener("click", e=>{
      const btn = e.target.closest("button[data-goal]");
      if (!btn) return;
      recState.goal = btn.dataset.goal;
      setPressed(goalGroup, "goal", recState.goal);
    });

    document.getElementById("recRun").addEventListener("click", ()=>{
      buildRecommendations();
      renderRecommendationCards();
      requestPolicyInsight();
    });
  }

  function renderTrend(){
    const svgT = document.getElementById("trendSvg");
    const w = 240, h = 44, pad = 3;
    const pts = [];
    for (let hr=0; hr<24; hr++){
      const p = S.coveragePct(hr, S.state.extraNight);
      const x = pad + hr*((w-2*pad)/23);
      const y = h-pad - (p/100)*(h-2*pad);
      pts.push([x, y, p]);
    }
    const lineD = pts.map((pt,i)=> (i===0?"M":"L")+pt[0].toFixed(1)+","+pt[1].toFixed(1)).join(" ");
    const areaD = lineD+" L"+pts[23][0].toFixed(1)+","+(h-pad)+" L"+pts[0][0].toFixed(1)+","+(h-pad)+" Z";
    const cur = pts[S.state.hour];
    svgT.innerHTML =
      '<path class="trendarea" d="'+areaD+'"></path>'+
      '<path class="trendline" d="'+lineD+'"></path>'+
      '<line class="trendnow" x1="'+cur[0].toFixed(1)+'" y1="'+(pad-1)+'" x2="'+cur[0].toFixed(1)+'" y2="'+(h-pad)+'"></line>'+
      '<circle class="trenddot" cx="'+cur[0].toFixed(1)+'" cy="'+cur[1].toFixed(1)+'" r="2.2"></circle>';
    document.getElementById("trendNow").textContent = S.hh(S.state.hour)+" · "+Math.round(cur[2])+"%";
  }

  function renderPolicyView(){
    renderRank();
    renderTrend();
    if (recState.recommendations.length) {
      buildRecommendations();
      renderRecommendationCards();
    }
  }

  S.registerView("policy", {
    onShow(){
      document.getElementById("trendWrap").hidden = false;
      if (recState.selected) S.setRecommendationZones(recState.selected.zones.map(z=>z.id));
    },
    onHide(){
      document.getElementById("trendWrap").hidden = true;
      S.setRecommendationZones([]);
    },
    render: renderPolicyView,
  });

  setupRecommendations();
})();
