import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractManifestEvents } from "../run.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "tests", "fixtures", "session-policy-probe.js");
const sentinel = "SESSION_COOKIE_SENTINEL_OFFLINE_38ca";

function startMock({ rejectFirstProbe = false, rejectLogin = false } = {}) {
  const state = { logins: 0, probes: [] };
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname.endsWith("/login.html")) {
      response.writeHead(200, { "Content-Type": "text/html" }).end("<form></form>");
      return;
    }
    if (pathname.endsWith("/session.php") && request.method === "POST") {
      state.logins += 1;
      request.resume();
      if (rejectLogin) {
        response.writeHead(401, { "Content-Type": "text/html" }).end('<form><input name="password"></form>');
        return;
      }
      response.writeHead(302, { Location: "/index.php", "Set-Cookie": `PHPSESSID=${sentinel}-${state.logins}; Path=/financierodiplomado/; HttpOnly; SameSite=Lax` }).end();
      return;
    }
    if (pathname.endsWith("/index.php")) {
      const valid = String(request.headers.cookie || "").includes(`PHPSESSID=${sentinel}-`);
      response.writeHead(valid ? 200 : 401, { "Content-Type": "text/html" })
        .end(valid ? "authenticated" : '<form><input name="password"></form>');
      return;
    }
    if (pathname.endsWith("/probe")) {
      const vu = Number(request.headers["x-test-vu"]);
      const iteration = Number(request.headers["x-test-iteration"]);
      const cookie = String(request.headers.cookie || "").match(/PHPSESSID=([^;]+)/)?.[1] || null;
      const shouldReject = rejectFirstProbe && vu === 1 && iteration === 1;
      state.probes.push({ vu, iteration, cookie, status: shouldReject ? 401 : 200 });
      response.writeHead(shouldReject ? 401 : 200, { "Content-Type": "text/plain" })
        .end(shouldReject ? "unauthorized" : "ok");
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      state,
      baseUrl: `http://127.0.0.1:${server.address().port}/financierodiplomado/`,
    }));
  });
}

function runK6(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("k6", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function runPolicy(policy, options = {}) {
  const mock = await startMock(options);
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "session-policy-offline-"));
  const summaryPath = path.join(tempDir, "summary.json");
  try {
    const result = await runK6(["run", "--env", `SESSION_POLICY=${policy}`,
      "--env", `FINANCIERO_BASE_URL=${mock.baseUrl}`, "--env", "K6_SAFE_SUMMARY_PATH=" + summaryPath,
      "--env", "PROBE_VUS=2", "--env", "PROBE_ITERATIONS=2", script], root);
    const expectedExitCode = options.rejectLogin ? 99 : 0;
    assert.equal(result.status, expectedExitCode, `${result.stdout}\n${result.stderr}`);
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    assert.equal(Object.hasOwn(summary, "setup_data"), false);
    assert.equal(`${result.stdout}\n${result.stderr}\n${JSON.stringify(summary)}`.includes(sentinel), false);
    return { ...mock.state, summary, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("per-iteration authenticates before each iteration and sends a fresh session", async () => {
  const result = await runPolicy("per-iteration");
  assert.equal(result.logins, 4, `${JSON.stringify(result.probes)}\n${result.output}`);
  assert.equal(result.probes.length, 4, result.output);
  for (const vu of [1, 2]) {
    const cookies = result.probes.filter((probe) => probe.vu === vu).map((probe) => probe.cookie);
    assert.equal(new Set(cookies).size, 2);
  }
});

test("per-vu authenticates once per activated VU and preserves its cookie across iterations", async () => {
  const result = await runPolicy("per-vu");
  assert.equal(result.logins, 2, `${JSON.stringify(result.probes)}\n${result.output}`);
  assert.equal(result.probes.length, 4);
  for (const vu of [1, 2]) {
    const cookies = result.probes.filter((probe) => probe.vu === vu).map((probe) => probe.cookie);
    assert.equal(new Set(cookies).size, 1);
  }
  assert.equal(new Set(result.probes.map((probe) => probe.cookie)).size, 2);
});

test("shared authenticates once and gives every activated VU the same session", async () => {
  const result = await runPolicy("shared");
  assert.equal(result.logins, 1, `${JSON.stringify(result.probes)}\n${result.output}`);
  assert.equal(result.probes.length, 4, result.output);
  assert.equal(new Set(result.probes.map((probe) => probe.cookie)).size, 1);
});

test("per-vu invalidates a rejected session and authenticates on its next iteration", async () => {
  const result = await runPolicy("per-vu", { rejectFirstProbe: true });
  assert.equal(result.logins, 3, `${JSON.stringify(result.probes)}\n${result.output}`);
  const vuOne = result.probes.filter((probe) => probe.vu === 1);
  assert.notEqual(vuOne[0].cookie, vuOne[1].cookie);
});

test("rejected login produces failed manifest attempts and a failing threshold", async () => {
  const result = await runPolicy("per-iteration", { rejectLogin: true });
  assert.equal(result.logins, 4);
  assert.equal(result.probes.length, 0);
  const events = extractManifestEvents(result.output);
  assert.equal(events.length, 4);
  assert.ok(events.every((event) => event.stage === "authentication" && event.status === "failed-before-save"));
  assert.ok(result.summary.metrics.checks.values.fails > 0);
  assert.equal(result.summary.metrics.checks.thresholds["rate==1"].ok, false);
});
