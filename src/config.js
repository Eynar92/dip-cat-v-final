const thresholds = JSON.parse(open(`../thresholds/${__ENV.THRESHOLD_PROFILE || "smoke"}.json`));

function required(name, value) {
  if (!value) throw new Error(`Falta configurar ${name}.`);
  return value;
}

export function loadConfig() {
  const environment = JSON.parse(open(`../config/${__ENV.ENVIRONMENT || "environment"}.json`));
  const baseUrl = (__ENV.FINANCIERO_BASE_URL || environment.baseUrl).replace(/\/$/, "");
  const mode = __ENV.EXECUTION_MODE || "local";
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  const runId = __ENV.RUN_ID || `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(2, 12)}${suffix}`;
  required("FINANCIERO_USER", __ENV.FINANCIERO_USER);
  required("FINANCIERO_PASSWORD", __ENV.FINANCIERO_PASSWORD);
  if (!["local", "hybrid", "cloud"].includes(mode)) throw new Error("EXECUTION_MODE debe ser local, hybrid o cloud.");
  if (!/^[A-Za-z0-9]{1,16}$/.test(runId)) throw new Error("RUN_ID debe ser alfanumérico y tener como máximo 16 caracteres.");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("FINANCIERO_BASE_URL debe comenzar con http:// o https://.");
  return { ...environment, baseUrl, mode, user: __ENV.FINANCIERO_USER, password: __ENV.FINANCIERO_PASSWORD,
    runId,
    thresholds };
}
