import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildChildEnvironment,
  buildK6Invocation,
  extractManifestEvents,
  generateRunId,
  parseArgs,
  resolveRunId,
  reserveRunDirectory,
  runProcess,
  resolveSessionPolicy,
  validateCloudLoadZone,
} from "../run.js";
import { buildScenario, validateTestCatalog } from "../config/test-config.js";

const names = ["smoke", "concurrency-validation", "baseline", "sustained", "spike", "stress"];

test("test catalog validates all six named tests and explicit executor settings", async () => {
  const source = await readFile(new URL("../config/tests.json", import.meta.url), "utf8");
  const catalog = JSON.parse(source);
  assert.equal(validateTestCatalog(catalog), catalog);
  assert.deepEqual(Object.keys(catalog.tests).sort(), names.sort());
  assert.throws(() => validateTestCatalog({ version: 1, tests: {} }));

  assert.equal(catalog.tests.smoke.executor, "per-vu-iterations");
  assert.equal(catalog.tests.smoke.vus, 1);
  assert.equal(catalog.tests.smoke.iterationsPerVu, 4);
  assert.equal(catalog.tests["concurrency-validation"].executor, "per-vu-iterations");
  assert.equal(catalog.tests["concurrency-validation"].vus, 2);
  assert.equal(catalog.tests["concurrency-validation"].iterationsPerVu, 4);
  const spikePeakStages = catalog.tests.spike.stages.filter((stage) => stage.target === 20);
  assert.ok(spikePeakStages.length >= 2, "spike debe subir al target y mantenerlo en la permanencia");
  assert.ok(spikePeakStages.every((stage) => typeof stage.phase === "string" && stage.phase.length > 0));

  for (const name of names) {
    const scenario = buildScenario(catalog.tests[name]);
    assert.equal(scenario.exec, "runVoucher");
    assert.equal(scenario.executor, catalog.tests[name].executor);
    if (scenario.stages) {
      assert.ok(scenario.stages.every((stage) => !("phase" in stage)), "k6 recibe solo duration/target por etapa");
    }
  }
});

test("CLI parsing selects each mode and preserves the named test", () => {
  for (const mode of ["local", "hybrid", "cloud"]) {
    assert.deepEqual(parseArgs(["--mode", mode, "--test", "baseline"]), {
      mode,
      testName: "baseline",
      runId: null,
      help: false,
    });
  }
  assert.equal(parseArgs(["--mode", "local", "--test", "smoke", "--run-id", "manual123"]).runId, "manual123");
});

test("session policy defaults to shared and rejects values outside the three supported strategies", () => {
  assert.equal(resolveSessionPolicy("shared"), "shared");
  assert.equal(resolveSessionPolicy("per-vu"), "per-vu");
  assert.equal(resolveSessionPolicy("per-iteration"), "per-iteration");
  assert.equal(resolveSessionPolicy(undefined), "shared");
  assert.throws(() => resolveSessionPolicy("invalid"), /per-iteration, per-vu, shared/);
});

test("cloud load zone accepts provider:region:zone and rejects malformed values", () => {
  assert.equal(validateCloudLoadZone("amazon:us:ashburn"), "amazon:us:ashburn");
  assert.equal(validateCloudLoadZone(undefined), undefined);
  for (const value of ["ashburn", "amazon:us", "amazon:us:ashburn:extra", 123]) {
    assert.throws(() => validateCloudLoadZone(value), /proveedor:región:zona/);
  }
});

test("project defaults to shared while retaining cloud load zone in environment configuration", async () => {
  const config = JSON.parse(await readFile(new URL("../config/environment.json", import.meta.url), "utf8"));
  assert.equal(config.sessionPolicy, "shared");
  assert.equal(config.cloud.loadZone, "amazon:us:ashburn");
});

test("generated run IDs are valid and differ across invocations", () => {
  const first = generateRunId(new Date("2026-11-22T10:00:00.000Z"));
  const second = generateRunId(new Date("2026-11-22T10:00:00.000Z"));
  assert.match(first, /^[A-Za-z0-9]{1,16}$/);
  assert.match(second, /^[A-Za-z0-9]{1,16}$/);
  assert.notEqual(first, second);
});

test("run ID resolver refuses to reuse an existing result folder or legacy file", async () => {
  const resultsPath = await mkdtemp(join(tmpdir(), "dip-k6-results-"));
  try {
    const generated = await resolveRunId({
      requestedRunId: undefined,
      resultsPath,
      generate: () => "newrun123",
    });
    assert.equal(generated, "newrun123");

    await mkdir(join(resultsPath, "occupied"));
    assert.throws(
      () => resolveRunId({ requestedRunId: "occupied", resultsPath }),
      /exist|ocupad/i,
    );

    await writeFile(join(resultsPath, "manifest-legacy.ndjson"), "");
    assert.throws(
      () => resolveRunId({ requestedRunId: "legacy", resultsPath }),
      /exist|ocupad/i,
    );
  } finally {
    await rm(resultsPath, { recursive: true, force: true });
  }
});

test("result reservation creates separate folders for successive invocation IDs", async () => {
  const resultsPath = await mkdtemp(join(tmpdir(), "dip-k6-reserve-"));
  try {
    const first = await reserveRunDirectory({ resultsPath, generate: () => "first123" });
    const second = await reserveRunDirectory({ resultsPath, generate: () => "second123" });
    assert.equal(first.runId, "first123");
    assert.equal(second.runId, "second123");
    assert.notEqual(first.resultDir, second.resultDir);
    await assert.rejects(
      reserveRunDirectory({ resultsPath, requestedRunId: "first123" }),
      /exist|ocupad/i,
    );
  } finally {
    await rm(resultsPath, { recursive: true, force: true });
  }
});

test("child environment receives the selected invocation values without printing secrets", () => {
  const childEnvironment = buildChildEnvironment({
    parentEnvironment: { FINANCIERO_USER: "user-placeholder", FINANCIERO_PASSWORD: "password-placeholder" },
    dotenvValues: { FINANCIERO_BASE_URL: "https://example.invalid/" },
    mode: "local",
    testName: "smoke",
    runId: "test123",
    baseUrl: "https://example.invalid/",
  });
  assert.equal(childEnvironment.EXECUTION_MODE, "local");
  assert.equal(childEnvironment.TEST_NAME, "smoke");
  assert.equal(childEnvironment.RUN_ID, "test123");
  assert.equal(childEnvironment.FINANCIERO_USER, "user-placeholder");
  assert.equal(childEnvironment.FINANCIERO_PASSWORD, "password-placeholder");
});

test("only cloud mode forwards the configured load zone to k6", () => {
  const cloudEnvironment = buildChildEnvironment({
    parentEnvironment: { K6_CLOUD_LOAD_ZONE: "stale:region:zone" },
    mode: "cloud", testName: "smoke", runId: "cloud123", baseUrl: "https://example.invalid/",
    cloudLoadZone: "amazon:us:ashburn",
    safeSummaryPath: "results/cloud123/summary.json",
  });
  assert.equal(cloudEnvironment.K6_CLOUD_LOAD_ZONE, "amazon:us:ashburn");
  assert.equal(cloudEnvironment.K6_SAFE_SUMMARY_PATH, undefined);
  const cloud = buildK6Invocation({ mode: "cloud", testName: "smoke", runId: "cloud123",
    environment: cloudEnvironment, resultDir: "results/cloud123" });
  assert.ok(cloud.args.includes("K6_CLOUD_LOAD_ZONE=amazon:us:ashburn"));
  assert.equal(cloud.args.some((value) => value.includes("results/cloud123")), false);
  assert.equal(cloud.args.includes("--summary-export"), false);

  const hybridEnvironment = buildChildEnvironment({
    parentEnvironment: { K6_CLOUD_LOAD_ZONE: "stale:region:zone" },
    mode: "hybrid", testName: "smoke", runId: "hybrid123", baseUrl: "https://example.invalid/",
    cloudLoadZone: "amazon:us:ashburn",
    safeSummaryPath: "results/hybrid123/summary.json",
  });
  assert.equal(hybridEnvironment.K6_CLOUD_LOAD_ZONE, undefined);
  assert.equal(hybridEnvironment.K6_SAFE_SUMMARY_PATH, "results/hybrid123/summary.json");
  const hybrid = buildK6Invocation({ mode: "hybrid", testName: "smoke", runId: "hybrid123",
    environment: hybridEnvironment, resultDir: "results/hybrid123" });
  assert.ok(hybrid.args.includes("--local-execution"));
  assert.equal(hybrid.args.includes("--summary-export"), false);

  const localEnvironment = buildChildEnvironment({
    parentEnvironment: {}, mode: "local", testName: "smoke", runId: "local123",
    baseUrl: "https://example.invalid/", safeSummaryPath: "results/local123/summary.json",
  });
  assert.equal(localEnvironment.K6_SAFE_SUMMARY_PATH, "results/local123/summary.json");
  const local = buildK6Invocation({ mode: "local", testName: "smoke", runId: "local123",
    environment: localEnvironment, resultDir: "results/local123" });
  assert.equal(local.args.includes("--summary-export"), false);
});

test("invocation exposes separate arguments and unique result destinations", () => {
  const common = {
    mode: "local",
    testName: "smoke",
    environment: { FINANCIERO_USER: "user-placeholder", FINANCIERO_PASSWORD: "password-placeholder" },
    k6Bin: "k6",
  };
  const first = buildK6Invocation({ ...common, runId: "runone", resultDir: "results/runone" });
  const second = buildK6Invocation({ ...common, runId: "runtwo", resultDir: "results/runtwo" });
  const hybrid = buildK6Invocation({ ...common, mode: "hybrid", runId: "runthree", resultDir: "results/runthree" });
  const cloud = buildK6Invocation({ ...common, mode: "cloud", runId: "runfour", resultDir: "results/runfour" });
  assert.equal(first.command, "k6");
  assert.ok(Array.isArray(first.args));
  assert.notEqual(first.summaryPath, second.summaryPath);
  assert.ok(hybrid.args.includes("--local-execution"));
  assert.ok(cloud.args.includes("cloud"));
});

test("manifest extraction ignores ordinary log lines", () => {
  const events = extractManifestEvents([
    "INFO ordinary k6 output",
    'INFO MANIFEST {"runId":"run123","test":"smoke","status":"verified"}',
    "WARN another line",
  ].join("\n"));
  assert.deepEqual(events, [{ runId: "run123", test: "smoke", status: "verified" }]);
});

test("process runner propagates a child exit code", async () => {
  const result = await runProcess({
    command: "fake-k6",
    args: ["run", "src/main.js"],
    cwd: process.cwd(),
    env: {},
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => child.emit("close", 7, null));
      return child;
    },
  });
  assert.equal(result.exitCode, 7);
});
