/**
 * Static 0-9 population data from:
 * 공공데이터포털 "경기도 화성시_인구_20260420".
 *
 * The source file provides population by administrative area and 10-year age
 * bands. This app uses the 0-9세 column as a proxy for pediatric demand.
 */
(function(){
  "use strict";

  const childPopulationByAdmin = {
    "우정읍": 438,
    "향남읍": 6095,
    "남양읍": 4759,
    "마도면": 124,
    "송산면": 258,
    "서신면": 108,
    "팔탄면": 166,
    "장안면": 210,
    "양감면": 62,
    "새솔동": 3651,
    "봉담읍": 10453,
    "매송면": 120,
    "비봉면": 1464,
    "정남면": 219,
    "기배동": 1000,
    "진안동": 4627,
    "병점1동": 2591,
    "병점2동": 1081,
    "반월동": 4108,
    "화산동": 1980,
    "동탄1동": 4172,
    "동탄2동": 2298,
    "동탄3동": 3253,
    "동탄4동": 5866,
    "동탄5동": 4885,
    "동탄6동": 4522,
    "동탄7동": 6256,
    "동탄8동": 6301,
    "동탄9동": 7812,
  };

  const ZONE_ADMIN_MAP = {
    dt13: ["동탄1동", "동탄2동", "동탄3동"],
    dt46: ["동탄4동", "동탄5동", "동탄6동"],
    dt79: ["동탄7동", "동탄8동", "동탄9동"],
    bj: ["병점1동", "병점2동", "진안동", "반월동", "기배동", "화산동"],
    bd: ["봉담읍", "매송면", "비봉면"],
    jn: ["정남면", "양감면"],
    hn: ["향남읍", "팔탄면", "장안면"],
    ny: ["남양읍", "새솔동"],
    ss: ["송산면", "서신면"],
    md: ["마도면", "우정읍"],
  };

  function sumChildPopulation(admins){
    return (admins || []).reduce((sum, name) => sum + (childPopulationByAdmin[name] || 0), 0);
  }

  if (window.AppData && Array.isArray(window.AppData.zones)) {
    window.AppData.zones.forEach(zone => {
      const adminAreas = ZONE_ADMIN_MAP[zone.id] || [];
      const childPop = sumChildPopulation(adminAreas);
      zone.adminAreas = adminAreas;
      zone.childPop = childPop;
      zone.childPopulation = childPop;
    });
  }

  window.AppPopulation = {
    childPopulationByAdmin,
    ZONE_ADMIN_MAP,
    sourceName: "공공데이터포털 경기도 화성시_인구_20260420",
    sourceColumn: "0-9세",
    sourceUpdated: "2026-04-20",
  };
})();
