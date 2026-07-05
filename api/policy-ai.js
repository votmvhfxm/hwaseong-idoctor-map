const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash";

function sendJson(res, status, body) {
  res.status(status).json(body);
}

function parseBody(req) {
  let rawBody;
  try {
    rawBody = req.body;
  } catch (error) {
    return { ok: false, error };
  }
  if (!rawBody) return { ok: true, body: {} };
  if (typeof rawBody === "object") return { ok: true, body: rawBody };
  try {
    return { ok: true, body: JSON.parse(rawBody) };
  } catch (error) {
    return { ok: false, error };
  }
}

function fallbackInsight() {
  return {
    headline: "계산된 추천안을 기준으로 검토가 필요합니다.",
    summary: "AI 해석을 불러오지 못했습니다. 계산된 추천안은 정상 표시됩니다.",
    reasons: [
      "현재 화면의 커버리지, 공백 지역 수, 추가 커버 지수를 기준으로 후보를 비교할 수 있습니다.",
    ],
    caution: "실제 정책 적용 전 의료기관 참여 의향, 예산, 인력 확보, 교통 접근성을 함께 검토해야 합니다.",
  };
}

function normalizeInsight(value) {
  const source = value && typeof value === "object" ? value : {};
  const reasons = Array.isArray(source.reasons) ? source.reasons.map(String).filter(Boolean).slice(0, 3) : [];
  return {
    headline: String(source.headline || "계산된 추천안의 정책 효과를 검토하세요.").slice(0, 80),
    summary: String(source.summary || "추천안의 커버리지 변화와 공백 감소 효과를 함께 확인해야 합니다.").slice(0, 260),
    reasons: reasons.length ? reasons : ["추천안은 계산된 커버리지 변화와 공백 지역 감소를 기준으로 비교됩니다."],
    caution: String(source.caution || "실제 정책 적용 전 의료기관 참여 의향, 예산, 인력 확보, 교통 접근성을 검토해야 합니다.").slice(0, 180),
  };
}

function extractJson(text) {
  const trimmed = String(text || "").trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  const candidate = firstBrace >= 0 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : trimmed;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    error.responseBody = trimmed.slice(0, 500);
    throw error;
  }
}

function buildDebugInfo(error, extra) {
  return {
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    model: (extra && extra.model) || process.env.GEMINI_MODEL || DEFAULT_MODEL,
    errorMessage: error ? error.message : null,
    statusCode: error && error.statusCode ? error.statusCode : null,
  };
}

function addDebug(body, error, extra) {
  if (body && typeof body === "object") body.debug = buildDebugInfo(error, extra);
  return body;
}

async function callGemini(apiKey, payload) {
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = [
    "You write concise Korean policy dashboard explanations for a pediatric care access planning tool.",
    "Do not choose new regions. Use only the calculated scenarios supplied in the input.",
    "Do not exaggerate. Avoid words like diagnosis, certainty, guarantee, or confirmed.",
    "Use only the calculated numbers in the input as evidence.",
    "Mention that policy decisions require checking provider willingness, budget, staffing, and transport access.",
    "Return ONLY valid JSON. No markdown. No explanation.",
    'Required JSON shape: {"headline":"한 문장 제목","summary":"전체 요약 2~3문장","reasons":["근거1","근거2","근거3"],"caution":"정책 적용 전 검토사항"}',
    "",
    "Calculated input:",
    JSON.stringify(payload),
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  if (timer.unref) timer.unref();

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingBudget: 0 },
          response_mime_type: "application/json",
          response_schema: {
            type: "OBJECT",
            properties: {
              headline: { type: "STRING" },
              summary: { type: "STRING" },
              reasons: { type: "ARRAY", items: { type: "STRING" } },
              caution: { type: "STRING" },
            },
            required: ["headline", "summary", "reasons", "caution"],
          },
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = new Error("Gemini HTTP " + response.status);
      error.statusCode = response.status;
      error.responseBody = body;
      error.model = model;
      throw error;
    }

    const data = await response.json();
    const answer = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    const text = answer.map((part) => part.text || "").join("").trim();
    if (!text) {
      const error = new Error("Gemini returned empty text response");
      error.model = model;
      error.responseBody = JSON.stringify(data).slice(0, 500);
      throw error;
    }
    return normalizeInsight(extractJson(text));
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST only" });
    return;
  }

  const debug = req.query && req.query.debug === "1";
  const parsed = parseBody(req);
  if (!parsed.ok) {
    const fallback = fallbackInsight();
    if (debug) addDebug(fallback, parsed.error);
    sendJson(res, 200, fallback);
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const fallback = fallbackInsight();
    if (debug) addDebug(fallback, new Error("GEMINI_API_KEY is not configured"));
    sendJson(res, 200, fallback);
    return;
  }

  try {
    const insight = await callGemini(apiKey, parsed.body || {});
    if (debug) addDebug(insight, null);
    sendJson(res, 200, insight);
  } catch (error) {
    console.error("Policy AI failed:", error.message);
    const fallback = fallbackInsight();
    if (debug) addDebug(fallback, error, { model: error.model });
    sendJson(res, 200, fallback);
  }
};
