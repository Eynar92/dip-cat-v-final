import http from "k6/http";
import { check, group, sleep } from "k6";
import { SharedArray } from "k6/data";
import execution from "k6/execution";
import { loadConfig } from "./config.js";
import { buildScenario } from "../config/test-config.js";
import { flowFailureRate, recordOperation, businessSuccess } from "./metrics.js";
import { createVoucher } from "./voucher-flow.js";
import { acquireSession, invalidateSession, prepareSession } from "./session-policy.js";
import { withoutSetupData, writeSafeSummary } from "./session-summary.js";

const cfg = loadConfig();
if (cfg.mode === "cloud" && !cfg.cloud.loadZone) {
  throw new Error("Define una zona cloud válida en cloud.loadZone o K6_CLOUD_LOAD_ZONE.");
}
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
  noCookiesReset: ["per-vu", "shared"].includes(cfg.sessionPolicy),
  userAgent: "dip-cat-v-final/k6",
  ...(cfg.mode === "cloud" ? { cloud: {
    distribution: { [cfg.cloud.loadZone]: { loadZone: cfg.cloud.loadZone, percent: 100 } },
  } } : {}),
};

export function setup() {
  try {
    return prepareSession({ http, cfg, check, recordOperation });
  } catch {
    return { ok: false, stage: "session-preparation", reason: "No se pudo preparar la sesión compartida." };
  }
}

export function handleSummary(summary) {
  if (cfg.mode === "cloud") return {};
  const destination = __ENV.K6_SAFE_SUMMARY_PATH;
  if (destination) return writeSafeSummary(summary, destination);
  return { stdout: `${JSON.stringify(withoutSetupData(summary), null, 2)}\n` };
}

export function runVoucher(setupData) {
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
      const sessionContext = { http, cfg, check, vu, iteration, recordOperation };
      let acquired;
      try {
        acquired = acquireSession(sessionContext, setupData);
      } catch {
        acquired = { ok: false, stage: "session", reason: "No se pudo preparar o instalar la sesión." };
      }
      if (!acquired.ok) {
        result = { ok: false, event: {
          status: "failed-before-save",
          stage: acquired.stage || "authentication",
          error: { name: "SessionError", message: acquired.reason || "No se pudo obtener una sesión autenticada." },
        } };
      } else {
        const session = acquired.session;
        result = group(`comprobante:${data.name}`, () => createVoucher({
        http,
        check,
        cfg,
        session,
        data,
        glosa,
        vu,
        iteration,
        scenario: test.scenarioCode,
        recordOperation,
        businessSuccess,
        onSessionInvalidResponse: (_response, currentSession) => invalidateSession(vu, currentSession),
        }));
      }
    } catch {
      result = { ok: false, event: { status: "failed-before-save", stage: "flow-exception",
        error: { name: "Error", message: "Error inesperado en el flujo; no se guardaron detalles técnicos." } } };
    }
  }

  const event = { ...metadata, ...(result?.event || {}) };
  console.log(`MANIFEST ${JSON.stringify(event)}`);
  businessSuccess.add(!!result?.ok, { voucher_type: String(type) });
  flowFailureRate.add(!result?.ok, { voucher_type: String(type) });
  sleep(test.pauseSeconds);
}
