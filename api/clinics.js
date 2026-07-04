const HIRA_ENDPOINT = "https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList";

const SIDO_GYEONGGI = "310000";
const ROWS_PER_PAGE = 200;
const MAX_SCAN_PAGES = 160;
const CONCURRENCY = 3;
const FETCH_TIMEOUT_MS = 20000;
const MIN_PAGES_BEFORE_STOP = 20;
const MIN_FOUND_BEFORE_STOP = 80;

function normalizeServiceKey(rawKey) {
  if (!rawKey) return "";
  if (!rawKey.includes("%")) return rawKey;
  try {
    return decodeURIComponent(rawKey);
  } catch (error) {
    return rawKey;
  }
}

function buildHiraUrl(serviceKey, pageNo) {
  const query = new URLSearchParams({
    pageNo: String(pageNo),
    numOfRows: String(ROWS_PER_PAGE),
    sidoCd: SIDO_GYEONGGI,
  });
  query.set("serviceKey", normalizeServiceKey(serviceKey));
  return HIRA_ENDPOINT + "?" + query.toString();
}

function maskServiceKey(url) {
  return url.replace(/([?&]serviceKey=)[^&]*/i, "$1[MASKED]");
}

function decodeXmlEntities(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readTag(xml, tagName) {
  const match = xml.match(new RegExp("<" + tagName + ">\\s*([\\s\\S]*?)\\s*<\\/" + tagName + ">"));
  return match ? decodeXmlEntities(match[1]).trim() : null;
}

function parseFields(xml) {
  const item = {};
  const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = re.exec(xml))) item[match[1]] = decodeXmlEntities(match[2]).trim();
  return item;
}

function normalizeItem(item) {
  if (!item) return {};
  if (typeof item === "string") return parseFields(item);
  if (typeof item.item === "string" && Object.keys(item).length === 1) return parseFields(item.item);
  if (typeof item.item === "string") return Object.assign({}, item, parseFields(item.item));
  return item;
}

function parseXmlItems(xml) {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return blocks.map((block) => normalizeItem(parseFields(block)));
}

function parseHiraResponse(text) {
  try {
    const json = JSON.parse(text);
    const header = json.response && json.response.header ? json.response.header : {};
    const body = json.response && json.response.body ? json.response.body : {};
    const rawItems = body.items && body.items.item ? body.items.item : [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];
    return {
      resultCode: header.resultCode || null,
      resultMsg: header.resultMsg || null,
      totalCount: typeof body.totalCount === "undefined" ? items.length : Number(body.totalCount),
      items: items.map(normalizeItem),
    };
  } catch (error) {
    return {
      resultCode: readTag(text, "resultCode"),
      resultMsg: readTag(text, "resultMsg"),
      totalCount: Number(readTag(text, "totalCount") || 0),
      items: parseXmlItems(text),
    };
  }
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPage(serviceKey, pageNo) {
  const url = buildHiraUrl(serviceKey, pageNo);
  const raw = await fetchWithTimeout(url);
  if (!raw.ok) throw new Error("HIRA HTTP " + raw.status);
  const parsed = parseHiraResponse(raw.text);
  if (parsed.resultCode && parsed.resultCode !== "00") {
    throw new Error("HIRA resultCode=" + parsed.resultCode + " " + (parsed.resultMsg || ""));
  }
  return { pageNo, requestUrl: maskServiceKey(url), parsed };
}

function isHwaseong(item) {
  const address = item.addr || item.address || "";
  return address.includes("화성");
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function inferZone(address) {
  const text = address || "";
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

function toClinic(item, index) {
  const name = item.yadmNm || "";
  const address = item.addr || "";
  const ykiho = item.ykiho || null;
  const zone = inferZone(address);
  return {
    id: ykiho || name + "-" + address || "hira-" + index,
    ykiho,
    name,
    address,
    phone: item.telno || "",
    lat: toNumber(item.YPos || item.yPos),
    lng: toNumber(item.XPos || item.xPos),
    openText: "진료시간 확인 필요",
    type: item.clCdNm || "의료기관",
    zone,
    zoneId: zone,
    isReal: true,
    source: "HIRA",
  };
}

async function scanGyeonggi(serviceKey) {
  const first = await fetchPage(serviceKey, 1);
  const totalCount = first.parsed.totalCount || first.parsed.items.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / ROWS_PER_PAGE));
  const maxPagesAllowed = Math.min(totalPages, MAX_SCAN_PAGES);

  const pages = [first];
  const pageErrors = [];
  const allItems = first.parsed.items.slice();
  const hwaseongItems = first.parsed.items.filter(isHwaseong);

  for (let pageNo = 2; pageNo <= maxPagesAllowed; pageNo += CONCURRENCY) {
    const batch = [];
    for (let offset = 0; offset < CONCURRENCY && pageNo + offset <= maxPagesAllowed; offset += 1) {
      const currentPage = pageNo + offset;
      batch.push(
        fetchPage(serviceKey, currentPage)
          .then((page) => ({ ok: true, page }))
          .catch((error) => ({ ok: false, pageNo: currentPage, message: error.message }))
      );
    }

    const results = await Promise.all(batch);
    for (const result of results) {
      if (!result.ok) {
        pageErrors.push({ pageNo: result.pageNo, message: result.message });
        continue;
      }
      pages.push(result.page);
      allItems.push(...result.page.parsed.items);
      hwaseongItems.push(...result.page.parsed.items.filter(isHwaseong));
    }

    if (pages.length >= MIN_PAGES_BEFORE_STOP && hwaseongItems.length >= MIN_FOUND_BEFORE_STOP) break;
  }

  return {
    totalCount,
    totalPages,
    maxPagesAllowed,
    pagesScanned: pages.length,
    itemsScanned: allItems.length,
    requestUrlSample: first.requestUrl,
    pageErrors,
    hwaseongItems,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }

  const serviceKey = process.env.HIRA_SERVICE_KEY || process.env.PUBLIC_DATA_SERVICE_KEY;
  if (!serviceKey) {
    res.status(500).json({
      error: "HIRA_SERVICE_KEY is not configured",
      hint: "Set HIRA_SERVICE_KEY in Vercel environment variables.",
    });
    return;
  }

  try {
    const scan = await scanGyeonggi(serviceKey);
    const clinics = scan.hwaseongItems
      .map(toClinic)
      .filter((clinic) => clinic.name && clinic.address);

    res.status(200).json({
      source: "HIRA",
      strategy: "sidoCd=310000 page scan, address includes 화성",
      count: clinics.length,
      scan: {
        totalCount: scan.totalCount,
        totalPages: scan.totalPages,
        maxPagesAllowed: scan.maxPagesAllowed,
        pagesScanned: scan.pagesScanned,
        itemsScanned: scan.itemsScanned,
        pageErrors: scan.pageErrors,
        requestUrlSample: scan.requestUrlSample,
      },
      clinics,
    });
  } catch (error) {
    res.status(502).json({
      error: "Failed to scan HIRA clinics",
      message: error.name === "AbortError" ? "First page request timed out" : error.message,
    });
  }
};
