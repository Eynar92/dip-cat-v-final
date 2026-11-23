import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import execution from "k6/execution";
import { loadConfig } from "../src/config.js";
import { authenticate, checkAuthenticatedSession } from "../src/workflow.js";
import { createVoucher } from "../src/voucher-flow.js";
import { recordOperation, businessSuccess, flowFailureRate } from "../src/metrics.js";
import { writeSessionSummary } from "./session-summary.js";
import {
  captureResponseCookies,
  exportActiveCookies,
  findSessionIdentity,
  installCookies,
  jarHasIdentity,
  prepareSessionPlan,
} from "./session-cookies.js";

const cfg = loadConfig();
const experimentConfig = JSON.parse(open("./session-comparison.json"));
const condition = __ENV.EXPERIMENT_CONDITION;
const conditionConfig = experimentConfig.conditions[condition];
if (!conditionConfig) throw new Error("EXPERIMENT_CONDITION debe ser shared o independent.");
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

function operationContext(session, onAuthResponse = null) {
  return { http, cfg, check, session, recordOperation, onAuthResponse };
}

function loginSession() {
  const jar = new http.CookieJar();
  const cookieStore = new Map();
  const session = { jar };
  const context = operationContext(session, (response, requestUrl) => captureResponseCookies(cookieStore, response, requestUrl));
  const login = authenticate(context, session);
  if (!login.ok) throw new Error("Falló la autenticación de preparación.");
  const cookies = exportActiveCookies(jar, cfg.baseUrl, cookieStore);
  const identity = findSessionIdentity(cookies);
  return { cookies, identity };
}

function verifyPreparedSession(preparedSession) {
  const jar = new http.CookieJar();
  const cookieStore = new Map(preparedSession.cookies.map((cookie) => [
    `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}\u0000${cookie.host_only ? "host" : "domain"}`, cookie,
  ]));
  installCookies(jar, cfg.baseUrl, preparedSession.cookies);
  const originalIdentityPresent = jarHasIdentity(jar, cfg.baseUrl, preparedSession.identity);
  const context = operationContext({ jar }, (response, requestUrl) => captureResponseCookies(cookieStore, response, requestUrl));
  const authenticated = checkAuthenticatedSession(context, { jar });
  if (!authenticated || !originalIdentityPresent) return false;

  const updatedCookies = exportActiveCookies(jar, cfg.baseUrl, cookieStore);
  preparedSession.cookies = updatedCookies;
  preparedSession.identity = findSessionIdentity(updatedCookies);
  return true;
}

export function setup() {
  const plan = prepareSessionPlan(condition, {
    vus: experimentConfig.vus,
    login: () => loginSession(),
    verify: (_session, _vu) => verifyPreparedSession(_session),
  });
  console.log(`EXPERIMENT_SETUP ${JSON.stringify({
    condition,
    vus: plan.vuSessions.length,
    authenticationCount: plan.authenticationCount,
    authenticated: plan.authenticated,
    sameServerSession: plan.sameServerSession,
  })}`);
  return { condition, vuSessions: plan.vuSessions };
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
  const preparedSession = setupData.vuSessions[vu - 1];
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
  try {
    if (!preparedSession || !data) throw new Error("Falta la sesión preparada o la plantilla del tipo configurado.");
    const jar = http.cookieJar();
    if (iterationIndex === 0) {
      jar.clear(cfg.baseUrl);
      installCookies(jar, cfg.baseUrl, preparedSession.cookies);
    }
    const identityInstalled = jarHasIdentity(jar, cfg.baseUrl, preparedSession.identity);
    if (!identityInstalled) throw new Error("La cookie de sesión esperada no quedó instalada en el VU.");
    if (!check(glosa, { "glosa dentro del largo validado": (value) => value.length <= 44 })) {
      throw new Error("La glosa supera los 44 caracteres validados.");
    }
    result = createVoucher({
      ...operationContext({ jar, authenticated: true }),
      session: { jar, authenticated: true },
      cfg,
      data,
      glosa,
      vu,
      iteration,
      scenario,
      runId: cfg.runId,
      testName: experimentConfig.profile,
      onSaveTiming: (timing) => { saveTiming = timing; },
    });
  } catch (error) {
    result = {
      ok: false,
      event: { status: "failed-before-save", stage: "session-preflight", error: errorMessage(error) },
    };
  }

  const sessionIdentityChanged = preparedSession
    ? !jarHasIdentity(http.cookieJar(), cfg.baseUrl, preparedSession.identity)
    : null;
  const event = { ...metadata, ...(result?.event || {}), sessionIdentityChanged };
  if (saveTiming) event.saveInterval = saveTiming;
  console.log(`MANIFEST ${JSON.stringify(event)}`);
  businessSuccess.add(!!result?.ok, { voucher_type: String(type) });
  flowFailureRate.add(!result?.ok, { voucher_type: String(type) });
  sleep(experimentConfig.pauseSeconds);
}
