/**
 * Vercel 서버리스 함수 — 카카오모빌리티 길찾기(Directions) API 프록시.
 *
 * 브라우저가 카카오모빌리티 REST API를 직접 호출하면 (1) REST 키가 노출되고 (2) CORS로 막힌다.
 * 이 함수가 그 사이에서 origin/destination 좌표만 받아 서버 쪽에서 카카오에 대신 요청하고,
 * 결과에서 필요한 값(소요시간·거리)만 뽑아 돌려준다. REST 키는 Vercel 프로젝트의 환경변수
 * KAKAO_REST_API_KEY로만 설정한다 — 코드에 하드코딩하지 않는다(CLAUDE.md 규칙).
 *
 * 로컬 정적 프리뷰(python -m http.server 등)나 Vercel 배포 전에는 이 엔드포인트 자체가 없으므로
 * 프런트엔드(js/citizen.js)는 이 호출이 실패하면 조용히 기존 데모 이동시간(demoDist)으로 폴백한다.
 */
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "GET만 지원해요." }); return; }

  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) {
    res.status(500).json({ error: "서버에 KAKAO_REST_API_KEY 환경변수가 설정되지 않았어요." });
    return;
  }

  const { originLat, originLng, destLat, destLng } = req.query;
  if (!originLat || !originLng || !destLat || !destLng) {
    res.status(400).json({ error: "originLat, originLng, destLat, destLng 파라미터가 모두 필요해요." });
    return;
  }

  const url = new URL("https://apis-navi.kakaomobility.com/v1/directions");
  url.searchParams.set("origin", `${originLng},${originLat}`);
  url.searchParams.set("destination", `${destLng},${destLat}`);
  url.searchParams.set("priority", "RECOMMEND");

  try {
    const kakaoRes = await fetch(url, {
      headers: { Authorization: `KakaoAK ${key}` },
    });
    if (!kakaoRes.ok) {
      const text = await kakaoRes.text().catch(() => "");
      res.status(kakaoRes.status).json({ error: "카카오모빌리티 API 오류", detail: text.slice(0, 300) });
      return;
    }
    const data = await kakaoRes.json();
    const summary = data.routes && data.routes[0] && data.routes[0].summary;
    if (!summary) {
      res.status(502).json({ error: "경로를 찾지 못했어요." });
      return;
    }
    res.status(200).json({
      durationMin: Math.round(summary.duration / 60),
      distanceKm: Math.round(summary.distance / 100) / 10,
    });
  } catch (err) {
    res.status(502).json({ error: "카카오모빌리티 API 호출 실패", detail: String(err) });
  }
};
