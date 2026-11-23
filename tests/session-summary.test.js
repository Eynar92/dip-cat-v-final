import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sentinel = "COOKIE_SENTINEL_DO_NOT_PERSIST_7d13a9";

test("k6 writes useful summary metrics without persisting setup cookies", (t) => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "k6-safe-summary-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const summaryPath = path.join(tempDir, "summary.json");
  const processResult = spawnSync("k6", ["run", "--env", `EXPERIMENT_SUMMARY_PATH=${summaryPath}`,
    path.join(projectRoot, "experiments", "summary-sanitization-probe.js")], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(processResult.error, undefined, processResult.error?.message);
  assert.equal(processResult.status, 0, `${processResult.stdout}\n${processResult.stderr}`);

  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  assert.equal(Object.hasOwn(summary, "setup_data"), false);
  assert.equal(summary.metrics.checks.values.passes, 1);
  assert.equal(summary.metrics.probe_rate.thresholds["rate==1"].ok, true);

  const artifactContents = readdirSync(tempDir, { recursive: true })
    .filter((entry) => typeof entry === "string")
    .map((entry) => readFileSync(path.join(tempDir, entry), "utf8"));
  assert.ok(artifactContents.length > 0);
  assert.equal(artifactContents.some((contents) => contents.includes(sentinel)), false);
});
