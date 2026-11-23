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

function conditionFromArgs(args) {
  if (args.length !== 2 || args[0] !== "--condition" || !["shared", "independent"].includes(args[1])) {
    throw new Error("Uso: node experiments/run-session-comparison.js --condition <shared|independent>");
  }
  return args[1];
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
    const child = spawn("k6", args, { cwd: rootDir, env: environment, shell: false, windowsHide: true });
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
    child.once("error", async (error) => {
      const safe = `No se pudo iniciar k6: ${safeLine(error.message, environment)}`;
      output.push(safe);
      console.error(safe);
      await writeFile(logPath, `${output.join("\n")}\n`, { flag: "wx" });
      resolve({ exitCode: 127, output });
    });
    child.once("close", async (code, signal) => {
      await writeFile(logPath, `${output.join("\n")}\n`, { flag: "wx" });
      resolve({ exitCode: code ?? (signal ? 128 : 1), output });
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
  const condition = conditionFromArgs(process.argv.slice(2));
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
    setupAuthenticationsExpected: conditionDetails.authentications,
    mode: "local",
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
    EXECUTION_MODE: "local",
    TEST_NAME: "concurrency-validation",
    RUN_ID: runId,
    EXPERIMENT_CONDITION: condition,
  };
  await writeFile(results("effective-config.json"), `${JSON.stringify(effectiveConfig, null, 2)}\n`, { flag: "wx" });
  await writeFile(results("run-metadata.json"), `${JSON.stringify({
    runId,
    condition,
    startedAtUtc: startedAt.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...git,
  }, null, 2)}\n`, { flag: "wx" });

  console.log(`Condition: ${condition} (${conditionDetails.scenarioCode})`);
  console.log(`RUN_ID: ${runId}`);
  console.log(`Resultados: ${resultDir}`);
  console.log(`Intentos máximos: ${experiment.vus * experiment.iterationsPerVu}`);

  const scriptPath = path.join(experimentDir, "session-comparison.js");
  const measured = await runK6(["run", scriptPath], {
    ...childEnvironment,
    EXPERIMENT_SUMMARY_PATH: results("summary.json"),
  }, results("console.log"));
  const events = extractManifestEvents(measured.output.join("\n"));
  await writeFile(results("manifest.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") +
    (events.length ? "\n" : ""), { flag: "wx" });
  await writeFile(results("save-overlap.json"), `${JSON.stringify(findOverlappingSaves(events), null, 2)}\n`, { flag: "wx" });

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

main().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
