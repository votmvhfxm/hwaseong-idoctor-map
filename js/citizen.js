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

  // ---- 이동시간: 서버리스 프록시(/api/directions)로 실이동시간, 실패 시 demoDist로 조용히 폴백 ----
  // 로컬 정적 프리뷰·Vercel 미배포 상태에서는 /api가 아예 없으므로 fetch가 실패하고, 그대로 데모 추정치를 계속 쓴다.
  const DEMO_ORIGIN = { lat: 37.201, lng: 127.100 }; // 동탄역 인근 데모 사용자 위치
  let originCoord = DEMO_ORIGIN;
  let originIsLive = false;
  const travelTimeCache = new Map(); // clinic -> {durationMin}
  const pendingFetches = new Set();  // clinic (중복 fetch 방지)
  const failedFetches = new Set();   // clinic (실패 후 재시도 안 함 — /api 미배포 상태에서 매 렌더마다 재요청 방지)

  function timeForClinic(c){
    const live = travelTimeCache.get(c);
    return live ? live.durationMin : S.demoDist[c.zone];
  }

  async function fetchTravelTime(c){
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

  // ---- 실시간 소아진료 안내(이동시간순) ----
  function renderClinics(){
    const list = document.getElementById("clinicList");
    const open = S.clinics.filter(c => S.isOpen(c)).sort((a,b) => timeForClinic(a)-timeForClinic(b));
    list.innerHTML = "";
    if (open.length===0) {
      list.innerHTML = '<div class="empty">이 시각에 문 연 소아 진료기관이 없어요.<br/>바로 이게 우리가 푸는 문제입니다.</div>';
      return;
    }
    open.forEach(c=>{
      const row = document.createElement("div");
      row.className = "clinic";
      const color = c.type==="달빛" ? "var(--warm)" : "var(--primary)";
      const coord = S.clinicLatLng(c);
      const navUrl = "https://map.kakao.com/link/to/"+encodeURIComponent(c.name)+","+coord.lat+","+coord.lng;
      const isLive = travelTimeCache.has(c);
      row.innerHTML =
        '<span class="pin" style="background:'+color+'"></span>'+
        '<div class="info"><b>'+c.name+'</b><span>'+S.zoneById[c.zone].name+
        ' · '+c.type+' · '+S.hh(c.open)+'~'+S.hh(c.close)+'</span></div>'+
        '<span class="tag '+(isLive?"live":"demo")+'" title="'+(isLive?"카카오모빌리티 실이동시간":"데모 추정치")+'">'+timeForClinic(c)+'분</span>'+
        '<a class="navlink" href="'+navUrl+'" target="_blank" rel="noopener noreferrer" aria-label="'+c.name+' 카카오맵 길찾기">길찾기</a>';
      row.addEventListener("click", ()=>{ S.state.selectedClinicZone = c.zone; S.highlightZone(c.zone); });
      list.appendChild(row);
      if (!isLive) fetchTravelTime(c); // 아직 실시간 값이 없으면 백그라운드로 조회 시도
    });
  }

  // ---- 기준 위치: 데모 위치(동탄역 인근) ↔ 내 위치 ----
  function setOrigin(coord, isLive){
    originCoord = coord;
    originIsLive = isLive;
    travelTimeCache.clear(); // 기준 위치가 바뀌면 캐시된 이동시간은 무효
    failedFetches.clear();   // 새 기준 위치는 다시 한 번 시도해볼 가치가 있음
    document.getElementById("originLabel").textContent = isLive ? "기준 위치: 내 위치" : "기준 위치: 동탄역 인근(데모)";
    renderClinics();
  }
  document.getElementById("useMyLocation").addEventListener("click", ()=>{
    const btn = document.getElementById("useMyLocation");
    if (!navigator.geolocation) {
      document.getElementById("originLabel").textContent = "이 브라우저는 위치 확인을 지원하지 않아요";
      return;
    }
    btn.disabled = true; btn.textContent = "위치 확인 중…";
    navigator.geolocation.getCurrentPosition(
      pos => {
        setOrigin({ lat: pos.coords.latitude, lng: pos.coords.longitude }, true);
        btn.disabled = false; btn.textContent = "📍 내 위치 사용";
      },
      () => {
        document.getElementById("originLabel").textContent = "위치 권한이 거부됐어요 — 데모 위치로 계속해요";
        btn.disabled = false; btn.textContent = "📍 내 위치 사용";
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
  });

  S.refresh(); // 초기 화면(기본값: 시민 뷰) 렌더 — 모든 모듈 로드·등록이 끝난 뒤 마지막에 1회 호출
})();
