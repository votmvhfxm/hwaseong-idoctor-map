/**
 * js/policy.js — 정책 뷰 전용 로직: 공백 우선순위, 배치 시뮬레이션, 등시간대 반경 토글, 24시간 커버리지 트렌드.
 * citizen.js를 직접 참조하지 않는다. 공통 상태·계산은 js/shared.js(window.Shared)를 통해서만 접근한다.
 */
(function(){
  "use strict";
  const S = window.Shared;

  /** 이 시각 기준 공백(미커버) zone을 인구 많은 순으로 정렬 */
  function gapZones(){
    return S.zones.filter(z => !S.zoneCovered(z.id)).sort((a,b) => b.pop-a.pop);
  }

  function renderRank(){
    const wrap = document.getElementById("rank");
    const gaps = gapZones();
    wrap.innerHTML = "";
    if (gaps.length===0) { wrap.innerHTML = '<div class="empty">이 시각엔 모든 지역이 커버돼요.</div>'; }
    gaps.forEach((z,i)=>{
      const row = document.createElement("div"); row.className = "rankrow";
      row.innerHTML = '<span class="r">'+(i+1)+'</span><span class="z">'+z.name+
        '</span><span class="p">영유아 '+z.pop+' · 공백</span>';
      wrap.appendChild(row);
    });
    const sel = document.getElementById("simZone");
    const prev = sel.value;
    sel.innerHTML = "";
    gaps.forEach(z=>{
      const o = document.createElement("option");
      o.value = z.id; o.textContent = z.name+" (영유아 "+z.pop+")";
      sel.appendChild(o);
    });
    if (gaps.length===0) {
      const o = document.createElement("option");
      o.textContent = "공백 지역 없음"; o.disabled = true;
      sel.appendChild(o);
    }
    if ([...sel.options].some(o => o.value===prev)) sel.value = prev;
  }

  document.getElementById("simAdd").addEventListener("click", ()=>{
    const sel = document.getElementById("simZone");
    if (!sel.value) return;
    const before = S.coveragePct();
    S.state.extraNight.add(sel.value);
    const after = S.coveragePct();
    const name = S.zoneById[sel.value] ? S.zoneById[sel.value].name : "";
    const out = document.getElementById("simOut");
    out.className = "simout show";
    out.innerHTML = '<b>'+name+'</b>에 야간진료 추가 시 커버리지 '+before+'% → '+after+
      '% <span class="delta">(+'+(after-before)+'%p)</span>';
    S.refresh();
  });
  document.getElementById("simReset").addEventListener("click", ()=>{
    S.state.extraNight.clear();
    document.getElementById("simOut").className = "simout";
    S.refresh();
  });

  // ---- 등시간대(isochrone) 반경 토글 ----
  const isoToggle = document.getElementById("isoToggle");
  isoToggle.addEventListener("change", ()=>{ S.setIsochronesVisible(isoToggle.checked); });

  // ---- 24시간 커버리지 트렌드 스파크라인 ----
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
    S.setIsochronesVisible(isoToggle.checked);
  }

  S.registerView("policy", {
    onShow(){
      document.getElementById("trendWrap").hidden = false;
      if (isoToggle.checked) S.setIsochronesVisible(true);
    },
    onHide(){
      document.getElementById("trendWrap").hidden = true;
      S.setIsochronesVisible(false);
    },
    render: renderPolicyView,
  });
})();
