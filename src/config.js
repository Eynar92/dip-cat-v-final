import { validateTestCatalog } from "../config/test-config.js";

const TEST_CATALOG = validateTestCatalog(JSON.parse(open("../config/tests.json")));

function required(name, value) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Falta configurar ${name}.`);
  }
  return value;
}

export function loadConfig() {
  const environment = JSON.parse(open("../config/environment.json"));
  const testName = required("TEST_NAME", __ENV.TEST_NAME);
  const testConfig = TEST_CATALOG.tests[testName];
  if (!testConfig) throw new Error(`Test desconocido: ${testName}.`);

  const baseUrl = (__ENV.FINANCIERO_BASE_URL || environment.baseUrl || "").replace(/\/$/, "");
  const mode = required("EXECUTION_MODE", __ENV.EXECUTION_MODE);
  const runId = required("RUN_ID", __ENV.RUN_ID);
  const sessionPolicy = environment.sessionPolicy || "per-iteration";

  required("FINANCIERO_USER", __ENV.FINANCIERO_USER);
  required("FINANCIERO_PASSWORD", __ENV.FINANCIERO_PASSWORD);
  if (!["local", "hybrid", "cloud"].includes(mode)) throw new Error("EXECUTION_MODE debe ser local, hybrid o cloud.");
  if (!/^[A-Za-z0-9]{1,16}$/.test(runId)) throw new Error("RUN_ID debe ser alfanumérico y tener como máximo 16 caracteres.");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("FINANCIERO_BASE_URL debe comenzar con http:// o https://.");
  if (!["per-iteration", "per-vu"].includes(sessionPolicy)) {
    throw new Error("sessionPolicy debe ser per-iteration o per-vu.");
  }

  return {
    runId,
    testName,
    mode,
    baseUrl,
    expectedContext: environment.expectedContext,
    requestTimeout: environment.requestTimeout || "30s",
    sessionPolicy,
    user: __ENV.FINANCIERO_USER,
    password: __ENV.FINANCIERO_PASSWORD,
    testConfig,
  };
}
