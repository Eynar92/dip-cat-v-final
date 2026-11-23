import http from "k6/http";
import { check } from "k6";
import execution from "k6/execution";
import { acquireSession, invalidateSession, prepareSession } from "../../src/session-policy.js";
import { getRequest } from "../../src/http-client.js";
import { writeSafeSummary } from "../../src/session-summary.js";

const cfg = {
  baseUrl: __ENV.FINANCIERO_BASE_URL,
  requestTimeout: "3s",
  sessionPolicy: __ENV.SESSION_POLICY,
  user: "offline-user",
  password: "offline-password",
};

export const options = {
  scenarios: {
    probe: {
      executor: "per-vu-iterations",
      vus: Number(__ENV.PROBE_VUS || 2),
      iterations: Number(__ENV.PROBE_ITERATIONS || 2),
      exec: "run",
    },
  },
  noCookiesReset: true,
  thresholds: { checks: ["rate==1"] },
};

function requestContext(vu, iteration) {
  return { http, cfg, check, vu, iteration, recordOperation() {} };
}

export function setup() {
  return prepareSession(requestContext(0, 0));
}

export function run(setupData) {
  const vu = execution.vu.idInTest;
  const iteration = execution.vu.iterationInScenario + 1;
  let ctx = requestContext(vu, iteration);
  let input = setupData;
  if (__ENV.FORCE_INSTALL_EXCEPTION === "true") {
    const sentinel = "SESSION_COOKIE_SENTINEL_OFFLINE_38ca";
    input = { ...setupData, cookies: setupData.cookies.map((cookie, index) =>
      index === 0 ? { ...cookie, value: sentinel } : cookie) };
    ctx = { ...ctx, http: { cookieJar: () => ({
      clear() {},
      set(_url, _name, value) { throw new Error(value); },
      cookiesForURL() { return {}; },
    }) } };
  }
  const acquired = acquireSession(ctx, input);
  if (!acquired.ok) {
    const event = { vu, iteration, status: "failed-before-save", stage: acquired.stage || "authentication",
      error: acquired.reason || "No se pudo obtener una sesión autenticada." };
    console.log(`MANIFEST ${JSON.stringify(event)}`);
    check(false, { "session was acquired": (value) => value });
    return;
  }
  const response = getRequest({ ...ctx, session: acquired.session, path: "probe",
    operation: "offline_probe", options: { headers: { "X-Test-VU": String(vu), "X-Test-Iteration": String(iteration) } },
    onSessionInvalidResponse: () => invalidateSession(vu, acquired.session) });
  check(response, { "protected offline route responded": (value) => value.status === 200 || value.status === 401 });
}

export function handleSummary(summary) {
  return writeSafeSummary(summary, __ENV.K6_SAFE_SUMMARY_PATH);
}
