import http from "k6/http";
import { check, group } from "k6";
import { SharedArray } from "k6/data";
import execution from "k6/execution";
import { loadConfig } from "./config.js";
import { flowFailureRate, recordOperation, businessSuccess } from "./metrics.js";
import { createVoucher } from "./voucher-flow.js";
import { sleep } from "k6";

const cfg = loadConfig();
const vouchers = new SharedArray("datos comprobantes", () => JSON.parse(open("../data/vouchers.json")));
const selected = __ENV.VOUCHER_TYPES ? __ENV.VOUCHER_TYPES.split(",").map(Number) : [1, 2, 3, 4];
const scenarioCodes = { smoke: "SM", "concurrency-validation": "CV", baseline: "BL", sustained: "SU", spike: "SP", stress: "ST" };
const scenarioCode = scenarioCodes[__ENV.LOAD_PROFILE || "smoke"];
const profile = JSON.parse(open(`../profiles/${__ENV.LOAD_PROFILE || "smoke"}.json`));
const thresholds = JSON.parse(open(`../thresholds/${__ENV.THRESHOLD_PROFILE || "smoke"}.json`));

export const options = {
  scenarios: { comprobantes: profile.stages
    ? { executor: "ramping-vus", stages: profile.stages, gracefulRampDown: "30s", exec: "runVoucher" }
    : profile.duration
      ? { executor: "constant-vus", vus: profile.vus || 1, duration: profile.duration, exec: "runVoucher" }
      : { executor: "per-vu-iterations", vus: profile.vus || 1, iterations: profile.iterations || selected.length,
          maxDuration: profile.maxDuration || "10m", exec: "runVoucher" } },
  thresholds,
  userAgent: "dip-cat-v-final/k6",
};

export function runVoucher() {
  const type = selected[execution.scenario.iterationInTest % selected.length];
  const data = vouchers.find((voucher) => voucher.type === type);
  const label = `${data.name}`;
  const vu = execution.vu.idInTest;
  const iteration = execution.vu.iterationInScenario + 1;
  const scenario = scenarioCode;
  const glosa = `DIP_Cato-G6-${cfg.runId}-${scenario}-V${vu}-I${iteration}`;
  let result;
  try {
    result = group(`comprobante:${label}`, () => createVoucher({ http, check, cfg, data, glosa, vu, iteration, scenario, recordOperation, businessSuccess }));
  } catch (_) {
    result = { ok: false };
  }
  businessSuccess.add(!!(result && result.ok), { voucher_type: String(type) });
  flowFailureRate.add(!(result && result.ok), { voucher_type: String(type) });
  sleep(Number(__ENV.THINK_TIME_SECONDS || 3));
}
