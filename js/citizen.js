/**
 * js/citizen.js — 시민 뷰 전용 로직: 빠른 선택/AI 문진 트리아지, 실시간 소아진료 안내.
 * policy.js를 직접 참조하지 않는다. 공통 상태·계산은 js/shared.js(window.Shared)를 통해서만 접근한다.
 */
(function(){
  "use strict";
  const S = window.Shared;
  const { symptoms, EMERGENCY_KEYWORDS } = window.AppData;

  const picked = new Set(); // 선택된 증상 라벨

  // ---- 빠른 선택 칩 ----
  const chipsWrap = document.getElementById("chips");
  symptoms.forEach(s=>{
    const b = document.createElement("button");
    b.className = "chip"+(s.danger ? " danger" : "");
    b.type = "button"; b.textContent = s.label; b.setAttribute("aria-pressed","false");
    b.addEventListener("click", ()=>{
      const on = b.getAttribute("aria-pressed")==="true";
      b.setAttribute("aria-pressed", String(!on));
      if (on) picked.delete(s.label); else picked.add(s.label);
      renderVerdict();
    });
    chipsWrap.appendChild(b);
  });

  function hasDanger(){ return symptoms.some(s => s.danger && picked.has(s.label)); }

  function renderVerdict(){
    const v = document.getElementById("verdict");
    if (picked.size===0) { v.className = "verdict"; v.innerHTML = ""; return; }
    if (hasDanger()) {
      v.className = "verdict emerg show";
      v.innerHTML = "<b>응급 신호 — 지금 응급실로 가세요</b>망설이지 말고 119 또는 소아응급 진료가 가능한 응급실로 이동하세요. 대기하지 마세요.";
    } else {
      v.className = "verdict mild show";
      v.innerHTML = "<b>경증으로 보여요 — 야간·주간 소아진료 권장</b>아래 지금 문 연 소아 진료기관에서 진료받을 수 있어요. 증상이 급격히 나빠지면 응급실로 가세요.";
    }
  }

  // ---- 이동시간: 내 위치 사용 후에만 서버리스 프록시(/api/directions)로 실이동시간 조회 ----
  let originCoord = null;
  let originIsLive = false;  // true면 실제 GPS 위치 기준
  const travelTimeCache = new Map(); // clinic -> {durationMin}
  const pendingFetches = new Set();  // clinic (중복 fetch 방지)
  const failedFetches = new Set();   // clinic (실패 후 재시도 안 함 — /api 미배포 상태에서 매 렌더마다 재요청 방지)

  function timeForClinic(c){
    const live = travelTimeCache.get(c);
    return live ? live.durationMin : null;
  }

  async function fetchTravelTime(c){
    if (!originIsLive || !originCoord) return;
    if (pendingFetches.has(c) || failedFetches.has(c)) return;
    pendingFetches.add(c);
    try {
      const coord = S.clinicLatLng(c);
      const url = "/api/directions?originLat="+originCoord.lat+"&originLng="+originCoord.lng+
        "&destLat="+coord.lat+"&destLng="+coord.lng;
      const res = await fetch(url);
      if (!res.ok) { failedFetches.add(c); return; } // 백엔드 미배포/오류 — 데모 값 유지, 재시도 안 함
      const data = await res.json();
      if (typeof data.durationMin === "number") {
        travelTimeCache.set(c, data);
        renderClinics(); // 실시간 값이 도착하면 정렬·표시 갱신
      } else {
        failedFetches.add(c);
      }
    } catch (e) {
      failedFetches.add(c); // 네트워크 오류/오프라인 — 데모 값으로 계속 진행, 재시도 안 함
    } finally {
      pendingFetches.delete(c);
    }
  }

  // ---- 파인더 툴바: 검색·정렬·필터 ----
  const FILTERS = [
    {id:"night",  label:"야간 가능"},
    {id:"dalbit", label:"달빛병원"},
    {id:"soon",   label:"마감 임박 제외"},
  ];
  const finderState = { search:"", sort:"dist", filters:new Set(), incClosed:false };
  const isPublicClinic = c => c.isPublic || c.source === "public-api" || c.source === "HIRA";
  const hasKnownHours = c => Boolean(c.hours) || (typeof c.open === "number" && typeof c.close === "number");
  const dayKey = d => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d.getDay()];
  const fmtTime = value => {
    const text = String(value || "").replace(/\D/g, "").padStart(4, "0").slice(0, 4);
    return text ? text.slice(0, 2)+":"+text.slice(2, 4) : "";
  };
  const minuteFromTime = value => {
    const text = String(value || "").replace(/\D/g, "").padStart(4, "0").slice(0, 4);
    return text ? Number(text.slice(0, 2)) * 60 + Number(text.slice(2, 4)) : null;
  };
  const todayHours = c => c.hours ? c.hours[dayKey(new Date())] : null;
  const closeHour = c => {
    const today = todayHours(c);
    if (today) {
      const minutes = minuteFromTime(today.end);
      return minutes == null ? null : minutes / 60;
    }
    return typeof c.close === "number" ? c.close : null;
  };
  const isNightClinic = c => {
    const close = closeHour(c);
    return close != null && close >= 21;
  };
  const closingSoon = c => {
    const close = closeHour(c);
    return close != null && S.isOpen(c) && (close - S.state.hour) <= 1;
  };
  const minutesUntilClose = c => {
    const close = closeHour(c);
    if (close == null || !S.isOpen(c)) return 9999;
    return Math.max(0, (close - S.state.hour) * 60);
  };
  const openStatusLabel = c => {
    if (!hasKnownHours(c) && c.todayOpen == null) return "확인 필요";
    return S.isOpen(c) ? "지금 진료 중" : "진료 종료";
  };
  const hoursLabel = c => {
    if (c.hours) {
      const today = c.hours[dayKey(new Date())];
      return today ? fmtTime(today.start)+"~"+fmtTime(today.end) : "진료시간 확인 필요";
    }
    return hasKnownHours(c) ? S.hh(c.open)+"~"+S.hh(c.close) : (c.openText || "진료시간 확인 필요");
  };

  function buildFinderControls(){
    const fc = document.getElementById("filterChips");
    FILTERS.forEach(f=>{
      const b = document.createElement("button");
      b.className = "fchip"; b.type = "button"; b.textContent = f.label;
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", ()=>{
        const on = b.getAttribute("aria-pressed")==="true";
        b.setAttribute("aria-pressed", String(!on));
        if (on) finderState.filters.delete(f.id); else finderState.filters.add(f.id);
        renderClinics();
      });
      fc.appendChild(b);
    });

    document.getElementById("clinicSearch").addEventListener("input", e=>{
      finderState.search = e.target.value.trim();
      renderClinics();
    });
    document.getElementById("sortSel").addEventListener("change", e=>{
      finderState.sort = e.target.value;
      renderClinics();
    });
    document.getElementById("incClosed").addEventListener("change", e=>{
      finderState.incClosed = e.target.checked;
      renderClinics();
    });
  }

  function filteredClinics(){
    let arr = S.clinics.slice();
    if (!finderState.incClosed) arr = arr.filter(c => S.isOpen(c) || (isPublicClinic(c) && !c.hours));
    if (finderState.filters.has("night")) arr = arr.filter(isNightClinic);
    if (finderState.filters.has("dalbit")) arr = arr.filter(c => c.type==="달빛");
    if (finderState.filters.has("soon")) arr = arr.filter(c => !closingSoon(c));
    if (finderState.search) arr = arr.filter(c => c.name.includes(finderState.search));
    if (finderState.sort==="soon") arr.sort((a,b)=>minutesUntilClose(a)-minutesUntilClose(b));
    else if (originIsLive) arr.sort((a,b)=>(timeForClinic(a) ?? 9999)-(timeForClinic(b) ?? 9999));
    return arr;
  }

  const ICON_HOSP = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 21V7l7-4 7 4v14" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 9v5M9.5 11.5h5" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>';

  // ---- 실시간 소아진료 안내 ----
  function renderClinics(){
    const list = document.getElementById("clinicList");
    const arr = filteredClinics();
    document.getElementById("resultCount").textContent = "총 "+arr.length+"곳 · "+(window.AppData.clinicDataMessage || "표본 데이터");
    list.innerHTML = "";
    if (arr.length===0) {
      list.innerHTML = '<div class="empty">조건에 맞는 곳이 없어요.<br/>필터를 줄이거나 \'닫힌 곳도 보기\'를 켜보세요.</div>';
      return;
    }
    arr.forEach(c=>{
      const open = S.isOpen(c);
      const publicClinic = isPublicClinic(c);
      const row = document.createElement("div");
      row.className = "clinic"+((open || (publicClinic && !c.hours)) ? "" : " closed");
      const bg = c.type==="달빛" ? "var(--warm)" : "var(--primary)";
      const isLive = travelTimeCache.has(c);
      const travelTime = timeForClinic(c);
      let tags = '<span class="tg">'+(c.departments && c.departments[0] ? c.departments[0] : c.type)+'</span><span class="tg">'+openStatusLabel(c)+'</span>';
      if (!publicClinic && c.intake) tags += '<span class="tg">'+c.intake+' 접수</span>';
      if (!publicClinic && typeof c.wait === "number") tags += '<span class="tg wait">대기 '+c.wait+'분</span>';
      if (closingSoon(c)) tags += '<span class="tg soon">마감 임박</span>';
      if (isNightClinic(c)) tags += '<span class="tg night">야간</span>';
      row.innerHTML =
        '<div class="ic" style="background:'+bg+'">'+ICON_HOSP+'</div>'+
        '<div class="info"><b>'+c.name+'</b><div class="meta">'+(S.zoneById[c.zone] ? S.zoneById[c.zone].name : "화성시")+
        ' · '+hoursLabel(c)+'</div><div class="tags">'+tags+'</div></div>'+
        (originIsLive && travelTime != null ? '<div class="dist"><b class="'+(isLive?"live":"demo")+'" title="카카오모빌리티 실이동시간">'+travelTime+'</b><span>분 거리</span></div>' : '');
      row.addEventListener("click", ()=> openDetail(c));
      list.appendChild(row);
      if (originIsLive && !isLive) fetchTravelTime(c);
    });
  }

  // ---- 클리닉 상세 모달 ----
  function drow(k, v){ return '<div class="drow"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>'; }

  function openDetail(c){
    S.state.selectedClinicZone = c.zone;
    S.highlightZone(c.zone);
    const open = S.isOpen(c);
    const publicClinic = isPublicClinic(c);
    const bg = c.type==="달빛" ? "var(--warm)" : "var(--primary)";
    const coord = S.clinicLatLng(c);
    const navUrl = "https://map.kakao.com/link/to/"+encodeURIComponent(c.name)+","+coord.lat+","+coord.lng;
    const isLive = travelTimeCache.has(c);
    const distLabel = timeForClinic(c)+"분 ("+(isLive?"실이동시간":"데모 추정")+")";
    if (publicClinic) {
      document.getElementById("sheet").innerHTML =
        '<div class="top"><div class="ic" style="background:'+bg+'">'+ICON_HOSP+'</div>'+
        '<div><h3 id="mName">'+c.name+'</h3><div class="st">'+(c.departments && c.departments[0] ? c.departments[0] : "소아청소년과")+' · '+
        (S.isOpen(c) ? '<b style="color:var(--cov0)">지금 진료 중</b>' : '<b style="color:var(--muted)">'+openStatusLabel(c)+'</b>')+'</div></div>'+
        '<button class="close" id="mClose" type="button" aria-label="닫기">✕</button></div>'+
        drow("진료시간", hoursLabel(c))+
        drow("주소", c.address || "주소 확인 필요")+
        drow("전화번호", c.phone || "전화번호 확인 필요")+
        '<div class="cta"><a class="btn primary" href="'+navUrl+'" target="_blank" rel="noopener noreferrer">길찾기</a>'+
        (c.phone ? '<a class="btn" href="tel:'+c.phone+'">전화하기</a>' : '')+'</div>'+
        '<div class="disc">공공데이터 기준 참고 정보이며 방문 전 전화 확인을 권장합니다. 응급 상황에서는 즉시 119로 연락하세요.</div>';
      document.getElementById("modal").classList.add("show");
      document.getElementById("mClose").addEventListener("click", closeDetail);
      return;
    }
    document.getElementById("sheet").innerHTML =
      '<div class="top"><div class="ic" style="background:'+bg+'">'+ICON_HOSP+'</div>'+
      '<div><h3 id="mName">'+c.name+'</h3><div class="st">'+S.zoneById[c.zone].name+' · '+c.type+' · '+
      (open ? '<b style="color:var(--cov0)">지금 진료 중</b>' : '<b style="color:var(--alert)">진료 종료</b>')+'</div></div>'+
      '<button class="close" id="mClose" type="button" aria-label="닫기">✕</button></div>'+
      drow("진료시간", S.hh(c.open)+" ~ "+S.hh(c.close)+(closingSoon(c)?' <b style="color:var(--alert)">(마감 임박)</b>':''))+
      drow("거리", distLabel+" · "+S.zoneById[c.zone].name+" 기준")+
      drow("예상 대기", c.wait+"분")+
      drow("접수 방식", c.intake+" 접수")+
      drow("진료 연령", c.ageFrom)+
      drow("주소", c.address)+
      drow("전화", c.phone)+
      '<div class="cta"><a class="btn primary" href="'+navUrl+'" target="_blank" rel="noopener noreferrer">길찾기</a>'+
      '<a class="btn" href="tel:'+c.phone+'">전화하기</a></div>'+
      '<div class="disc">본 정보는 참고용 안내이며 진단이 아닙니다. 응급 상황에서는 즉시 119로 연락하세요. · 표본 데이터</div>';
    document.getElementById("modal").classList.add("show");
    document.getElementById("mClose").addEventListener("click", closeDetail);
  }
  function closeDetail(){ document.getElementById("modal").classList.remove("show"); }
  document.getElementById("modal").addEventListener("click", e=>{ if (e.target.id==="modal") closeDetail(); });
  document.addEventListener("keydown", e=>{ if (e.key==="Escape") closeDetail(); });

  // ---- 기준 위치: 기준 동 선택 드롭다운 ↔ 내 위치(GPS) ----
  function setOrigin(coord, isLive){
    originCoord = coord;
    originIsLive = isLive;
    travelTimeCache.clear(); // 기준 위치가 바뀌면 캐시된 이동시간은 무효
    failedFetches.clear();   // 새 기준 위치는 다시 한 번 시도해볼 가치가 있음
    document.getElementById("originStatus").textContent = isLive ? "· 내 위치 사용 중" : "";
    renderClinics();
  }
  document.getElementById("useMyLocation").addEventListener("click", ()=>{
    const btn = document.getElementById("useMyLocation");
    const statusEl = document.getElementById("originStatus");
    if (!navigator.geolocation) {
      statusEl.textContent = "이 브라우저는 위치 확인을 지원하지 않아요";
      return;
    }
    btn.disabled = true; btn.textContent = "확인 중…";
    navigator.geolocation.getCurrentPosition(
      pos => {
        setOrigin({ lat: pos.coords.latitude, lng: pos.coords.longitude }, true);
        btn.disabled = false; btn.textContent = "📍 내 위치";
      },
      () => {
        statusEl.textContent = "위치 권한이 거부됐어요 — 기본 목록 순서로 계속해요";
        btn.disabled = false; btn.textContent = "📍 내 위치";
      },
      { timeout: 8000 }
    );
  });

  // ---- AI 자연어 트리아지(Claude API) ----
  let aiApiKey = "";
  const aiChatEl = document.getElementById("aiChat");
  const aiInputEl = document.getElementById("aiInput");

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }
  function aiScrollBottom(){ aiChatEl.scrollTop = aiChatEl.scrollHeight; }
  function addAIUserMsg(text){
    const empty = document.getElementById("aiEmpty"); if (empty) empty.remove();
    const d = document.createElement("div"); d.className = "aiMsg user"; d.textContent = text;
    aiChatEl.appendChild(d); aiScrollBottom();
  }
  function addAILoading(){
    const d = document.createElement("div"); d.className = "aiMsg ai"; d.id = "aiLoading";
    d.innerHTML = 'AI가 살펴보고 있어요 <span class="aiDots"><i></i><i></i><i></i></span>';
    aiChatEl.appendChild(d); aiScrollBottom();
  }
  function addAIResult(levelClass, title, body){
    const loading = document.getElementById("aiLoading"); if (loading) loading.remove();
    const d = document.createElement("div"); d.className = "aiMsg ai "+(levelClass||"");
    d.innerHTML = "<b>"+escapeHtml(title)+"</b>"+escapeHtml(body);
    aiChatEl.appendChild(d); aiScrollBottom();
  }
  function addAIError(text){
    const loading = document.getElementById("aiLoading"); if (loading) loading.remove();
    const d = document.createElement("div"); d.className = "aiMsg ai error"; d.textContent = text;
    aiChatEl.appendChild(d); aiScrollBottom();
  }

  function setVerdictFromAI(level, reasonText){
    const v = document.getElementById("verdict");
    if (level==="emergency") {
      v.className = "verdict emerg show";
      v.innerHTML = "<b>AI 판단: 응급 신호로 보여요 — 지금 응급실로 가세요</b>"+
        escapeHtml(reasonText||"망설이지 말고 119 또는 소아응급 진료가 가능한 응급실로 이동하세요.");
    } else {
      v.className = "verdict mild show";
      v.innerHTML = "<b>AI 판단: 경증으로 보여요 — 야간·주간 소아진료 권장</b>"+
        escapeHtml(reasonText||"아래 지금 문 연 소아 진료기관에서 진료받을 수 있어요.");
    }
    renderClinics();
  }

  function checkHardcodedEmergency(text){
    return EMERGENCY_KEYWORDS.find(k => text.includes(k)) || null;
  }

  async function callTriageAPI(text){
    const systemPrompt = [
      "당신은 소아 증상 1차 분류를 돕는 트리아지 보조 도구입니다.",
      "보호자가 입력한 문장만 보고, 아래 JSON 형식으로만 답하세요. 다른 말은 절대 포함하지 마세요.",
      '{"level":"emergency 또는 mild","summary":"한국어 한 문장 요약, 40자 이내","advice":"한국어 권장 행동 한 문장, 40자 이내"}',
      "판단 기준: 호흡곤란·의식저하·경련·청색증·심한탈수·지속고열 등 위험 신호가 있으면 반드시 emergency.",
      "조금이라도 애매하면 emergency를 선택하세요(과소분류보다 과대분류가 안전합니다).",
      "진단이나 처방은 하지 말고, 지금 응급실로 가야 하는지 여부만 판단하세요."
    ].join("\n");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": aiApiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 200,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{role:"user", content:text}]
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(()=> "");
      throw new Error("HTTP "+res.status+" "+errText.slice(0,150));
    }
    const data = await res.json();
    const block = (data.content||[]).find(b => b.type==="text");
    if (!block) throw new Error("응답 형식 오류");
    let raw = block.text.trim().replace(/^```json/i,"").replace(/^```/,"").replace(/```$/,"").trim();
    const parsed = JSON.parse(raw);
    if (!parsed.level) throw new Error("판단 결과 없음");
    return parsed;
  }

  async function handleAISend(){
    const text = aiInputEl.value.trim();
    if (!text) return;
    addAIUserMsg(text);
    aiInputEl.value = "";

    const hit = checkHardcodedEmergency(text);
    if (hit) {
      addAIResult("emerg", "안전장치 감지: 응급 신호로 보여요 — 지금 응급실로 가세요",
        '"'+hit+'" 표현에 반응해 AI 응답을 기다리지 않고 즉시 안내했어요. 119 또는 응급실로 바로 이동하세요.');
      setVerdictFromAI("emergency", hit+" 등 위험 신호가 감지됐어요.");
      return;
    }

    if (!aiApiKey) {
      addAIError("AI 문진을 쓰려면 위 'AI 연결 설정'에서 Anthropic API 키를 먼저 입력해주세요. 급하면 '빠른 선택' 탭을 이용해주세요.");
      const body = document.getElementById("aiSettingsBody");
      if (body) body.hidden = false;
      return;
    }

    addAILoading();
    try {
      const result = await callTriageAPI(text);
      const levelClass = result.level==="emergency" ? "emerg" : "mild";
      const title = result.level==="emergency"
        ? "AI 판단: 응급 신호로 보여요 — 지금 응급실로 가세요"
        : "AI 판단: 경증으로 보여요 — 야간·주간 소아진료 권장";
      const bodyText = ((result.summary||"")+" "+(result.advice||"")).trim();
      addAIResult(levelClass, title, bodyText);
      setVerdictFromAI(result.level, bodyText);
    } catch (err) {
      addAIError("AI 연결에 실패했어요 (키를 확인하거나 네트워크를 확인해주세요). 실제 배포판에서는 서버 프록시를 통해 안정적으로 연동돼요. 지금은 '빠른 선택' 탭을 이용해주세요.");
      console.error(err);
    }
  }

  document.getElementById("aiSend").addEventListener("click", handleAISend);
  aiInputEl.addEventListener("keydown", e=>{
    if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); handleAISend(); }
  });
  document.getElementById("aiKey").addEventListener("input", e=>{
    aiApiKey = e.target.value.trim();
    const badge = document.getElementById("aiStatus");
    if (aiApiKey) { badge.textContent = "연결됨"; badge.classList.add("on"); }
    else { badge.textContent = "미연결"; badge.classList.remove("on"); }
  });
  document.getElementById("aiSettingsBtn").addEventListener("click", ()=>{
    const body = document.getElementById("aiSettingsBody");
    body.hidden = !body.hidden;
  });

  // ---- 증상 확인 방식 토글(빠른 선택 / AI 문진) ----
  function setTriageMode(m){
    const isQuick = m==="quick";
    document.getElementById("mode-quick").setAttribute("aria-selected", String(isQuick));
    document.getElementById("mode-ai").setAttribute("aria-selected", String(!isQuick));
    document.getElementById("quickPane").hidden = !isQuick;
    document.getElementById("aiPane").hidden = isQuick;
    document.getElementById("triageTitle").textContent = isQuick
      ? "아이 증상을 눌러주세요" : "아이 증상을 문장으로 설명해주세요";
    document.getElementById("triageSub").textContent = isQuick
      ? "응급 신호가 있으면 바로 응급실을 안내해요."
      : "AI가 응급 여부를 1차로 판단해요. 위험 신호는 안전장치가 즉시 잡아내요.";
  }
  document.getElementById("mode-quick").addEventListener("click", ()=>setTriageMode("quick"));
  document.getElementById("mode-ai").addEventListener("click", ()=>setTriageMode("ai"));

  S.registerView("citizen", {
    render(){ renderVerdict(); renderClinics(); },
    onMarkerClick(c){ openDetail(c); },
  });

  buildFinderControls();
  S.refresh(); // 초기 화면(기본값: 시민 뷰) 렌더 — 모든 모듈 로드·등록이 끝난 뒤 마지막에 1회 호출
})();
