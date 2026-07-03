/**
 * api/config.js — 브라우저 초기 설정값 제공용 Vercel 서버리스 함수.
 *
 * 카카오맵 JavaScript 키는 브라우저에서 SDK 로드에 사용되는 공개 키 성격이지만,
 * 코드에 직접 하드코딩하지 않기 위해 Vercel 환경변수에서 읽어 내려준다.
 * REST API 키는 절대 여기서 내려주면 안 된다.
 */
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "GET만 지원해요." });
    return;
  }

  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");

  res.status(200).json({
    kakaoJsKey: process.env.KAKAO_JS_API_KEY || "",
  });
};