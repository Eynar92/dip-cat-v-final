import { SharedArray } from "k6/data";

const vouchers = new SharedArray("comprobantes", () => JSON.parse(open("../data/vouchers.json")));
const thresholds = JSON.parse(open(`../thresholds/${__ENV.THRESHOLD_PROFILE || "smoke"}.json`));

function required(name, value) {
  if (!value) throw new Error(`Falta configurar ${name}.`);
  return value;
}

export function loadConfig() {
  const environment = JSON.parse(open(`../config/${__ENV.ENVIRONMENT || "environment"}.json`));
  const baseUrl = (__ENV.FINANCIERO_BASE_URL || environment.baseUrl).replace(/\/$/, "");
  const mode = __ENV.EXECUTION_MODE || "local";
  required("FINANCIERO_USER", __ENV.FINANCIERO_USER);
  required("FINANCIERO_PASSWORD", __ENV.FINANCIERO_PASSWORD);
  if (!["local", "hybrid", "cloud"].includes(mode)) throw new Error("EXECUTION_MODE debe ser local, hybrid o cloud.");
  return { ...environment, baseUrl, mode, user: __ENV.FINANCIERO_USER, password: __ENV.FINANCIERO_PASSWORD,
    runId: __ENV.RUN_ID || `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(2, 12)}${Math.random().toString(36).slice(2, 8)}`,
    thresholds, vouchers };
}

export function thresholdsFor(profile) {
  return JSON.parse(open(`../thresholds/${profile}.json`));
}
