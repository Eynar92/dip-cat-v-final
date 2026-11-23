import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseExperimentArgs, buildExperimentInvocation } from "../experiments/run-session-comparison.js";

test("experiment keeps local as default and accepts cloud with dry-run", () => {
  assert.deepEqual(parseExperimentArgs(["--condition", "shared"]), { mode: "local", condition: "shared", dryRun: false });
  assert.deepEqual(parseExperimentArgs(["--mode", "cloud", "--condition", "shared", "--dry-run"]),
    { mode: "cloud", condition: "shared", dryRun: true });
  for (const args of [["--mode", "hybrid", "--condition", "shared"], ["--condition"],
    ["--condition", "shared", "--mode", "cloud", "--mode", "local"], ["--unknown"]]) {
    assert.throws(() => parseExperimentArgs(args));
  }
});

test("cloud command selects the experimental script and forwards only required script variables", () => {
  const environment = { FINANCIERO_USER: "fake-user", FINANCIERO_PASSWORD: "fake-password",
    FINANCIERO_BASE_URL: "http://example.test/app/", EXECUTION_MODE: "cloud", TEST_NAME: "concurrency-validation",
    RUN_ID: "offlineSC123", EXPERIMENT_CONDITION: "shared", K6_CLOUD_PROJECT_ID: "12345",
    K6_CLOUD_TOKEN: "fake-cloud-token", K6_CLOUD_STACK_ID: "123", UNRELATED_SECRET: "unrelated-secret" };
  const invocation = buildExperimentInvocation({ mode: "cloud", environment,
    scriptPath: "experiments/session-comparison.js", summaryPath: "C:/local/results/summary.json" });
  assert.deepEqual(invocation.args.slice(0, 3), ["cloud", "run", "--show-logs"]);
  assert.equal(invocation.args.at(-1), "experiments/session-comparison.js");
  for (const variable of ["EXECUTION_MODE=cloud", "EXPERIMENT_CONDITION=shared", "RUN_ID=offlineSC123",
    "TEST_NAME=concurrency-validation", "K6_CLOUD_PROJECT_ID=12345"]) assert.ok(invocation.args.includes(variable));
  assert.equal(invocation.args.some(value => /fake-cloud-token|unrelated-secret|EXPERIMENT_SUMMARY_PATH|C:\/local|src\/main/.test(value)), false);
  assert.equal(invocation.args.includes("--local-execution"), false);
  assert.equal(invocation.args.includes("--include-system-env-vars"), false);
  assert.equal(invocation.args.includes("--summary-export"), false);
  assert.equal(invocation.environment.K6_CLOUD_TOKEN, "fake-cloud-token");
});

test("local command keeps the safe custom summary on the local filesystem", () => {
  const invocation = buildExperimentInvocation({ mode: "local", environment: { EXECUTION_MODE: "local" },
    scriptPath: "experiments/session-comparison.js", summaryPath: "results/test/summary.json" });
  assert.deepEqual(invocation.args, ["run", "experiments/session-comparison.js"]);
  assert.equal(invocation.environment.EXPERIMENT_SUMMARY_PATH, "results/test/summary.json");
});

test("k6 inspects the cloud experiment without running setup or sending load", () => {
  const result = spawnSync("k6", ["inspect", "--env", "FINANCIERO_USER=offline-user",
    "--env", "FINANCIERO_PASSWORD=offline-password", "--env", "EXECUTION_MODE=cloud",
    "--env", "TEST_NAME=concurrency-validation", "--env", "RUN_ID=offlineCloud123",
    "--env", "EXPERIMENT_CONDITION=shared", "--env", "K6_CLOUD_PROJECT_ID=12345",
    "experiments/session-comparison.js"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const options = JSON.parse(result.stdout);
  const profile = JSON.parse(readFileSync("experiments/session-comparison.json", "utf8"));
  assert.equal(options.scenarios.sessionComparison.vus, profile.vus);
  assert.equal(options.scenarios.sessionComparison.iterations, profile.iterationsPerVu);
  assert.equal(options.noCookiesReset, true);
  assert.equal(options.cloud.projectID, 12345);
  assert.equal(options.cloud.distribution.experiment.percent, 100);
  assert.equal(options.cloud.distribution.experiment.loadZone, profile.cloud.loadZone);
});
