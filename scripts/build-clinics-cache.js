const fs = require("fs");
const path = require("path");

const {
  buildLiveClinicsPayload,
  getClinicsPayloadQuality,
  STATIC_CACHE_PATH,
} = require("../api/clinics");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

async function main() {
  const root = path.join(__dirname, "..");
  loadEnvFile(path.join(root, ".env.local"));
  loadEnvFile(path.join(root, ".env"));

  const serviceKey = process.env.HIRA_SERVICE_KEY || process.env.PUBLIC_DATA_SERVICE_KEY;
  if (!serviceKey) {
    throw new Error("HIRA_SERVICE_KEY or PUBLIC_DATA_SERVICE_KEY is required.");
  }

  const payload = await buildLiveClinicsPayload(serviceKey, { debug: false });
  const quality = getClinicsPayloadQuality(payload);
  if (!quality.isGoodClinicsResponse) {
    throw new Error(
      "Refusing to write clinics cache: quality gate failed " +
        JSON.stringify({
          count: payload.clinics && payload.clinics.length,
          withHoursCount: quality.withHoursCount,
          pediatrics: payload.enrichment && payload.enrichment.subject && payload.enrichment.subject.pediatrics,
          detailFailed: payload.enrichment && payload.enrichment.detail && payload.enrichment.detail.failed,
        })
    );
  }

  const cachePayload = Object.assign({}, payload, {
    cacheStatus: "static-cache-source",
    builtBy: "scripts/build-clinics-cache.js",
  });

  const dir = path.dirname(STATIC_CACHE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = STATIC_CACHE_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(cachePayload, null, 2), "utf8");
  fs.renameSync(tmpPath, STATIC_CACHE_PATH);

  console.log(
    JSON.stringify(
      {
        ok: true,
        path: path.relative(root, STATIC_CACHE_PATH),
        count: cachePayload.clinics.length,
        withHoursCount: quality.withHoursCount,
        pediatrics: cachePayload.enrichment.subject.pediatrics,
        detailFailed: cachePayload.enrichment.detail.failed,
        strategy: cachePayload.strategy,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
