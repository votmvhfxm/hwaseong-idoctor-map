/**
 * js/shared.js — 시간 슬라이더, 커버리지 계산, 지도 렌더링 등 정책/시민 탭 공통 로직.
 * policy.js와 citizen.js는 서로 직접 참조하지 않고, 이 모듈이 노출하는 window.Shared를 통해서만 상태를 주고받는다.
 */
(function(){
  "use strict";
  const { W, H, zones, clinics, demoDist } = window.AppData;

  const zoneById = Object.fromEntries(zones.map(z=>[z.id, z]));
  const totalPop = zones.reduce((s,z)=>s+z.pop, 0);
  const maxPop = Math.max(...zones.map(z=>z.pop));

  const state = {
    hour: 14,
    view: "citizen",
    extraNight: new Set(),   // 정책 뷰 배치 시뮬레이션: 가상 야간진료가 추가된 zone id
    selectedClinicZone: null,
  };

  /** @param {object} c clinic @param {number} [h] 24시간 기준 시각(생략 시 현재 상태) */
  function isOpen(c, h){ h = (h==null) ? state.hour : h; return h >= c.open && h < c.close; }

  /** @param {string} zid zone id @param {number} [h] @param {Set<string>} [extra] */
  function zoneCovered(zid, h, extra){
    h = (h==null) ? state.hour : h;
    extra = extra || state.extraNight;
    if (extra.has(zid)) return true;
    return clinics.some(c => c.zone===zid && isOpen(c, h));
  }

  /** @param {number} [h] @param {Set<string>} [extra] */
  function coveragePct(h, extra){
    h = (h==null) ? state.hour : h;
    extra = extra || state.extraNight;
    let cov = 0;
    zones.forEach(z => { if (zoneCovered(z.id, h, extra)) cov += z.pop; });
    return Math.round(cov / totalPop * 100);
  }
  function covColor(p){ return p>=70 ? "var(--cov0)" : p>=40 ? "var(--cov1)" : "var(--cov2)"; }
  const hh = h => String(h).padStart(2,"0")+":00";
  const isNightHour = h => h<7 || h>=20;
  function ampm(h){ const m = h<12 ? "오전" : "오후"; let hr = h%12; if (hr===0) hr = 12; return m+" "+hr+":00"; }

  // ---- SVG 지도 빌드 ----
  const svg = document.getElementById("svg");
  const NS = "http://www.w3.org/2000/svg";
  function el(tag, attrs){
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  const zoneRectEls = {};
  zones.forEach(z=>{
    const g = el("g", {});
    const rect = el("rect", {class:"zone", x:z.x, y:z.y, width:W, height:H, rx:3.5,
      fill:"var(--cov0)", "fill-opacity":.16, stroke:"var(--line)", "stroke-width":.5});
    zoneRectEls[z.id] = rect;
    g.appendChild(rect);
    const lbl = el("text", {class:"zlabel", x:z.x+3, y:z.y+6}); lbl.textContent = z.name; g.appendChild(lbl);
    const pop = el("text", {class:"zpop", x:z.x+3, y:z.y+11}); pop.textContent = "영유아 "+z.pop; g.appendChild(pop);
    svg.appendChild(g);
  });

  // markers (grouped per zone with offset)
  const markerEls = [];
  const perZone = {};
  clinics.forEach(c=>{
    perZone[c.zone] = perZone[c.zone] || 0;
    const idx = perZone[c.zone]++;
    const z = zoneById[c.zone];
    const cx = z.x+6+idx*6, cy = z.y+H-4;
    const g = el("g", {class:"marker", "data-zone":c.zone});
    g.style.cursor = "pointer";
    const fill = c.type==="달빛" ? "var(--warm)" : "var(--primary)";
    g.appendChild(el("circle", {cx, cy, r:2.4, fill, stroke:"#fff", "stroke-width":.7}));
    g.dataset.name = c.name;
    g.addEventListener("click", ()=>{
      state.selectedClinicZone = c.zone;
      highlightZone(c.zone);
      const hooks = viewHooks[state.view];
      if (hooks && hooks.onMarkerClick) hooks.onMarkerClick(c);
    });
    svg.appendChild(g);
    markerEls.push({g, c, cx, cy});
  });

  function highlightZone(zid){
    markerEls.forEach(m => m.g.classList.toggle("hl", m.c.zone===zid));
    kakaoMarkerOverlays.forEach(m => m.dot.classList.toggle("hl", m.c.zone===zid));
  }

  // ---- 카카오맵 실연동 — 지도 API 키 입력 시 아래 SVG 개념도 대신 실제 지도로 전환 ----
  // 지도 API 키는 코드에 하드코딩하지 않고 사용자가 이 브라우저 탭에만 입력한다(AI 키와 동일한 패턴).
  const mapEl = document.getElementById("kakaoMapEl");
  let kakaoMap = null;
  let kakaoLoadState = "idle"; // idle | loading | ready | error
  const kakaoZoneOverlays = {};   // zid -> {overlay, el}
  const kakaoMarkerOverlays = []; // [{overlay, c, dot}]
  const kakaoIsoCircles = [];     // kakao.maps.Circle[]

  function hasRealMap(){ return kakaoLoadState === "ready"; }

  // 클리닉별 근사 좌표(카카오 마커/길찾기 딥링크 공용) — zone 중심에서 소폭 오프셋
  const clinicCoordMap = new Map();
  (function buildClinicCoords(){
    const perZoneC = {};
    clinics.forEach(c=>{
      perZoneC[c.zone] = perZoneC[c.zone] || 0;
      const idx = perZoneC[c.zone]++;
      const z = zoneById[c.zone];
      clinicCoordMap.set(c, { lat: z.lat + idx*0.0016, lng: z.lng + idx*0.0016 });
    });
  })();
  function clinicLatLng(c){ return clinicCoordMap.get(c); }

  function updateMapStatus(errMsg){
    const badge = document.getElementById("mapStatus");
    if (badge) {
      if (kakaoLoadState==="ready") { badge.textContent="실제 지도 연결됨"; badge.classList.add("on"); }
      else if (kakaoLoadState==="loading") { badge.textContent="연결 중…"; badge.classList.remove("on"); }
      else if (kakaoLoadState==="error") { badge.textContent="연결 실패"; badge.classList.remove("on"); }
      else { badge.textContent="개념도"; badge.classList.remove("on"); }
    }
    const errEl = document.getElementById("mapKeyError");
    if (errEl) {
      if (errMsg) { errEl.textContent = errMsg; errEl.style.display = "block"; }
      else { errEl.style.display = "none"; }
    }
  }

  function loadKakaoSdk(key){
    return new Promise((resolve, reject)=>{
      const script = document.createElement("script");
      script.src = "https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&appkey=" + encodeURIComponent(key);
      script.onerror = () => reject(new Error("카카오맵 SDK를 불러오지 못했어요. 키 또는 네트워크를 확인해주세요."));
      script.onload = () => {
        try { window.kakao.maps.load(resolve); }
        catch (e) { reject(e); }
      };
      document.head.appendChild(script);
    });
  }

  function buildKakaoZoneOverlays(){
    zones.forEach(z=>{
      const div = document.createElement("div");
      div.className = "kzone";
      div.innerHTML = "<b>"+z.name+"</b><span>영유아 "+z.pop+"</span>";
      const overlay = new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(z.lat, z.lng),
        content: div, yAnchor: 0.5, xAnchor: 0.5, zIndex: 1,
      });
      overlay.setMap(kakaoMap);
      kakaoZoneOverlays[z.id] = {overlay, el:div};
    });
  }

  // 실제 화성시 읍면동 경계 폴리곤(js/geo.js, window.HWASEONG_GEO) — 근사 그룹핑으로 10개 zone 색상에 매핑해 표시.
  // 실제 28개 읍면동을 앱의 10개 zone으로 그룹핑한 것은 인접 지역 기준 근사치이며, 공식 "권역" 구분이 아님.
  const kakaoPolygons = []; // [{polygon, zoneId}]
  function buildKakaoPolygons(){
    const geo = window.HWASEONG_GEO || [];
    geo.forEach(f=>{
      f.polys.forEach(part=>{
        const path = part.map(pt => new kakao.maps.LatLng(pt[1], pt[0])); // pt = [lon,lat]
        const polygon = new kakao.maps.Polygon({
          path, strokeWeight: 1, strokeColor: "#8FA39C", strokeOpacity: 0.6,
          fillColor: "#2FA37E", fillOpacity: 0.15,
        });
        polygon.setMap(kakaoMap);
        kakaoPolygons.push({polygon, zoneId: f.zone});
      });
    });
  }

  function buildKakaoMarkers(){
    clinics.forEach(c=>{
      const coord = clinicLatLng(c);
      const dot = document.createElement("div");
      dot.className = "kmarker";
      dot.style.background = c.type==="달빛" ? "var(--warm)" : "var(--primary)";
      dot.title = c.name;
      const overlay = new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(coord.lat, coord.lng),
        content: dot, yAnchor: 0.5, xAnchor: 0.5, zIndex: 3,
      });
      overlay.setMap(kakaoMap);
      dot.addEventListener("click", ()=>{
        state.selectedClinicZone = c.zone;
        highlightZone(c.zone);
        const hooks = viewHooks[state.view];
        if (hooks && hooks.onMarkerClick) hooks.onMarkerClick(c);
      });
      kakaoMarkerOverlays.push({overlay, c, dot});
    });
  }

  function connectKakaoMap(key){
    if (kakaoLoadState==="ready" || kakaoLoadState==="loading") return;
    kakaoLoadState = "loading";
    updateMapStatus();
    loadKakaoSdk(key).then(()=>{
      svg.style.display = "none"; // SVGElement has no reflected `hidden` IDL property in all engines — use style directly
      mapEl.hidden = false;
      kakaoMap = new kakao.maps.Map(mapEl, {
        center: new kakao.maps.LatLng(37.185, 126.960), // 화성시 대략 중심
        level: 9,
      });
      buildKakaoPolygons();
      buildKakaoZoneOverlays();
      buildKakaoMarkers();
      kakaoLoadState = "ready";
      updateMapStatus();
      refresh();
    }).catch(err=>{
      kakaoLoadState = "error";
      updateMapStatus(err.message);
      console.error(err);
    });
  }

  /**
 * Vercel 서버리스 함수에서 공개 설정값을 불러와 카카오맵을 자동 연결한다.
 *
 * @returns {Promise<void>}
 */
async function autoConnectKakaoMapFromConfig(){
  try {
    const res = await fetch("/api/config");

    if (!res.ok) return;

    const config = await res.json();
    const key = config && config.kakaoJsKey;

    if (!key) return;

    const input = document.getElementById("mapKey");
    if (input) input.value = key;

    connectKakaoMap(key);
  } catch (e) {
    // 자동 연결 실패 시 기존 개념도/수동 입력 방식으로 유지한다.
  }
}

  const mapKeyInput = document.getElementById("mapKey");
  document.getElementById("mapConnect").addEventListener("click", ()=>{
    const key = mapKeyInput.value.trim();
    if (key) connectKakaoMap(key);
  });

  autoConnectKakaoMapFromConfig();
  
  mapKeyInput.addEventListener("keydown", e=>{
    if (e.key==="Enter") { e.preventDefault(); document.getElementById("mapConnect").click(); }
  });
  document.getElementById("mapSettingsBtn").addEventListener("click", ()=>{
    const body = document.getElementById("mapSettingsBody");
    body.hidden = !body.hidden;
  });


  // ---- 등시간대(isochrone) 반경 — 정책 뷰 전용 오버레이 ----
  // 실이동시간 라우팅 API 연동 전까지는 데모 추정 반경(15분/30분)이며, 실도로망 기준이 아님.
  const ISO_RINGS = [ {minutes:15, r:6.2, cls:"r15"}, {minutes:30, r:12.5, cls:"r30"} ];
  const KAKAO_ISO_RINGS = [ {minutes:15, meters:6000, color:"#0E6E5A"}, {minutes:30, meters:12000, color:"#E0952F"} ];
  let isoGroup = null;
  function setIsochronesVisible(show){
    if (isoGroup) { isoGroup.remove(); isoGroup = null; }
    kakaoIsoCircles.forEach(c => c.setMap(null));
    kakaoIsoCircles.length = 0;
    if (!show) return;

    const openZones = new Set(clinics.filter(c => isOpen(c)).map(c => c.zone));

    isoGroup = el("g", {class:"isogroup"});
    openZones.forEach(zid=>{
      const z = zoneById[zid];
      const cx = z.x + W/2, cy = z.y + H/2;
      ISO_RINGS.forEach(ring=>{
        isoGroup.appendChild(el("circle", {class:"isoring "+ring.cls, cx, cy, r:ring.r}));
      });
    });
    const firstMarker = markerEls[0] && markerEls[0].g;
    if (firstMarker) svg.insertBefore(isoGroup, firstMarker); else svg.appendChild(isoGroup);

    if (hasRealMap()) {
      openZones.forEach(zid=>{
        const z = zoneById[zid];
        const center = new kakao.maps.LatLng(z.lat, z.lng);
        KAKAO_ISO_RINGS.forEach(ring=>{
          const circle = new kakao.maps.Circle({
            center, radius: ring.meters,
            strokeWeight: 1.4, strokeColor: ring.color, strokeOpacity: 0.65,
            strokeStyle: ring.minutes===30 ? "shortdash" : "solid",
            fillColor: ring.color, fillOpacity: 0.03,
          });
          circle.setMap(kakaoMap);
          kakaoIsoCircles.push(circle);
        });
      });
    }
  }

  // 커버리지 + 인구밀도로 zone 색상(rgb, alpha) 계산 — SVG/카카오 zone 카드/실폴리곤이 모두 이 값을 공유
  function zoneFillStyle(z){
    const covered = zoneCovered(z.id);
    const intensity = z.pop / maxPop; // 0..1, 인구밀도 클수록 색이 진해짐
    const rgb = covered ? "47,163,126" : "206,78,57";
    const cardAlpha = covered ? (0.16 + intensity*0.34) : (0.18 + intensity*0.48);
    const polyAlpha = covered ? (0.10 + intensity*0.30) : (0.14 + intensity*0.42);
    return { covered, rgb, cardAlpha, polyAlpha };
  }

  // ---- 지도 색상: 커버리지 + 인구밀도 그라데이션(choropleth) ----
  function renderMap(){
    zones.forEach(z=>{
      const style = zoneFillStyle(z);
      const rect = zoneRectEls[z.id];
      rect.setAttribute("fill", style.covered ? "var(--cov0)" : "var(--cov2)");
      rect.setAttribute("fill-opacity", style.polyAlpha.toFixed(2));

      const kz = kakaoZoneOverlays[z.id];
      if (kz) {
        kz.el.style.background = "rgba("+style.rgb+","+style.cardAlpha.toFixed(2)+")";
        kz.el.style.borderColor = "rgba("+style.rgb+",.4)";
      }
    });
    kakaoPolygons.forEach(kp=>{
      const z = zoneById[kp.zoneId];
      if (!z) return;
      const style = zoneFillStyle(z);
      kp.polygon.setOptions({
        fillColor: style.covered ? "#2FA37E" : "#CE4E39",
        fillOpacity: style.polyAlpha,
        strokeColor: style.covered ? "#2FA37E" : "#CE4E39",
      });
    });
    markerEls.forEach(m => m.g.classList.toggle("closed", !isOpen(m.c)));
    kakaoMarkerOverlays.forEach(m => m.dot.classList.toggle("closed", !isOpen(m.c)));
  }

  function renderCoverage(){
    const p = coveragePct();
    document.getElementById("covNum").textContent = p;
    const bar = document.getElementById("covBar");
    bar.style.width = p+"%"; bar.style.background = covColor(p);
    document.getElementById("mOpen").textContent = clinics.filter(c => isOpen(c)).length+"곳";
    document.getElementById("mGap").textContent = zones.filter(z => !zoneCovered(z.id)).length+"곳";
  }

  const SUN_ICON = '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4.2" fill="#fff"/><g stroke="#fff" stroke-width="1.8" stroke-linecap="round"><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7"/></g></svg>';
  const MOON_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.3 6.3 0 0 0 10.5 10.5Z" fill="#fff"/></svg>';
  function renderHero(){
    const night = isNightHour(state.hour);
    document.getElementById("dnIcon").innerHTML = night ? MOON_ICON : SUN_ICON;
    document.getElementById("dnIcon").style.background = night ? "var(--warm)" : "var(--primary)";
    document.getElementById("dnTitle").textContent = night ? "밤 시간대" : "낮 시간대";
    document.getElementById("dnClock").textContent = ampm(state.hour)+" 기준";
    const p = coveragePct();
    let msg;
    if (p>=70) msg = "지금은 소아과가 활발히 문을 여는 시간이에요. 대부분 지역에서 진료받을 수 있어요.";
    else if (p>=40) msg = "문 연 소아과가 줄고 있어요. 서둘러 가까운 곳을 확인하세요.";
    else msg = "지금은 문 연 소아과가 많지 않아요. 응급 신호가 있는지 함께 확인하세요.";
    document.getElementById("statusMsg").textContent = msg;
  }

  function renderClock(){
    document.getElementById("timeval").textContent = hh(state.hour);
    document.getElementById("clocktxt").textContent = hh(state.hour);
    document.getElementById("time").value = state.hour;
    document.getElementById("clockdot").style.background = covColor(coveragePct());
  }

  // ---- 뷰 등록 레지스트리 (policy.js / citizen.js는 서로 참조하지 않고 여기에만 등록) ----
  const viewHooks = {};
  /** @param {string} name @param {{onShow?:Function,onHide?:Function,render?:Function,onMarkerClick?:Function}} hooks */
  function registerView(name, hooks){ viewHooks[name] = hooks; }

  function refresh(){
    renderClock(); renderCoverage(); renderHero(); renderMap();
    const hooks = viewHooks[state.view];
    if (hooks && hooks.render) hooks.render();
  }

  function setView(v){
    const prev = state.view;
    if (viewHooks[prev] && viewHooks[prev].onHide) viewHooks[prev].onHide();
    state.view = v;
    const isCitizen = v==="citizen";
    document.getElementById("tab-citizen").setAttribute("aria-selected", String(isCitizen));
    document.getElementById("tab-policy").setAttribute("aria-selected", String(!isCitizen));
    document.getElementById("panel-citizen").hidden = !isCitizen;
    document.getElementById("panel-policy").hidden = isCitizen;
    document.getElementById("mapTitle").textContent = isCitizen
      ? "화성시 소아 진료 접근성 (개념도)" : "화성시 소아의료 공백 지도 (개념도)";
    if (viewHooks[v] && viewHooks[v].onShow) viewHooks[v].onShow();
    refresh();
  }
  document.getElementById("tab-citizen").addEventListener("click", ()=>setView("citizen"));
  document.getElementById("tab-policy").addEventListener("click", ()=>setView("policy"));

  document.getElementById("fontBtn").addEventListener("click", function(){
    const on = this.getAttribute("aria-pressed")==="true";
    this.setAttribute("aria-pressed", String(!on));
    document.querySelector(".wrap").style.zoom = on ? "1" : "1.12";
  });

  document.getElementById("time").addEventListener("input", e=>{ state.hour = +e.target.value; refresh(); });
  document.querySelectorAll(".presets button").forEach(b=>{
    b.addEventListener("click", ()=>{ state.hour = +b.dataset.h; refresh(); });
  });

  window.Shared = {
    zones, clinics, demoDist, zoneById, totalPop, maxPop,
    state, isOpen, zoneCovered, coveragePct, covColor, hh,
    svg, el, markerEls, zoneRectEls, highlightZone, setIsochronesVisible, hasRealMap, clinicLatLng,
    registerView, refresh, setView,
  };
})();
