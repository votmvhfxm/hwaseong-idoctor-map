const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash";
const ALLOWED_LEVELS = new Set(["emergency", "urgent", "mild", "unknown"]);
const EMERGENCY_KEYWORDS = [
  "호흡곤란",
  "숨쉬기 힘들",
  "숨을 못",
  "의식저하",
  "의식이",
  "축 늘어",
  "반응 없음",
  "반응이 없",
  "경련 5분",
  "5분 이상 경련",
  "경련",
  "발작",
  "청색증",
  "입술이 파랗",
  "입술 파래",
  "깨우기 힘들",
  "심한 탈수",
];

function sendJson(res, status, body) {
  res.status(status).json(body);
}

function sendSafeJson(res, status, body) {
  try {
    sendJson(res, status, body);
  } catch (error) {
    try {
      res.status(500).end();
    } catch (ignored) {
      // Response object failed; nothing else to do.
    }
  }
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

function fallbackUnknown() {
  return {
    level: "unknown",
    summary: "AI 문진을 불러오지 못했습니다.",
    advice: "위험 증상이 있으면 119 또는 응급실로 이동하세요.",
    redFlags: [],
  };
}

function invalidRequestBody() {
  return {
    level: "unknown",
    summary: "요청 형식이 올바르지 않습니다.",
    advice: "증상을 다시 입력해주세요. 위험 증상이 있으면 119 또는 응급실로 이동하세요.",
    redFlags: [],
  };
}

function normalizeResult(value) {
  const result = value && typeof value === "object" ? value : {};
  const level = ALLOWED_LEVELS.has(result.level) ? result.level : "unknown";
  const redFlags = Array.isArray(result.redFlags) ? result.redFlags.map(String).slice(0, 5) : [];
  const summary = String(result.summary || "증상 확인이 필요합니다.").slice(0, 120);
  let advice = String(
    result.advice || "AI 문진은 참고 안내입니다. 위험 증상이 있으면 119 또는 응급실로 이동하세요."
  ).slice(0, 220);
  if (!/119|응급실/.test(advice)) {
    advice += " 응급 상황에서는 119 또는 응급실로 이동하세요.";
  }
  return { level, summary, advice, redFlags };
}

function findEmergencyKeyword(text) {
  return EMERGENCY_KEYWORDS.find((keyword) => text.includes(keyword)) || null;
}

function extractJson(text) {
  const trimmed = String(text || "")
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();
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
    errorName: error ? error.name : null,
    errorMessage: error ? error.message : null,
    stack: error && error.stack ? error.stack.slice(0, 500) : null,
    statusCode: error && error.statusCode ? error.statusCode : null,
    responseBody: error && error.responseBody ? error.responseBody.slice(0, 500) : null,
  };
}

function addDebug(body, error, extra) {
  if (body && typeof body === "object") body.debug = buildDebugInfo(error, extra);
  return body;
}

function isDebugRequest(req) {
  return Boolean(req && req.query && req.query.debug === "1");
}

function buildUnhandledErrorBody(error, debug) {
  const body = fallbackUnknown();
  if (debug) addDebug(body, error);
  return body;
}

async function callGemini(apiKey, text) {
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = [
    "You are a pediatric first-pass triage assistant for caregivers.",
    "Do not diagnose and do not prescribe medication.",
    "Return ONLY valid JSON. No markdown. No explanation. No prefix such as 'Here is'.",
    'Required JSON shape: {"level":"emergency|urgent|mild|unknown","summary":"Korean one-sentence summary","advice":"Korean safety advice including 119 or emergency room guidance","redFlags":["Korean red flag phrases"]}',
    "Use emergency for breathing difficulty, altered consciousness, seizure, blue lips/cyanosis, no response, seizure longer than 5 minutes, or similar red flags.",
    "Use urgent when same-day medical advice or clinic visit is recommended.",
    "Use mild for minor symptoms suitable for observation and routine care.",
    "Use unknown when there is not enough information.",
    "Always mention that this is reference guidance and that emergency symptoms require calling 119 or going to an emergency room.",
    "",
    "Caregiver input:",
    text,
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
              level: { type: "STRING", enum: ["emergency", "urgent", "mild", "unknown"] },
              summary: { type: "STRING" },
              advice: { type: "STRING" },
              redFlags: { type: "ARRAY", items: { type: "STRING" } },
            },
            required: ["level", "summary", "advice", "redFlags"],
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
    const textPart = answer.map((part) => part.text || "").join("").trim();
    if (!textPart) {
      const error = new Error("Gemini returned empty text response");
      error.model = model;
      error.responseBody = JSON.stringify(data).slice(0, 500);
      throw error;
    }
    try {
      return normalizeResult(extractJson(textPart));
    } catch (error) {
      error.model = model;
      error.responseBody = error.responseBody || textPart.slice(0, 500);
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

async function triageHandler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    sendSafeJson(res, 405, { error: "POST only" });
    return;
  }

  const debug = isDebugRequest(req);
  const parsed = parseBody(req);
  if (!parsed.ok) {
    const body = invalidRequestBody();
    if (debug) addDebug(body, parsed.error);
    sendSafeJson(res, 400, body);
    return;
  }

  const body = parsed.body || {};
  const text = String(body.text || "").trim();
  if (!text) {
    sendSafeJson(res, 400, normalizeResult({
      level: "unknown",
      summary: "입력된 증상이 없습니다.",
      advice: "아이 증상을 문장으로 입력해주세요. 위험 증상이 있으면 119 또는 응급실로 이동하세요.",
      redFlags: [],
    }));
    return;
  }

  const hit = findEmergencyKeyword(text);
  if (hit) {
    sendSafeJson(res, 200, {
      level: "emergency",
      summary: "응급 위험 신호가 감지됐습니다.",
      advice: "AI 문진을 기다리지 말고 즉시 119에 연락하거나 응급실로 이동하세요.",
      redFlags: [hit],
    });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const fallback = fallbackUnknown();
    if (debug) addDebug(fallback, new Error("GEMINI_API_KEY is not configured"));
    sendSafeJson(res, 200, fallback);
    return;
  }

  try {
    const result = await callGemini(apiKey, text);
    if (debug) addDebug(result, null);
    sendSafeJson(res, 200, result);
  } catch (error) {
    console.error("Gemini triage failed:", error);
    const fallback = fallbackUnknown();
    if (debug) addDebug(fallback, error, { model: error.model });
    sendSafeJson(res, 200, fallback);
  }
}

module.exports = async (req, res) => {
  const debug = isDebugRequest(req);
  try {
    await triageHandler(req, res);
  } catch (error) {
    console.error("Triage handler failed:", error);
    sendSafeJson(res, 200, buildUnhandledErrorBody(error, debug));
  }
};
