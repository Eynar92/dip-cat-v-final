import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../run.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = path.join(rootDir, "results");
const sources = [
  { condition: "shared", runId: "261123013055c50c", expectedIds: ["18414", "18415", "18416", "18417"] },
  { condition: "independent", runId: "2611230137d01ad9", expectedIds: ["18422", "18423", "18424", "18425"] },
];

function safeLine(line, environment) {
  let safe = String(line);
  for (const key of ["FINANCIERO_USER", "FINANCIERO_PASSWORD", "K6_CLOUD_TOKEN"]) {
    const value = environment[key];
    if (value) safe = safe.split(value).join("[REDACTED]");
  }
  return safe.replace(/\b(Set-Cookie|Cookie)\s*[:=]\s*[^\r\n]*/gi, "$1: [REDACTED]");
}

function extractEvents(lines, prefix) {
  const events = [];
  for (const line of lines) {
    const encoded = line.match(/\bmsg="((?:\\.|[^"\\])*)"/)?.[1];
    let message = line;
    if (encoded) {
      try { message = JSON.parse(`"${encoded}"`); } catch { continue; }
    }
    const at = message.indexOf(`${prefix} `);
    if (at < 0) continue;
    try { events.push(JSON.parse(message.slice(at + prefix.length + 1))); } catch {}
  }
  return events;
}

function validateReview(expectedEvents, authEvents, actualEvents, exitCode, summaryAvailable) {
  const errors = [];
  if (exitCode !== 0) errors.push(`El verificador de solo lectura terminó con código ${exitCode}.`);
  if (!summaryAvailable) errors.push("No se generó el resumen estadístico de la revisión.");
  if (authEvents.length !== 1 || authEvents[0]?.authenticated !== true || authEvents[0]?.authenticationCount !== 1) {
    errors.push("La autenticación única para las consultas de solo lectura no quedó confirmada.");
  }
  if (actualEvents.length !== expectedEvents.length) {
    errors.push(`Cobertura posterior incompleta: ${actualEvents.length} resultados para ${expectedEvents.length} registros esperados.`);
  }
  const makeKey = (event) => [event.sourceRunId, event.condition, String(event.id), event.type, event.vu, event.iteration].join(":");
  const expected = new Map();
  for (const event of expectedEvents) {
    const key = makeKey({ ...event, sourceRunId: event.runId });
    expected.set(key, (expected.get(key) || 0) + 1);
  }
  const observed = new Map();
  for (const event of actualEvents) {
    const key = makeKey(event);
    observed.set(key, (observed.get(key) || 0) + 1);
    if (!expected.has(key)) errors.push(`Resultado ajeno a los registros originales: ${key}.`);
    if (event.ok !== true || event.status !== "verified-after-run" || event.stage !== "verified") {
      errors.push(`La verificación de ${key} no fue positiva (estado: ${event.status || "desconocido"}).`);
    }
  }
  for (const [key, count] of expected) {
    if ((observed.get(key) || 0) !== count) errors.push(`Resultado faltante o repetido para ${key}.`);
  }
  return { ok: errors.length === 0, errors, expected: expectedEvents.length, observed: actualEvents.length };
}

async function loadOriginalEvents() {
  const events = [];
  for (const source of sources) {
    const manifestPath = path.join(resultsDir, source.runId, "manifest.ndjson");
    const lines = (await readFile(manifestPath, "utf8")).split(/\r?\n/).filter(Boolean);
    const runEvents = lines.map((line) => JSON.parse(line));
    const ids = runEvents.map((event) => String(event.id)).sort();
    if (runEvents.length !== source.expectedIds.length || JSON.stringify(ids) !== JSON.stringify([...source.expectedIds].sort())) {
      throw new Error(`El manifiesto local de ${source.runId} no contiene exactamente los IDs autorizados para revisar.`);
    }
    for (const event of runEvents) {
      if (event.runId !== source.runId || event.condition !== source.condition || event.status !== "verified") {
        throw new Error(`El manifiesto local de ${source.runId} tiene metadatos inesperados.`);
      }
      events.push({
        runId: source.runId,
        condition: source.condition,
        type: event.type,
        vu: event.vu,
        iteration: event.iteration,
        id: String(event.id),
        glosa: event.glosa,
        date: event.date,
        correlativeProposed: event.correlativeProposed,
        expectedCorrelativeFinal: event.correlativeFinal,
        numberingContext: event.numberingContext,
      });
    }
  }
  return events;
}

function runK6(inputPath, summaryPath, environment, logPath) {
  return new Promise((resolve) => {
    const childEnvironment = {
      ...environment,
      EXECUTION_MODE: "local",
      TEST_NAME: "concurrency-validation",
      RUN_ID: `review${randomBytes(5).toString("hex")}`,
      EXPERIMENT_VERIFY_INPUT: path.relative(path.join(rootDir, "experiments"), inputPath).replaceAll("\\", "/"),
      EXPERIMENT_SUMMARY_PATH: summaryPath,
    };
    const child = spawn("k6", ["run", path.join(path.dirname(fileURLToPath(import.meta.url)), "verify-session-records.js")], {
      cwd: rootDir, env: childEnvironment, shell: false, windowsHide: true,
    });
    const lines = [];
    const consume = (stream) => createInterface({ input: stream }).on("line", (line) => {
      const safe = safeLine(line, childEnvironment);
      lines.push(safe);
      console.log(safe);
    });
    consume(child.stdout);
    consume(child.stderr);
    child.once("error", async (error) => {
      const message = `No se pudo iniciar k6: ${safeLine(error.message, childEnvironment)}`;
      lines.push(message);
      await writeFile(logPath, `${lines.join("\n")}\n`, { flag: "wx" });
      resolve({ exitCode: 127, lines });
    });
    child.once("close", async (code, signal) => {
      await writeFile(logPath, `${lines.join("\n")}\n`, { flag: "wx" });
      resolve({ exitCode: code ?? (signal ? 128 : 1), lines });
    });
  });
}

async function assertArtifactsSecretFree(directory, environment) {
  const secretValues = [environment.FINANCIERO_USER, environment.FINANCIERO_PASSWORD, environment.K6_CLOUD_TOKEN]
    .filter((value) => typeof value === "string" && value.length > 0);
  const files = await readdir(directory, { withFileTypes: true });
  for (const file of files) {
    if (!file.isFile()) continue;
    const contents = await readFile(path.join(directory, file.name), "utf8");
    if (secretValues.some((secret) => contents.includes(secret)) || /\b(?:Set-Cookie|Cookie)\s*[:=]\s*[^\r\n]+/i.test(contents)) {
      throw new Error(`La auditoría de secretos detectó un campo sensible en ${file.name}; el valor no se imprimirá.`);
    }
  }
}

async function main() {
  const dotenv = parseEnvFile(await readFile(path.join(rootDir, ".env"), "utf8"));
  const environment = { ...dotenv, ...process.env };
  for (const name of ["FINANCIERO_USER", "FINANCIERO_PASSWORD", "FINANCIERO_BASE_URL"]) {
    if (!environment[name] || /^REEMPLAZAR(?:\b|$)/i.test(environment[name])) throw new Error(`Configura ${name} en .env.`);
  }
  const events = await loadOriginalEvents();
  const reviewId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const reviewDir = path.join(resultsDir, "reviews", `post-original-session-review-${reviewId}`);
  await mkdir(reviewDir, { recursive: true });
  const inputPath = path.join(reviewDir, "verification-input.json");
  const summaryPath = path.join(reviewDir, "verification-summary.json");
  await writeFile(inputPath, `${JSON.stringify(events, null, 2)}\n`, { flag: "wx" });
  await writeFile(path.join(reviewDir, "review-metadata.json"), `${JSON.stringify({
    reviewId,
    purpose: "revisión posterior de ocho registros existentes; solo lectura",
    sources: sources.map(({ condition, runId, expectedIds }) => ({ condition, runId, expectedIds })),
    startedAtUtc: new Date().toISOString(),
  }, null, 2)}\n`, { flag: "wx" });
  console.log(`REVIEW_ID: ${reviewId}`);
  console.log(`Registros a revisar: ${events.length} (solo lectura)`);
  console.log(`Evidencias: ${reviewDir}`);

  const execution = await runK6(inputPath, summaryPath, environment, path.join(reviewDir, "console.log"));
  const authEvents = extractEvents(execution.lines, "POST_VERIFY_AUTH");
  const verificationEvents = extractEvents(execution.lines, "POST_VERIFY");
  await writeFile(path.join(reviewDir, "post-verification.ndjson"),
    verificationEvents.map((event) => JSON.stringify(event)).join("\n") + (verificationEvents.length ? "\n" : ""), { flag: "wx" });
  let summaryAvailable = existsSync(summaryPath);
  if (summaryAvailable) {
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    if (Object.hasOwn(summary, "setup_data")) summaryAvailable = false;
  }
  const validation = validateReview(events, authEvents, verificationEvents, execution.exitCode, summaryAvailable);
  await writeFile(path.join(reviewDir, "review-result.json"), `${JSON.stringify({
    reviewId,
    exitCode: validation.ok ? 0 : execution.exitCode || 1,
    authentication: authEvents,
    validation,
    records: verificationEvents,
  }, null, 2)}\n`, { flag: "wx" });
  await assertArtifactsSecretFree(reviewDir, environment);
  console.log(`Revisión finalizada con código ${validation.ok ? 0 : execution.exitCode || 1}. Registros aprobados: ${validation.observed}/${validation.expected}.`);
  return validation.ok ? 0 : execution.exitCode || 1;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
