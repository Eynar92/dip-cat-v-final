import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { validateTestCatalog } from "./config/test-config.js";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const modes = ["local", "hybrid", "cloud"];

export function parseArgs(args) {
  const options = { mode: null, testName: null, runId: null, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!["--mode", "--test", "--run-id"].includes(argument)) {
      throw new Error(`Argumento desconocido: ${argument}. Usa --help para ver los comandos disponibles.`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Falta el valor de ${argument}.`);
    if (argument === "--mode") options.mode = value;
    if (argument === "--test") options.testName = value;
    if (argument === "--run-id") options.runId = value;
    index += 1;
  }
  if (!options.help && !options.mode) throw new Error("Debes seleccionar --mode local, hybrid o cloud.");
  if (!options.help && !options.testName) throw new Error("Debes seleccionar --test <nombre>.");
  if (options.mode && !modes.includes(options.mode)) throw new Error(`Modalidad inválida: ${options.mode}.`);
  if (options.runId && !/^[A-Za-z0-9]{1,16}$/.test(options.runId)) {
    throw new Error("--run-id acepta de 1 a 16 caracteres alfanuméricos.");
  }
  return options;
}

export function generateRunId(now = new Date(), randomSuffix = randomBytes(3).toString("hex")) {
  const timestamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(2, 12);
  return `${timestamp}${randomSuffix}`;
}

export function parseEnvFile(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

export function buildChildEnvironment({ parentEnvironment = process.env, dotenvValues = {}, mode, testName, runId, baseUrl }) {
  const source = { ...dotenvValues, ...parentEnvironment };
  return {
    ...source,
    EXECUTION_MODE: mode,
    TEST_NAME: testName,
    RUN_ID: runId,
    FINANCIERO_BASE_URL: source.FINANCIERO_BASE_URL || baseUrl,
  };
}

export function buildK6Invocation({ mode, testName, runId, environment, resultDir, k6Bin = "k6" }) {
  const summaryPath = path.join(resultDir, "summary.json");
  const scriptPath = path.join(rootDir, "src", "main.js");
  const args = [];

  if (mode === "local") {
    args.push("run", "--summary-export", summaryPath, scriptPath);
  } else if (mode === "hybrid") {
    args.push("cloud", "run", "--local-execution", "--summary-export", summaryPath, scriptPath);
  } else if (mode === "cloud") {
    args.push("cloud", "run", "--show-logs");
    const forwarded = [
      ["FINANCIERO_USER", environment.FINANCIERO_USER],
      ["FINANCIERO_PASSWORD", environment.FINANCIERO_PASSWORD],
      ["FINANCIERO_BASE_URL", environment.FINANCIERO_BASE_URL],
      ["EXECUTION_MODE", mode],
      ["TEST_NAME", testName],
      ["RUN_ID", runId],
    ];
    for (const [name, value] of forwarded) args.push("--env", `${name}=${value}`);
    args.push(scriptPath);
  } else {
    throw new Error(`Modalidad no soportada: ${mode}.`);
  }

  return { command: k6Bin, args, summaryPath };
}

export function extractManifestEvents(logContents) {
  const events = [];
  for (const line of String(logContents).split(/\r?\n/)) {
    const structuredMessage = line.match(/\bmsg="((?:\\.|[^"\\])*)"/);
    let message = line;
    if (structuredMessage) {
      try {
        message = JSON.parse(`"${structuredMessage[1]}"`);
      } catch {
        continue;
      }
    }
    const match = message.match(/(?:^|\s)MANIFEST\s+(\{.*\})\s*$/);
    if (!match) continue;
    try {
      events.push(JSON.parse(match[1]));
    } catch {
      // Ignora líneas parciales o ajenas al formato JSON del manifiesto.
    }
  }
  return events;
}

function isPlaceholder(value) {
  return !value || /^REEMPLAZAR(?:\b|$)/i.test(value.trim());
}

function requireValue(name, value) {
  if (isPlaceholder(value)) throw new Error(`Define ${name} en .env o en el entorno del proceso.`);
  return value;
}

function redactSecrets(text, environment) {
  let safe = String(text);
  const secrets = [environment.FINANCIERO_PASSWORD, environment.K6_CLOUD_TOKEN];
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) safe = safe.split(secret).join("[REDACTED]");
  }
  return safe;
}

function displayTest(testName, test) {
  const typeList = test.types.join(", ");
  if (test.executor === "per-vu-iterations") {
    return `${test.vus} VUs × ${test.iterationsPerVu} iteraciones por VU, tipos ${typeList}`;
  }
  if (test.executor === "constant-vus") {
    return `${test.vus} VUs durante ${test.duration}, tipos ${typeList}`;
  }
  const stages = test.stages.map(({ phase, duration, target }) => `${phase}: ${target} VUs/${duration}`).join("; ");
  return `${test.executor}, tipos ${typeList}; ${stages}`;
}

async function readConfiguration(environment) {
  const testCatalog = validateTestCatalog(JSON.parse(await readFile(path.join(rootDir, "config", "tests.json"), "utf8")));
  const environmentConfig = JSON.parse(await readFile(path.join(rootDir, "config", "environment.json"), "utf8"));
  const baseUrl = environment.FINANCIERO_BASE_URL || environmentConfig.baseUrl;
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error("FINANCIERO_BASE_URL debe ser una URL válida.");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error("FINANCIERO_BASE_URL debe ser HTTP/HTTPS y no puede contener credenciales en la URL.");
  }
  return { testCatalog, environmentConfig, baseUrl: baseUrl.replace(/\/$/, "") };
}

function printHelp() {
  console.log("Uso: node run.js --mode <local|hybrid|cloud> --test <smoke|concurrency-validation|baseline|sustained|spike|stress> [--run-id <alfanumérico>]");
  console.log("Ejemplos: npm run test:local -- --test smoke");
  console.log("          npm run test:hybrid -- --test baseline");
  console.log("          npm run test:cloud -- --test baseline");
}

async function prepareEnvironment() {
  const dotenvPath = path.join(rootDir, ".env");
  let dotenvValues = {};
  try {
    dotenvValues = parseEnvFile(await readFile(dotenvPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { ...dotenvValues, ...process.env };
}

export function resolveRunId({ requestedRunId, resultsPath, generate = generateRunId }) {
  if (requestedRunId) {
    if (runIdHasResults(resultsPath, requestedRunId)) {
      throw new Error(`Ya existen resultados para RUN_ID ${requestedRunId}; elige otro con --run-id.`);
    }
    return requestedRunId;
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = generate();
    if (!runIdHasResults(resultsPath, candidate)) return candidate;
  }
  throw new Error("No se pudo generar un RUN_ID disponible después de varios intentos.");
}

export async function reserveRunDirectory({ requestedRunId, resultsPath, generate = generateRunId, createDirectory = mkdir }) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const runId = resolveRunId({ requestedRunId: attempt === 0 ? requestedRunId : null, resultsPath, generate });
    const resultDir = path.join(resultsPath, runId);
    try {
      await createDirectory(resultDir, { recursive: false });
      return { runId, resultDir };
    } catch (error) {
      if (requestedRunId || error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("No se pudo reservar una carpeta de resultados exclusiva.");
}

function runIdHasResults(resultsPath, runId) {
  return [
    path.join(resultsPath, runId),
    path.join(resultsPath, `manifest-${runId}.ndjson`),
    path.join(resultsPath, `console-${runId}.log`),
  ].some(existsSync);
}

export function runProcess({ command, args, cwd, env, spawnProcess = spawn, onOutput = () => {} }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["inherit", "pipe", "pipe"] });
    } catch (error) {
      resolve({ exitCode: 127, error });
      return;
    }
    let spawnError = null;
    child.on("error", (error) => { spawnError = error; });
    for (const streamName of ["stdout", "stderr"]) {
      if (child[streamName]) {
        const reader = readline.createInterface({ input: child[streamName] });
        reader.on("line", (line) => onOutput(streamName, line));
      }
    }
    child.on("close", (code, signal) => {
      resolve({ exitCode: code ?? (signal ? 128 : 1), error: spawnError, signal });
    });
  });
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    printHelp();
    return 0;
  }

  const environment = await prepareEnvironment();
  const { testCatalog, environmentConfig, baseUrl } = await readConfiguration(environment);
  const test = testCatalog.tests[options.testName];
  if (!test) throw new Error(`Test desconocido: ${options.testName}.`);
  requireValue("FINANCIERO_USER", environment.FINANCIERO_USER);
  requireValue("FINANCIERO_PASSWORD", environment.FINANCIERO_PASSWORD);
  if (options.mode !== "local") {
    requireValue("K6_CLOUD_TOKEN", environment.K6_CLOUD_TOKEN);
    requireValue("K6_CLOUD_STACK_ID", environment.K6_CLOUD_STACK_ID);
  }

  const resultsPath = path.join(rootDir, "results");
  const { runId, resultDir } = await reserveRunDirectory({ requestedRunId: options.runId, resultsPath });

  const childEnvironment = buildChildEnvironment({
    parentEnvironment: process.env,
    dotenvValues: environment,
    mode: options.mode,
    testName: options.testName,
    runId,
    baseUrl,
  });
  const effectiveConfig = {
    runId,
    test: options.testName,
    mode: options.mode,
    execution: test,
    environment: {
      baseUrl,
      expectedContext: environmentConfig.expectedContext,
      requestTimeout: environmentConfig.requestTimeout || "30s",
      sessionPolicy: environmentConfig.sessionPolicy || "per-iteration",
    },
  };
  const paths = {
    console: path.join(resultDir, "console.log"),
    summary: path.join(resultDir, "summary.json"),
    manifest: path.join(resultDir, "manifest.ndjson"),
    effectiveConfig: path.join(resultDir, "effective-config.json"),
  };
  await writeFile(paths.effectiveConfig, `${JSON.stringify(effectiveConfig, null, 2)}\n`, { flag: "wx" });

  console.log(`Test: ${options.testName}`);
  console.log(`Modalidad: ${options.mode}`);
  console.log(`Ejecución: ${displayTest(options.testName, test)}`);
  console.log(`RUN_ID: ${runId}`);
  console.log(`Resultados: ${resultDir}`);
  console.log(`Log: ${paths.console}`);
  console.log(`Resumen: ${paths.summary}`);
  console.log(`Manifiesto: ${paths.manifest}`);
  console.log(`Configuración efectiva: ${paths.effectiveConfig}`);

  const invocation = buildK6Invocation({
    mode: options.mode,
    testName: options.testName,
    runId,
    environment: childEnvironment,
    resultDir,
    k6Bin: environment.K6_BIN || "k6",
  });
  const log = createWriteStream(paths.console, { flags: "wx" });
  const result = await runProcess({
    command: invocation.command,
    args: invocation.args,
    cwd: rootDir,
    env: childEnvironment,
    onOutput: (streamName, line) => {
      const safeLine = redactSecrets(line, childEnvironment);
      log.write(`${safeLine}\n`);
      if (streamName === "stderr") console.error(safeLine);
      else console.log(safeLine);
    },
  });
  log.end();
  await new Promise((resolve, reject) => {
    log.once("finish", resolve);
    log.once("error", reject);
  });

  const logContents = await readFile(paths.console, "utf8");
  const events = extractManifestEvents(logContents);
  await writeFile(paths.manifest, events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""), { flag: "wx" });
  if (!events.length) {
    await writeFile(path.join(resultDir, "manifest-status.json"), `${JSON.stringify({
      availableLocally: false,
      reason: options.mode === "cloud"
        ? "La ejecución cloud puede conservar el manifiesto en los logs remotos; verifica si k6 mostró eventos MANIFEST en consola."
        : "k6 no emitió eventos MANIFEST en la salida capturada.",
    }, null, 2)}\n`, { flag: "wx" });
  }
  try {
    await readFile(paths.summary);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(path.join(resultDir, "summary-status.json"), `${JSON.stringify({
      availableLocally: false,
      reason: options.mode === "cloud"
        ? "La ejecución cloud mantiene el resumen estadístico en Grafana Cloud; esta carpeta conserva consola y configuración efectiva."
        : "k6 no generó el archivo de resumen local.",
    }, null, 2)}\n`, { flag: "wx" });
  }

  if (result.error) console.error(`No se pudo iniciar k6: ${redactSecrets(result.error.message, childEnvironment)}`);
  console.log(`Ejecución finalizada con código ${result.exitCode}. Evidencias: ${resultDir}`);
  return result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
