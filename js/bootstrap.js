(function(){
  "use strict";

  const API_URL = "/api/clinics";
  const APP_SCRIPTS = ["js/geo.js", "js/shared.js", "js/policy.js", "js/citizen.js"];

  function setLoadingMessage(text) {
    const list = document.getElementById("clinicList");
    if (list) list.innerHTML = '<div class="empty">'+text+'</div>';
    const count = document.getElementById("resultCount");
    if (count) count.textContent = "불러오는 중";
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error(src + " 로드 실패"));
      document.body.appendChild(script);
    });
  }

  function zoneFromAddress(address) {
    const text = String(address || "");
    if (text.includes("동탄")) return "dt13";
    if (text.includes("병점") || text.includes("진안")) return "bj";
    if (text.includes("봉담")) return "bd";
    if (text.includes("향남")) return "hn";
    if (text.includes("남양")) return "ny";
    if (text.includes("정남")) return "jn";
    if (text.includes("송산") || text.includes("서신")) return "ss";
    if (text.includes("마도") || text.includes("양감")) return "md";
    return "dt13";
  }

  function normalizeClinic(raw, index) {
    const address = raw.address || raw.addr || "";
    const zone = raw.zone || raw.zoneId || zoneFromAddress(address);
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    return {
      id: raw.id || raw.ykiho || raw.name + "-" + index,
      ykiho: raw.ykiho || null,
      name: raw.name || raw.yadmNm || "이름 확인 필요",
      zone,
      zoneId: zone,
      type: raw.type || "의료기관",
      phone: raw.phone || raw.telno || "",
      address,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      departments: raw.departments || ["확인 필요"],
      hours: raw.hours || null,
      todayOpen: raw.todayOpen == null ? null : Boolean(raw.todayOpen),
      openText: raw.openText || "진료시간 확인 필요",
      source: "public-api",
      isPublic: true
    };
  }

  async function hydrateClinics() {
    if (!window.AppData) return;
    window.AppData.sampleClinics = window.AppData.clinics.slice();
    setLoadingMessage("화성시 의료기관 정보를 불러오는 중입니다.");

    try {
      const response = await fetch(API_URL, { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      const clinics = Array.isArray(data.clinics) ? data.clinics : [];
      if (!clinics.length) throw new Error("공공데이터 병원 목록 0건");

      window.AppData.clinics = clinics.map(normalizeClinic);
      window.AppData.clinicDataSource = "public-api";
      window.AppData.clinicDataMessage = "공공데이터 기준";
    } catch (error) {
      console.warn("공공데이터 병원 목록을 불러오지 못해 표본 데이터를 사용합니다.", error);
      window.AppData.clinics = window.AppData.sampleClinics;
      window.AppData.clinicDataSource = "sample-fallback";
      window.AppData.clinicDataMessage = "공공데이터 연결 실패로 표본 데이터를 표시 중입니다";
    }
  }

  async function start() {
    await hydrateClinics();
    for (const src of APP_SCRIPTS) await loadScript(src);
  }

  start().catch(error => {
    console.error(error);
    setLoadingMessage("화면 초기화 중 오류가 발생했습니다.");
  });
})();
