import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import execution from "k6/execution";
import { loadConfig } from "../src/config.js";
import { createVoucher } from "../src/voucher-flow.js";
import { recordOperation, businessSuccess, flowFailureRate } from "../src/metrics.js";
import { acquireSession, invalidateSession, prepareSession, sessionIdentityChanged } from "../src/session-policy.js";
import { sessionPolicyForCondition, validateSessionComparisonProfile } from "./session-condition.js";
import { writeSessionSummary } from "./session-summary.js";

const cfg = loadConfig();
const experimentConfig = validateSessionComparisonProfile(JSON.parse(open("./session-comparison.json")));
const condition = __ENV.EXPERIMENT_CONDITION;
const conditionConfig = experimentConfig.conditions[condition];
if (!conditionConfig) throw new Error("EXPERIMENT_CONDITION debe ser shared o independent.");
cfg.sessionPolicy = sessionPolicyForCondition(condition);
const voucherTemplates = new SharedArray("plantillas experimento sesión", () => JSON.parse(open("../data/vouchers.json")));
const testConfig = cfg.testConfig;

export const options = {
  scenarios: {
    sessionComparison: {
      executor: experimentConfig.executor,
      vus: experimentConfig.vus,
      iterations: experimentConfig.iterationsPerVu,
      maxDuration: experimentConfig.maxDuration,
      gracefulStop: experimentConfig.gracefulStop,
      exec: "runExperiment",
    },
  },
  thresholds: testConfig.thresholds,
  noCookiesReset: true,
  userAgent: "dip-cat-v-final/session-experiment",
  ...(cfg.mode === "cloud" ? { cloud: {
    name: `session-${condition}-${cfg.runId}`,
    ...(__ENV.K6_CLOUD_PROJECT_ID ? { projectID: Number(__ENV.K6_CLOUD_PROJECT_ID) } : {}),
    distribution: { experiment: { loadZone: experimentConfig.cloud.loadZone, percent: 100 } },
  } } : {}),
};

export function handleSummary(data) {
  if (cfg.mode === "cloud") return {};
  return writeSessionSummary(data);
}

export function setup() {
  const setupData = prepareSession({ http, cfg, check, recordOperation });
  const ready = setupData === null || setupData.ok;
  console.log(`EXPERIMENT_SETUP ${JSON.stringify({
    condition,
    vus: experimentConfig.vus,
    prepared: ready,
    authenticationCount: setupData === null ? 0 : 1,
    sameServerSession: condition === "shared" ? !!setupData?.ok : null,
    reason: setupData?.ok === false ? setupData.reason : undefined,
  })}`);
  return setupData;
}

function findTemplate(type) {
  return voucherTemplates.find((voucher) => voucher.type === type);
}

function errorMessage(error) {
  return String(error?.message || error || "Error sin detalle.").replace(/[\r\n]+/g, " ").slice(0, 300);
}

export function runExperiment(setupData) {
  const vu = execution.vu.idInTest;
  const iterationIndex = execution.vu.iterationInScenario;
  const type = experimentConfig.typeByIteration[iterationIndex];
  const data = findTemplate(type);
  const iteration = iterationIndex + 1;
  const scenario = conditionConfig.scenarioCode;
  const glosa = `DIP_Cato-G6-${cfg.runId}-${scenario}-V${vu}-I${iteration}`;
  const metadata = {
    runId: cfg.runId,
    test: experimentConfig.profile,
    mode: cfg.mode,
    condition,
    scenario,
    type,
    vu,
    iteration,
    glosa,
  };
  let result = { ok: false, event: { status: "failed-before-save", stage: "session", error: null } };
  let saveTiming = null;
  let session = null;
  try {
    if (!data) throw new Error("Falta la plantilla del tipo configurado.");
    if (!check(glosa, { "glosa dentro del largo validado": (value) => value.length <= 44 })) {
      throw new Error("La glosa supera los 44 caracteres validados.");
    }
    const acquired = acquireSession({ http, cfg, check, vu, iteration: iterationIndex + 1, recordOperation }, setupData);
    if (!acquired.ok) {
      result = { ok: false, event: { status: "failed-before-save", stage: acquired.stage || "authentication",
        error: { name: "SessionError", message: acquired.reason || "No se obtuvo una sesión autenticada." } } };
    } else {
      session = acquired.session;
      result = createVoucher({
        http,
        check,
        session,
        cfg,
        data,
        glosa,
        vu,
        iteration,
        scenario,
        runId: cfg.runId,
        testName: experimentConfig.profile,
        recordOperation,
        onSessionInvalidResponse: (_response, currentSession) => invalidateSession(vu, currentSession),
        onSaveTiming: (timing) => { saveTiming = timing; },
      });
    }
  } catch (error) {
    result = {
      ok: false,
      event: { status: "failed-before-save", stage: "session-preflight", error: errorMessage(error) },
    };
  }

  const identityChanged = session ? sessionIdentityChanged(session, cfg.baseUrl) : null;
  const event = { ...metadata, ...(result?.event || {}), sessionIdentityChanged: identityChanged };
  if (saveTiming) event.saveInterval = saveTiming;
  console.log(`MANIFEST ${JSON.stringify(event)}`);
  businessSuccess.add(!!result?.ok, { voucher_type: String(type) });
  flowFailureRate.add(!result?.ok, { voucher_type: String(type) });
  sleep(experimentConfig.pauseSeconds);
}
