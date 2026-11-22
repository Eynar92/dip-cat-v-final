import http from "k6/http";
import { check, group, sleep } from "k6";
import { SharedArray } from "k6/data";
import execution from "k6/execution";
import { loadConfig } from "./config.js";
import { buildScenario } from "../config/test-config.js";
import { flowFailureRate, recordOperation, businessSuccess } from "./metrics.js";
import { createVoucher } from "./voucher-flow.js";

const cfg = loadConfig();
const test = cfg.testConfig;
const vouchers = new SharedArray("datos comprobantes", () => JSON.parse(open("../data/vouchers.json")));
const scenarioOptions = buildScenario(test);

for (const type of test.types) {
  const data = vouchers.find((voucher) => voucher.type === type);
  if (!data || !Array.isArray(data.lines) || data.lines.length !== 2 ||
      data.lines.some((line) => !line.accountNumber || !Number.isFinite(line.debit) || !Number.isFinite(line.credit) || line.debit < 0 || line.credit < 0)) {
    throw new Error(`Plantilla incompleta para el tipo ${type}.`);
  }
  const debit = data.lines.reduce((total, line) => total + line.debit, 0);
  const credit = data.lines.reduce((total, line) => total + line.credit, 0);
  if (debit !== credit) throw new Error(`La plantilla del tipo ${type} no está balanceada.`);
}

export const options = {
  scenarios: { comprobantes: scenarioOptions },
  thresholds: test.thresholds,
  userAgent: "dip-cat-v-final/k6",
};

function errorMessage(error) {
  if (error && typeof error.message === "string") return error.message.slice(0, 500);
  return String(error || "Error sin detalle.").slice(0, 500);
}

export function runVoucher() {
  const iterationIndex = execution.vu.iterationInScenario;
  const type = test.types[iterationIndex % test.types.length];
  const data = vouchers.find((voucher) => voucher.type === type);
  const vu = execution.vu.idInTest;
  const iteration = iterationIndex + 1;
  const glosa = `DIP_Cato-G6-${cfg.runId}-${test.scenarioCode}-V${vu}-I${iteration}`;
  const metadata = {
    runId: cfg.runId,
    test: cfg.testName,
    mode: cfg.mode,
    scenario: test.scenarioCode,
    type,
    vu,
    iteration,
    glosa,
  };

  let result = { ok: false, event: { status: "failed", stage: "not-started", error: null } };
  const glosaAllowed = check(glosa, { "glosa dentro del largo validado": (value) => value.length <= 44 });
  if (!glosaAllowed) {
    result.event = { status: "failed", stage: "glosa-validation", error: "La glosa supera los 44 caracteres validados." };
  } else {
    try {
      result = group(`comprobante:${data.name}`, () => createVoucher({
        http,
        check,
        cfg,
        data,
        glosa,
        vu,
        iteration,
        scenario: test.scenarioCode,
        recordOperation,
        businessSuccess,
      }));
    } catch (error) {
      result = { ok: false, event: { status: "failed", stage: "flow-exception", error: errorMessage(error) } };
    }
  }

  const event = { ...metadata, ...(result?.event || {}) };
  console.log(`MANIFEST ${JSON.stringify(event)}`);
  businessSuccess.add(!!result?.ok, { voucher_type: String(type) });
  flowFailureRate.add(!result?.ok, { voucher_type: String(type) });
  sleep(test.pauseSeconds);
}
