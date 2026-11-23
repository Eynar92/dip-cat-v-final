import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractManifestEvents } from "../run.js";

const basePath = "/financierodiplomado/";
const accountData = {
  "1101010001": { id: "13004", name: "CAJA M/N" },
  "4102010001": { id: "13008", name: "OTROS INGRESOS" },
  "5102200002": { id: "13291", name: "GASTO EN IMPRENTA" },
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseMultipart(body, contentType) {
  const boundary = contentType.match(/boundary=([^;]+)/i)?.[1];
  assert.ok(boundary, "k6 save request includes multipart boundary");
  const values = {};
  for (const part of body.split(`--${boundary}`).slice(1)) {
    const match = part.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n/i);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function accountSearchHtml(number) {
  const account = accountData[number];
  return `<script>setBusquedaCuenta(${account.id},${number},"${account.name}",1,1)</script>`;
}

function persistedHtml(record) {
  const { values } = record;
  const typeName = values.tipo_comprobante === "3" ? "Traspaso" : "Ingreso";
  const rows = [1, 2].map((row) => {
    const number = values[`cuenta${row}`] === "13004" ? "1101010001" :
      values[`cuenta${row}`] === "13008" ? "4102010001" : "5102200002";
    const account = accountData[number];
    return `<input name="debe${row}" value="${Number(values[`debe${row}`]).toFixed(2)}">
      <input name="haber${row}" value="${Number(values[`haber${row}`]).toFixed(2)}">
      <input name="glosa_detalle${row}" value="${values[`glosa_detalle${row}`]}">
      <script>filaActiva=${row};setBusquedaCuentaEdit(${account.id},${number},"${account.name}",0,)</script>`;
  }).join("\n");
  return `<select name="tipo_comprobante"><option value="${values.tipo_comprobante}" selected>${typeName}</option></select>
    <input name="fecha" value="${values.fecha}"><input name="glosa" value="${values.glosa}">
    <input name="nro_correlativo" value="${values.nro_correlativo}">
    ${rows}<input name="totaldeb" value="10.00"><input name="totalhab" value="10.00"><input name="total_dif" value="0.00">`;
}

function createMockApplication() {
  let sessionNumber = 0;
  let recordNumber = 9000;
  let saveCount = 0;
  const sessions = new Set();
  const records = new Map();
  const saves = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const pathname = url.pathname;
      const cookies = Object.fromEntries(String(request.headers.cookie || "").split(/;\s*/).filter(Boolean)
        .map((pair) => { const at = pair.indexOf("="); return [pair.slice(0, at), pair.slice(at + 1)]; }));
      const sessionId = cookies.PHPSESSID;
      const authenticated = !!sessionId && sessions.has(sessionId);
      const send = (status, body = "", headers = {}) => {
        response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
        response.end(body);
      };

      if (pathname === `${basePath}login.html`) return send(200, "<form>login</form>");
      if (pathname === `${basePath}session.php` && request.method === "POST") {
        await readBody(request);
        sessionNumber += 1;
        const id = `offline-session-${sessionNumber}`;
        sessions.add(id);
        return send(302, "", { Location: `${basePath}index.php`, "Set-Cookie": `PHPSESSID=${id}; Path=${basePath}; HttpOnly; SameSite=Lax` });
      }
      if (pathname === `${basePath}index.php` && !url.search) {
        return authenticated ? send(200, "<main>authenticated home</main>") : send(200, '<input name="password">');
      }
      if (pathname === `${basePath}modulo.php`) return authenticated
        ? send(302, "", { Location: `${basePath}index.php?opcion=homeModulo` }) : send(302, "", { Location: `${basePath}login.html` });
      if (!authenticated) return send(302, "", { Location: `${basePath}login.html` });
      if (pathname === `${basePath}index.php` || pathname === `${basePath}comprobantes/list.php`) return send(200, "ok");
      if (pathname === `${basePath}comprobantes/register.php`) return send(200, `<input type="hidden" id="cod_entidad_comprobante" value="2">
        <input type="hidden" id="cod_unidad_comprobante" value="1"><input name="global_gestion" value="2026">
        <input name="global_mes" value="9"><input name="fecha" value="2026-09-22">
        <input name="unidad_organizacional" value="ADM CETOF - ADM CETOF"><input name="glosa" maxlength="44">`);
      if (pathname === `${basePath}comprobantes/ajaxCorrelativo.php`) return send(200, '<input name="nro_correlativo" value="1">');
      if (pathname === `${basePath}comprobantes/ajax_fecha_comprobante.php`) return send(200, '<input name="fecha" value="2026-09-22">');
      if (pathname === `${basePath}comprobantes/ajaxCuentaContable.php`) {
        const row = url.searchParams.get("idFila");
        return send(200, `<select name="unidad${row}"><option value="1" selected>ADM CETOF</option></select>
          <select name="area${row}"><option value="1" selected>ADM CETOF</option></select>`);
      }
      if (pathname === `${basePath}comprobantes/ajaxBusquedaCuenta.php`) {
        return send(200, accountSearchHtml(url.searchParams.get("nro_cuenta")));
      }
      if (pathname === `${basePath}comprobantes/save.php` && request.method === "POST") {
        saveCount += 1;
        const values = parseMultipart(await readBody(request), String(request.headers["content-type"] || ""));
        const glosaMatch = values.glosa.match(/-V(\d+)-I(\d+)$/);
        saves.push({ sessionId, type: values.tipo_comprobante, vu: Number(glosaMatch?.[1]), iteration: Number(glosaMatch?.[2]), glosa: values.glosa });
        if (saveCount === 1) return send(200, "");
        recordNumber += 1;
        records.set(String(recordNumber), { values });
        return send(200, `imp.php?comp=${recordNumber}&mon=1`);
      }
      if (pathname === `${basePath}comprobantes/editar.php`) {
        const id = url.searchParams.get("codigo");
        return records.has(id) ? send(200, "<a>edit_prueba.php</a>") : send(404, "missing");
      }
      if (pathname === `${basePath}comprobantes/edit_prueba.php`) {
        const record = records.get(url.searchParams.get("codigo"));
        return record ? send(200, persistedHtml(record)) : send(404, "missing");
      }
      if (pathname === `${basePath}comprobantes/imp.php`) {
        response.writeHead(200, { "Content-Type": "application/pdf" });
        return response.end("%PDF-1.4 offline mock");
      }
      return send(404, `No mock for ${pathname}`);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(String(error.message));
    }
  });

  return {
    server,
    stats: () => ({ loginCount: sessionNumber, saveCount, saves, records: records.size }),
  };
}

function runK6(condition, baseUrl, summaryPath) {
  const runId = `offline${condition === "shared" ? "SC" : "SI"}123`;
  const child = spawn("k6", ["run", path.resolve("experiments/session-comparison.js")], {
    cwd: process.cwd(),
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      EXECUTION_MODE: "local",
      TEST_NAME: "concurrency-validation",
      RUN_ID: runId,
      FINANCIERO_USER: "offline-user",
      FINANCIERO_PASSWORD: "offline-password",
      FINANCIERO_BASE_URL: baseUrl,
      EXPERIMENT_CONDITION: condition,
      EXPERIMENT_SUMMARY_PATH: summaryPath,
    },
  });
  const lines = [];
  const consume = (stream) => createInterface({ input: stream }).on("line", (line) => lines.push(line));
  consume(child.stdout);
  consume(child.stderr);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output: lines.join("\n") }));
  });
}

async function validateCondition(condition) {
  const mock = createMockApplication();
  const tempDir = mkdtempSync(path.join(os.tmpdir(), `session-${condition}-`));
  const summaryPath = path.join(tempDir, "summary.json");
  await new Promise((resolve, reject) => mock.server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  try {
    const port = mock.server.address().port;
    const result = await runK6(condition, `http://127.0.0.1:${port}${basePath}`, summaryPath);
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    const stats = mock.stats();
    const events = extractManifestEvents(result.output);
    const setupLine = result.output.split("\n").find((line) => line.includes("EXPERIMENT_SETUP "));
    const structuredMessage = setupLine?.match(/\bmsg="((?:\\.|[^"\\])*)"/)?.[1];
    const decodedSetupLine = structuredMessage ? JSON.parse(`"${structuredMessage}"`) : setupLine;
    const setup = decodedSetupLine
      ? JSON.parse(decodedSetupLine.slice(decodedSetupLine.indexOf("EXPERIMENT_SETUP ") + "EXPERIMENT_SETUP ".length))
      : null;
    const expectedLogins = condition === "shared" ? 1 : 2;

    assert.ok([0, 99].includes(result.code), `unexpected k6 exit code ${result.code}: ${result.output}`);
    assert.equal(setup?.authenticated, true, "setup preflight verified all sessions");
    assert.equal(setup?.authenticationCount, expectedLogins);
    assert.equal(setup?.sameServerSession, condition === "shared");
    assert.equal(stats.loginCount, expectedLogins, "no logins happen inside measured iterations");
    assert.equal(stats.saveCount, 4, "one POST per VU iteration, including the ambiguous response");
    assert.equal(new Set(stats.saves.map((save) => save.glosa)).size, 4, "no save request was retried");
    assert.equal(events.length, 4, "one manifest event per iteration");
    assert.equal(Object.hasOwn(summary, "setup_data"), false, "summary excludes session setup data");
    assert.equal(summary.metrics.checks.values.passes > 0, true, "summary keeps k6 checks");
    assert.equal(`${result.output}\n${JSON.stringify(summary)}`.includes("offline-session-"), false,
      "no session cookie value is printed or persisted");
    assert.deepEqual(stats.saves.map((save) => [save.iteration, save.type]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
      [[1, "3"], [1, "3"], [2, "1"], [2, "1"]]);

    if (condition === "shared") {
      assert.equal(new Set(stats.saves.map((save) => save.sessionId)).size, 1, "both VUs sent the same server session");
    } else {
      for (const vu of [1, 2]) {
        assert.equal(new Set(stats.saves.filter((save) => save.vu === vu).map((save) => save.sessionId)).size, 1,
          `VU ${vu} kept its session across iterations`);
      }
      assert.notEqual(stats.saves.find((save) => save.vu === 1)?.sessionId,
        stats.saves.find((save) => save.vu === 2)?.sessionId, "the VUs used distinct server sessions");
    }
    return { condition, exitCode: result.code, loginCount: stats.loginCount, saveCount: stats.saveCount,
      manifestEvents: events.length, sameServerSession: setup.sameServerSession, localMockOnly: true };
  } finally {
    await new Promise((resolve, reject) => mock.server.close((error) => error ? reject(error) : resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const shared = await validateCondition("shared");
const independent = await validateCondition("independent");
console.log(JSON.stringify({ shared, independent }, null, 2));
