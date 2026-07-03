/**
 * js/data.js — 화성시 소아의료 공백 지도의 공통 표본 데이터.
 * 지금은 코드 내 하드코딩 값이며, 추후 심평원 병원정보서비스·E-Gen·화성시 영유아 인구 공공데이터 API로 대체 예정.
 * policy.js/citizen.js는 이 파일을 직접 쓰지 말고 js/shared.js가 노출하는 값을 통해 접근한다.
 */
(function(){
  "use strict";

  // x,y = SVG tile 좌상단(viewBox 128x104), w=22 h=17 — 카카오맵 키 미입력 시 개념도 폴백용
  // lat,lng = 화성시 각 행정동/읍/면 소재지 근사 좌표(약식) — 실제 GeoJSON 경계 연동 전까지 중심점 근사치로 사용
  // pop = 영유아 상대인구(표본)
  const W = 22, H = 17;
  const zones = [
    {id:"dt13", name:"동탄1~3동", x:102, y:6,  pop:9, lat:37.201, lng:127.100},
    {id:"dt46", name:"동탄4~6동", x:102, y:27, pop:8, lat:37.196, lng:127.075},
    {id:"dt79", name:"동탄7~9동", x:102, y:48, pop:8, lat:37.213, lng:127.057},
    {id:"bj",   name:"병점·진안", x:76,  y:20, pop:4, lat:37.206, lng:127.032},
    {id:"bd",   name:"봉담읍",    x:52,  y:9,  pop:5, lat:37.207, lng:126.947},
    {id:"jn",   name:"정남면",    x:52,  y:34, pop:2, lat:37.165, lng:126.960},
    {id:"hn",   name:"향남읍",    x:52,  y:62, pop:5, lat:37.147, lng:126.925},
    {id:"ny",   name:"남양읍",    x:26,  y:24, pop:3, lat:37.203, lng:126.832},
    {id:"ss",   name:"송산·서신", x:4,   y:6,  pop:2, lat:37.220, lng:126.700},
    {id:"md",   name:"마도·우정", x:6,   y:52, pop:1, lat:37.170, lng:126.765},
  ];

  // clinics: open/close in hours (24h). type: 소아과 | 달빛
  const clinics = [
    {name:"동탄365소아과",     zone:"dt13", type:"소아과", open:9,  close:20},
    {name:"달빛어린이병원 동탄", zone:"dt13", type:"달빛",   open:10, close:23},
    {name:"메타폴리스 소아과",   zone:"dt46", type:"소아과", open:9,  close:19},
    {name:"동탄호수 키즈의원",   zone:"dt46", type:"소아과", open:9,  close:20},
    {name:"동탄북 소아청소년과", zone:"dt79", type:"소아과", open:9,  close:18},
    {name:"병점 튼튼소아과",     zone:"bj",   type:"소아과", open:9,  close:19},
    {name:"봉담 아이맘의원",     zone:"bd",   type:"소아과", open:9,  close:18},
    {name:"향남 미소소아과",     zone:"hn",   type:"소아과", open:9,  close:18},
    {name:"남양 새싹의원",       zone:"ny",   type:"소아과", open:9,  close:18},
    // 정남·송산·마도 : 소아 진료기관 없음 (구조적 공백)
  ];

  // 표본 이동시간(분) — 동탄 인근 데모 사용자 기준 (실연동 예정: 지도 API Directions)
  const demoDist = {dt13:6,dt46:9,dt79:12,bj:15,bd:22,jn:26,hn:30,ny:33,ss:41,md:44};

  const symptoms = [
    {label:"발열",   danger:false},
    {label:"기침·콧물", danger:false},
    {label:"구토·설사", danger:false},
    {label:"발진",   danger:false},
    {label:"복통",   danger:false},
    {label:"호흡곤란", danger:true},
    {label:"의식 저하", danger:true},
    {label:"경련(5분+)", danger:true},
    {label:"입술 청색증", danger:true},
  ];

  // 오분류 방지용 하드코딩 안전장치: 이 목록에 걸리면 API 응답을 기다리지 않고 즉시 응급 안내.
  // 절대 제거 금지 — AI 오분류/API 실패 시 마지막 안전장치 (CLAUDE.md 참조)
  const EMERGENCY_KEYWORDS = [
    "숨을 못","숨쉬기 힘들","숨이 가빠","호흡곤란","의식이 없","의식 저하",
    "축 처지","축 늘어지","경련","발작","청색증","입술이 파래","입술 파랗",
    "쓰러졌","반응이 없","깨우기 힘들","피를 토","피가 멈추지","심한 탈수",
    "눈이 안 떠","고개를 못 가누"
  ];

  window.AppData = { W, H, zones, clinics, demoDist, symptoms, EMERGENCY_KEYWORDS };
})();
