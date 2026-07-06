const HOSP_BASIS_ENDPOINT = "https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList";
const DETAIL_BASE_ENDPOINT = "https://apis.data.go.kr/B551182/MadmDtlInfoService2.8";

const SIDO_GYEONGGI = "310000";
const PEDIATRICS_CODE = "11";
const ROWS_PER_PAGE = 200;
const MAX_SCAN_PAGES = 160;
const PAGE_CONCURRENCY = 3;
const ENRICH_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 12000;
const DETAIL_TIMEOUT_MS = 4500;
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

function buildUrl(endpoint, serviceKey, params) {
  const query = new URLSearchParams(params || {});
  query.set("serviceKey", normalizeServiceKey(serviceKey));
  return endpoint + "?" + query.toString();
}

function buildHospBasisUrl(serviceKey, pageNo) {
  return buildUrl(HOSP_BASIS_ENDPOINT, serviceKey, {
    pageNo: String(pageNo),
    numOfRows: String(ROWS_PER_PAGE),
    sidoCd: SIDO_GYEONGGI,
  });
}

function buildDetailUrl(serviceKey, operation, ykiho) {
  return buildUrl(DETAIL_BASE_ENDPOINT + "/" + operation, serviceKey, { ykiho });
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

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHira(url, timeoutMs) {
  const raw = await fetchWithTimeout(url, timeoutMs);
  if (!raw.ok) throw new Error("HIRA HTTP " + raw.status);
  const parsed = parseHiraResponse(raw.text);
  if (parsed.resultCode && parsed.resultCode !== "00") {
    throw new Error("HIRA resultCode=" + parsed.resultCode + " " + (parsed.resultMsg || ""));
  }
  return { status: raw.status, parsed };
}

async function fetchPage(serviceKey, pageNo) {
  const url = buildHospBasisUrl(serviceKey, pageNo);
  const result = await fetchHira(url, FETCH_TIMEOUT_MS);
  return { pageNo, requestUrl: maskServiceKey(url), parsed: result.parsed };
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

function normalizeTime(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.padStart(4, "0").slice(0, 4);
}

function pairHours(item, startKey, endKey) {
  const start = normalizeTime(item[startKey]);
  const end = normalizeTime(item[endKey]);
  return start && end ? { start, end } : null;
}

function mapHours(detailItem) {
  if (!detailItem) return null;
  const hours = {
    mon: pairHours(detailItem, "trmtMonStart", "trmtMonEnd"),
    tue: pairHours(detailItem, "trmtTueStart", "trmtTueEnd"),
    wed: pairHours(detailItem, "trmtWedStart", "trmtWedEnd"),
    thu: pairHours(detailItem, "trmtThuStart", "trmtThuEnd"),
    fri: pairHours(detailItem, "trmtFriStart", "trmtFriEnd"),
    sat: pairHours(detailItem, "trmtSatStart", "trmtSatEnd"),
    sun: pairHours(detailItem, "trmtSunStart", "trmtSunEnd"),
    hol: pairHours(detailItem, "trmtHoliStart", "trmtHoliEnd"),
  };
  return Object.values(hours).some(Boolean) ? hours : null;
}

function dayKey(now) {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][now.getDay()];
}

function minutesFromHHMM(value) {
  if (!value) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(2, 4));
}

function getTodayOpenStatus(hours, now = new Date()) {
  if (!hours) return null;
  const today = hours[dayKey(now)];
  if (!today) return null;
  const start = minutesFromHHMM(today.start);
  const end = minutesFromHHMM(today.end);
  if (start == null || end == null) return null;
  const current = now.getHours() * 60 + now.getMinutes();
  return current >= start && current < end;
}

function setClinicsCacheHeader(res, clinics, enrichment) {
  const withHoursCount = clinics.filter((clinic) => clinic.hours).length;
  const isGoodClinicsResponse =
    clinics.length >= 50 &&
    withHoursCount >= 10 &&
    enrichment.subjectStats.pediatrics >= 50 &&
    enrichment.detailStats.failed === 0;

  res.setHeader(
    "Cache-Control",
    isGoodClinicsResponse ? "s-maxage=21600, stale-while-revalidate=86400" : "no-store"
  );

  return { withHoursCount, isGoodClinicsResponse };
}

function formatTime(value) {
  return value ? value.slice(0, 2) + ":" + value.slice(2, 4) : "";
}

function formatTodayHours(hours, now = new Date()) {
  if (!hours) return "진료시간 확인 필요";
  const today = hours[dayKey(now)];
  if (!today) return "진료시간 확인 필요";
  return formatTime(today.start) + "~" + formatTime(today.end);
}

function hasPediatrics(subjectItems) {
  return subjectItems.some((item) => {
    const code = String(item.dgsbjtCd || item.dgsbjtCdNmCd || "").trim();
    const name = String(item.dgsbjtCdNm || item.dgsbjtNm || "").trim();
    return code === PEDIATRICS_CODE || name.includes("소아청소년과");
  });
}

function toClinic(item, index, enrichment) {
  const name = item.yadmNm || "";
  const address = item.addr || "";
  const ykiho = item.ykiho || null;
  const zone = inferZone(address);
  const hours = enrichment && enrichment.hours ? enrichment.hours : null;
  const departments = enrichment && enrichment.departments && enrichment.departments.length
    ? enrichment.departments
    : ["소아청소년과 확인 필요"];
  return {
    id: ykiho || name + "-" + address || "hira-" + index,
    ykiho,
    name,
    address,
    phone: item.telno || "",
    lat: toNumber(item.YPos || item.yPos),
    lng: toNumber(item.XPos || item.xPos),
    type: "소아청소년과",
    zone,
    zoneId: zone,
    departments,
    hours,
    todayOpen: getTodayOpenStatus(hours),
    openText: formatTodayHours(hours),
    isReal: true,
    source: "public-api",
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

  for (let pageNo = 2; pageNo <= maxPagesAllowed; pageNo += PAGE_CONCURRENCY) {
    const batch = [];
    for (let offset = 0; offset < PAGE_CONCURRENCY && pageNo + offset <= maxPagesAllowed; offset += 1) {
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

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i += 1) workers.push(runOne());
  await Promise.all(workers);
  return results;
}

async function fetchSubjects(serviceKey, ykiho) {
  const url = buildDetailUrl(serviceKey, "getDgsbjtInfo2.8", ykiho);
  const result = await fetchHira(url, DETAIL_TIMEOUT_MS);
  return { requestUrl: maskServiceKey(url), items: result.parsed.items };
}

async function fetchDetail(serviceKey, ykiho) {
  const url = buildDetailUrl(serviceKey, "getDtlInfo2.8", ykiho);
  const result = await fetchHira(url, DETAIL_TIMEOUT_MS);
  return { requestUrl: maskServiceKey(url), item: result.parsed.items[0] || null };
}

async function enrichClinics(serviceKey, baseItems) {
  const subjectStats = { checked: 0, pediatrics: 0, failed: 0 };
  const detailStats = { checked: 0, withHours: 0, failed: 0 };
  const sample = {};

  const subjectProbe = await runPool(baseItems.slice(0, 3), 3, async (item) => {
    try {
      const subjects = await fetchSubjects(serviceKey, item.ykiho);
      if (!sample.subjectRequestUrl) sample.subjectRequestUrl = subjects.requestUrl;
      if (!sample.subjectItem && subjects.items[0]) sample.subjectItem = subjects.items[0];
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  if (subjectProbe.length && subjectProbe.every((result) => !result.ok)) {
    subjectStats.failed = subjectProbe.length;
    sample.subjectProbeError = subjectProbe[0].message;
    return {
      detailResults: baseItems.map((item) => ({
        item,
        include: true,
        subjectUnknown: true,
        departments: ["진료과목 확인 필요"],
        hours: null,
      })),
      subjectStats,
      detailStats,
      sample,
    };
  }

  const subjectResults = await runPool(baseItems, ENRICH_CONCURRENCY, async (item) => {
    if (!item.ykiho) return { item, include: false, error: "missing ykiho", departments: [] };
    try {
      const subjects = await fetchSubjects(serviceKey, item.ykiho);
      subjectStats.checked += 1;
      if (!sample.subjectRequestUrl) sample.subjectRequestUrl = subjects.requestUrl;
      if (!sample.subjectItem && subjects.items[0]) sample.subjectItem = subjects.items[0];
      const include = hasPediatrics(subjects.items);
      if (include) subjectStats.pediatrics += 1;
      return {
        item,
        include,
        departments: include ? ["소아청소년과"] : subjects.items.map((s) => s.dgsbjtCdNm).filter(Boolean),
      };
    } catch (error) {
      subjectStats.failed += 1;
      return { item, include: true, subjectUnknown: true, error: error.message, departments: ["진료과목 확인 필요"] };
    }
  });

  const pediatricItems = subjectResults.filter((result) => result.include);
  const detailProbe = await runPool(pediatricItems.slice(0, 3), 3, async (subjectResult) => {
    try {
      const detail = await fetchDetail(serviceKey, subjectResult.item.ykiho);
      if (!sample.detailRequestUrl) sample.detailRequestUrl = detail.requestUrl;
      if (!sample.detailItem && detail.item) sample.detailItem = detail.item;
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  if (detailProbe.length && detailProbe.every((result) => !result.ok)) {
    detailStats.failed = detailProbe.length;
    sample.detailProbeError = detailProbe[0].message;
    return {
      detailResults: pediatricItems.map((subjectResult) => Object.assign({}, subjectResult, { hours: null })),
      subjectStats,
      detailStats,
      sample,
    };
  }

  const detailResults = await runPool(pediatricItems, ENRICH_CONCURRENCY, async (subjectResult) => {
    const item = subjectResult.item;
    try {
      const detail = await fetchDetail(serviceKey, item.ykiho);
      detailStats.checked += 1;
      if (!sample.detailRequestUrl) sample.detailRequestUrl = detail.requestUrl;
      if (!sample.detailItem && detail.item) sample.detailItem = detail.item;
      const hours = mapHours(detail.item);
      if (hours) detailStats.withHours += 1;
      return Object.assign({}, subjectResult, { hours });
    } catch (error) {
      detailStats.failed += 1;
      return Object.assign({}, subjectResult, { hours: null, detailError: error.message });
    }
  });

  return { detailResults, subjectStats, detailStats, sample };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.setHeader("Cache-Control", "no-store");
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.setHeader("Cache-Control", "no-store");
    res.status(405).json({ error: "GET only" });
    return;
  }

  const serviceKey = process.env.HIRA_SERVICE_KEY || process.env.PUBLIC_DATA_SERVICE_KEY;
  if (!serviceKey) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({
      error: "HIRA_SERVICE_KEY is not configured",
      hint: "Set HIRA_SERVICE_KEY in Vercel environment variables.",
    });
    return;
  }

  try {
    const debug = req.query && req.query.debug === "1";
    const scan = await scanGyeonggi(serviceKey);
    const baseItems = scan.hwaseongItems.filter((item) => item.yadmNm && item.addr);
    const enrichment = await enrichClinics(serviceKey, baseItems);
    const clinics = enrichment.detailResults
      .map((result, index) => toClinic(result.item, index, result))
      .filter((clinic) => clinic.name && clinic.address);
    const cache = setClinicsCacheHeader(res, clinics, enrichment);

    res.status(200).json({
      source: "HIRA",
      strategy: "sidoCd=310000 page scan, address includes 화성, getDgsbjtInfo2.8 pediatrics filter, getDtlInfo2.8 hours",
      count: clinics.length,
      withHoursCount: cache.withHoursCount,
      cacheStatus: cache.isGoodClinicsResponse ? "cacheable" : "no-store",
      scan: {
        totalCount: scan.totalCount,
        totalPages: scan.totalPages,
        maxPagesAllowed: scan.maxPagesAllowed,
        pagesScanned: scan.pagesScanned,
        itemsScanned: scan.itemsScanned,
        hwaseongCount: baseItems.length,
        pageErrors: scan.pageErrors,
        requestUrlSample: scan.requestUrlSample,
      },
      enrichment: {
        subject: enrichment.subjectStats,
        detail: enrichment.detailStats,
      },
      debug: debug ? enrichment.sample : undefined,
      clinics,
    });
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({
      error: "Failed to scan HIRA clinics",
      message: error.name === "AbortError" ? "HIRA request timed out" : error.message,
    });
  }
};
