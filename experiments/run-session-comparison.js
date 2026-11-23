import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractManifestEvents, generateRunId, parseEnvFile, reserveRunDirectory } from "../run.js";
import { validateSessionRun } from "./session-run-validation.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const experimentDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(experimentDir, "session-comparison.json");

export function parseExperimentArgs(args) {
  const options = { mode: "local", condition: null, dryRun: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Argumento repetido: ${flag}.`);
    seen.add(flag);
    if (flag === "--dry-run") { options.dryRun = true; continue; }
    if (!["--condition", "--mode"].includes(flag) || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error("Uso: npm run experiment:session -- --condition <shared|independent> [--mode local|cloud] [--dry-run]");
    }
    options[flag === "--condition" ? "condition" : "mode"] = args[++index];
  }
  if (!["shared", "independent"].includes(options.condition)) throw new Error("Selecciona --condition shared o independent.");
  if (!["local", "cloud"].includes(options.mode)) throw new Error("Selecciona --mode local o cloud.");
  return options;
}

export function buildExperimentInvocation({ mode, environment, scriptPath, summaryPath }) {
  if (mode === "local") {
    return { args: ["run", scriptPath], environment: { ...environment, EXPERIMENT_SUMMARY_PATH: summaryPath } };
  }
  if (mode !== "cloud") throw new Error("Modalidad del experimento no admitida.");
  const args = ["cloud", "run", "--show-logs"];
  const forwarded = ["FINANCIERO_USER", "FINANCIERO_PASSWORD", "FINANCIERO_BASE_URL",
    "EXECUTION_MODE", "TEST_NAME", "RUN_ID", "EXPERIMENT_CONDITION", "K6_CLOUD_PROJECT_ID"];
  for (const key of forwarded) {
    if (environment[key]) args.push("--env", `${key}=${environment[key]}`);
  }
  args.push(scriptPath);
  return { args, environment: { ...environment } };
}

function valueRequired(name, value) {
  const text = String(value || "").trim();
  if (!text || /^REEMPLAZAR(?:\b|$)/i.test(text)) throw new Error(`Configura ${name} en .env antes de ejecutar.`);
  return text;
}

function safeLine(line, environment) {
  let safe = String(line);
  for (const secretName of ["FINANCIERO_USER", "FINANCIERO_PASSWORD", "K6_CLOUD_TOKEN"]) {
    const secret = environment[secretName];
    if (secret) safe = safe.split(secret).join("[REDACTED]");
  }
  safe = safe.replace(/\b(Set-Cookie|Cookie)\s*[:=]\s*[^\r\n]*/gi, "$1: [REDACTED]");
  return safe;
}

function runK6(args, environment, logPath) {
  return new Promise((resolve) => {
    const output = [];
    const child = spawn(environment.K6_BIN || "k6", args, { cwd: rootDir, env: environment, shell: false, windowsHide: true });
    let startError = null;
    const consume = (stream, prefix = "") => {
      const lines = createInterface({ input: stream });
      lines.on("line", (line) => {
        const safe = safeLine(line, environment);
        output.push(safe);
        console.log(`${prefix}${safe}`);
      });
    };
    consume(child.stdout);
    consume(child.stderr);
    child.once("error", (error) => {
      startError = error;
      const safe = `No se pudo iniciar k6: ${safeLine(error.message, environment)}`;
      output.push(safe);
      console.error(safe);
    });
    child.once("close", async (code, signal) => {
      await writeFile(logPath, `${output.join("\n")}\n`, { flag: "wx" });
      resolve({ exitCode: startError ? 127 : code ?? (signal ? 128 : 1), output });
    });
  });
}

function findOverlappingSaves(events) {
  const intervals = events.filter((event) => event.saveInterval).map((event) => ({
    runId: event.runId,
    type: event.type,
    vu: event.vu,
    iteration: event.iteration,
    ...event.saveInterval,
  }));
  const overlaps = [];
  for (let left = 0; left < intervals.length; left += 1) {
    for (let right = left + 1; right < intervals.length; right += 1) {
      const first = intervals[left];
      const second = intervals[right];
      const overlapMs = Math.min(first.saveFinishedAtEpochMs, second.saveFinishedAtEpochMs) -
        Math.max(first.saveStartedAtEpochMs, second.saveStartedAtEpochMs);
      if (overlapMs > 0) overlaps.push({
        first: { vu: first.vu, iteration: first.iteration, type: first.type },
        second: { vu: second.vu, iteration: second.iteration, type: second.type },
        overlapMs,
      });
    }
  }
  return { clock: "unix-epoch-milliseconds", intervals, overlaps, anyOverlap: overlaps.length > 0 };
}

function extractConsoleJsonEvents(lines, prefix) {
  const records = [];
  for (const line of lines) {
    const encodedMessage = line.match(/\bmsg="((?:\\.|[^"\\])*)"/)?.[1];
    let message = line;
    if (encodedMessage) {
      try { message = JSON.parse(`"${encodedMessage}"`); } catch { continue; }
    }
    const start = message.indexOf(`${prefix} `);
    if (start < 0) continue;
    try { records.push(JSON.parse(message.slice(start + prefix.length + 1))); } catch {}
  }
  return records;
}

function readGitMetadata() {
  const runGit = (args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
  return {
    commit: runGit(["rev-parse", "HEAD"]),
    branch: runGit(["branch", "--show-current"]),
    workingTreeChangesAtStart: runGit(["status", "--short"]),
  };
}

async function main() {
  const { condition, mode, dryRun } = parseExperimentArgs(process.argv.slice(2));
  const experiment = JSON.parse(await readFile(configPath, "utf8"));
  const environmentFile = await readFile(path.join(rootDir, ".env"), "utf8");
  const dotenvValues = parseEnvFile(environmentFile);
  const environment = { ...dotenvValues, ...process.env };
  const user = valueRequired("FINANCIERO_USER", environment.FINANCIERO_USER);
  const password = valueRequired("FINANCIERO_PASSWORD", environment.FINANCIERO_PASSWORD);
  const envConfig = JSON.parse(await readFile(path.join(rootDir, "config", "environment.json"), "utf8"));
  const baseUrl = valueRequired("FINANCIERO_BASE_URL", environment.FINANCIERO_BASE_URL || envConfig.baseUrl);
  const parsedBaseUrl = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsedBaseUrl.protocol) || parsedBaseUrl.username || parsedBaseUrl.password) {
    throw new Error("FINANCIERO_BASE_URL debe ser HTTP/HTTPS y no debe contener credenciales.");
  }
  if (mode === "cloud") {
    valueRequired("K6_CLOUD_TOKEN", environment.K6_CLOUD_TOKEN);
    valueRequired("K6_CLOUD_STACK_ID", environment.K6_CLOUD_STACK_ID);
    const project = environment.K6_CLOUD_PROJECT_ID;
    if (project && !/^\d+$/.test(project)) throw new Error("K6_CLOUD_PROJECT_ID debe ser numérico u omitirse.");
    if (!experiment.cloud?.loadZone) throw new Error("Falta cloud.loadZone en la configuración del experimento.");
  }
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, mode, condition, vus: experiment.vus,
      iterationsPerVu: experiment.iterationsPerVu, maximumAttempts: experiment.vus * experiment.iterationsPerVu,
      setupAuthenticationsExpected: condition === "shared" ? 1 : experiment.vus,
      cloudLoadZone: mode === "cloud" ? experiment.cloud.loadZone : null,
      postVerificationMode: "local-read-only", executed: false }, null, 2));
    return 0;
  }

  const runId = generateRunId(new Date());
  const { resultDir } = await reserveRunDirectory({ resultsPath: path.join(rootDir, "results"), requestedRunId: runId });
  const results = (name) => path.join(resultDir, name);
  const startedAt = new Date();
  const git = readGitMetadata();
  const conditionDetails = experiment.conditions[condition];
  const effectiveConfig = {
    profile: experiment.profile,
    condition,
    scenarioCode: conditionDetails.scenarioCode,
    executor: experiment.executor,
    vus: experiment.vus,
    iterationsPerVu: experiment.iterationsPerVu,
    totalIterations: experiment.vus * experiment.iterationsPerVu,
    typeByIteration: experiment.typeByIteration,
    pauseSeconds: experiment.pauseSeconds,
    maxDuration: experiment.maxDuration,
    gracefulStop: experiment.gracefulStop,
    setupAuthenticationsExpected: condition === "shared" ? 1 : experiment.vus,
    mode,
    cloud: mode === "cloud" ? experiment.cloud : null,
    projectId: mode === "cloud" ? environment.K6_CLOUD_PROJECT_ID || null : null,
    requestTimeout: envConfig.requestTimeout,
    thresholds: JSON.parse(await readFile(path.join(rootDir, "config/tests.json"), "utf8")).tests["concurrency-validation"].thresholds,
    baseUrl,
    expectedContext: envConfig.expectedContext,
    sessionPolicyDefault: envConfig.sessionPolicy || "per-iteration",
    noCookiesReset: true,
  };
  const childEnvironment = {
    ...environment,
    FINANCIERO_USER: user,
    FINANCIERO_PASSWORD: password,
    FINANCIERO_BASE_URL: baseUrl,
    EXECUTION_MODE: mode,
    TEST_NAME: "concurrency-validation",
    RUN_ID: runId,
    EXPERIMENT_CONDITION: condition,
  };
  await writeFile(results("effective-config.json"), `${JSON.stringify(effectiveConfig, null, 2)}\n`, { flag: "wx" });
  await writeFile(results("run-metadata.json"), `${JSON.stringify({
    runId,
    condition,
    mode,
    startedAtUtc: startedAt.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...git,
  }, null, 2)}\n`, { flag: "wx" });

  console.log(`Condition: ${condition} (${conditionDetails.scenarioCode})`);
  console.log(`RUN_ID: ${runId}`);
  console.log(`Resultados: ${resultDir}`);
  console.log(`Intentos máximos: ${experiment.vus * experiment.iterationsPerVu}`);
  console.log(`Generación de carga: ${mode === "cloud" ? "Grafana Cloud" : "equipo local"}`);
  console.log("La verificación posterior será de solo lectura desde este equipo.");

  const scriptPath = path.join(experimentDir, "session-comparison.js");
  const invocation = buildExperimentInvocation({ mode, environment: childEnvironment,
    scriptPath, summaryPath: results("summary.json") });
  const measured = await runK6(invocation.args, invocation.environment, results("console.log"));
  if (mode === "cloud") {
    await writeFile(results("summary-status.json"), `${JSON.stringify({
      source: "Grafana Cloud", localSummaryExpected: false, csvDownload: "manual",
      reason: "Las estadísticas de la carga se consultan en Grafana. La consola y el manifiesto no sustituyen la exportación remota.",
    }, null, 2)}\n`, { flag: "wx" });
    console.log("Descarga manual: abre la corrida en Grafana y selecciona Export data en el menú de resultados.");
  }
  const events = extractManifestEvents(measured.output.join("\n"));
  await writeFile(results("manifest.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") +
    (events.length ? "\n" : ""), { flag: "wx" });
  await writeFile(results("save-overlap.json"), `${JSON.stringify({ ...findOverlappingSaves(events),
    interpretation: mode === "cloud"
      ? "Intervalos del cliente remoto; si hay varios generadores, su comparación depende de la sincronización de sus relojes. No demuestra ejecución simultánea en el servidor."
      : "Intervalos del cliente local. No demuestra ejecución simultánea en el servidor.",
  }, null, 2)}\n`, { flag: "wx" });

  let verification = { attempted: false, exitCode: null, authEvents: [], records: [] };
  const recordsToVerify = events.filter((event) => event.id).map((event) => ({
    runId: event.runId,
    condition: event.condition,
    type: event.type,
    vu: event.vu,
    iteration: event.iteration,
    glosa: event.glosa,
    id: String(event.id),
    date: event.date,
    correlativeProposed: event.correlativeProposed,
    expectedCorrelativeFinal: event.correlativeFinal,
    numberingContext: event.numberingContext,
  }));
  if (recordsToVerify.length) {
    verification.attempted = true;
    await writeFile(results("verification-input.json"), `${JSON.stringify(recordsToVerify, null, 2)}\n`, { flag: "wx" });
    const verificationEnvironment = {
      ...childEnvironment,
      EXECUTION_MODE: "local",
      EXPERIMENT_VERIFY_INPUT: `../results/${runId}/verification-input.json`,
    };
    const verifier = await runK6(["run", path.join(experimentDir, "verify-session-records.js")], {
      ...verificationEnvironment,
      EXPERIMENT_SUMMARY_PATH: results("verification-summary.json"),
    },
    results("post-verification.log"));
    verification.exitCode = verifier.exitCode;
    verification.authEvents = extractConsoleJsonEvents(verifier.output, "POST_VERIFY_AUTH");
    verification.records = extractConsoleJsonEvents(verifier.output, "POST_VERIFY");
    await writeFile(results("post-verification.ndjson"), verification.records.map((record) => JSON.stringify(record)).join("\n") +
      (verification.records.length ? "\n" : ""), { flag: "wx" });
    await writeFile(results("post-verification-status.json"), `${JSON.stringify({
      attempted: true,
      exitCode: verifier.exitCode,
      authEvents: verification.authEvents,
      records: verification.records,
    }, null, 2)}\n`, { flag: "wx" });
  }

  const finishedAt = new Date();
  const validation = validateSessionRun({
    runId,
    condition,
    measuredExitCode: measured.exitCode,
    manifestEvents: events,
    verificationAttempted: verification.attempted,
    verifierExitCode: verification.exitCode,
    verifierAuthEvents: verification.authEvents,
    verificationEvents: verification.records,
    summaryAvailable: existsSync(results("summary.json")),
    requireMeasuredSummary: mode !== "cloud",
    verificationSummaryAvailable: !verification.attempted || existsSync(results("verification-summary.json")),
    vus: experiment.vus,
    iterationsPerVu: experiment.iterationsPerVu,
    typeByIteration: experiment.typeByIteration,
  });
  await writeFile(results("runner-validation.json"), `${JSON.stringify(validation, null, 2)}\n`, { flag: "wx" });
  const failureExitCode = measured.exitCode !== 0 ? measured.exitCode :
    verification.exitCode !== 0 ? verification.exitCode || 1 : 1;
  const exitCode = validation.ok ? 0 : failureExitCode;
  await writeFile(results("experiment-result.json"), `${JSON.stringify({
    runId,
    condition,
    mode,
    remoteMetricsReviewRequired: mode === "cloud",
    startedAtUtc: startedAt.toISOString(),
    finishedAtUtc: finishedAt.toISOString(),
    measuredExitCode: measured.exitCode,
    postVerification: verification,
    validation,
    finalExitCode: exitCode,
  }, null, 2)}\n`, { flag: "wx" });
  console.log(`Ejecución finalizada con código ${exitCode}. Evidencias: ${resultDir}`);
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
