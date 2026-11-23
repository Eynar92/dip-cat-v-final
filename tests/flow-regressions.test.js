import test from "node:test";
import assert from "node:assert/strict";
import { getAccountingModuleRequest, getRequest, postRequest } from "../src/http-client.js";
import { parseFormDefaults, parseLineContext, parsePersistedVoucher, validateLineContext, validateNumberingContext } from "../src/voucher-parse.js";

const expectedContext = {
  managementYear: 2026,
  workMonth: 9,
  entityCode: 2,
  entityName: "CETOF",
  officeCode: 1,
  officeName: "ADM CETOF",
  areaCode: 1,
  areaName: "ADM CETOF",
};

function registerForm() {
  return `<input type="hidden" id="cod_entidad_comprobante" value="2">
    <input type="hidden" id="cod_unidad_comprobante" value="1">
    <input name="global_gestion" value="2026">
    <input name="global_mes" value="9">
    <input name="fecha" value="2026-09-01">
    <input name="unidad_organizacional" value="ADM CETOF - ADM CETOF">`;
}

test("lee entidad y oficina de inputs con id y valida contexto global sin área", () => {
  const defaults = parseFormDefaults(registerForm());
  const result = validateNumberingContext(defaults, expectedContext);

  assert.equal(defaults.entity, "2");
  assert.equal(defaults.entityName, "");
  assert.equal(defaults.office, "1");
  assert.equal(defaults.officeName, "ADM CETOF - ADM CETOF");
  assert.equal(defaults.area, "");
  assert.equal(result.ok, true);
});

test("valida unidad y área activas del fragmento de línea", () => {
  const html = `<select name="unidad1"><option value="1" data-subtext="ADM CETOF">ADM CETOF</option></select>
    <select name="area1"><option value="2">Otra</option><option value="1" selected>ADM CETOF</option></select>`;
  const context = parseLineContext(html, 1);

  assert.deepEqual(context, { unit: "1", unitName: "ADM CETOF", area: "1", areaName: "ADM CETOF", ok: true });
  assert.equal(validateLineContext(context, expectedContext).ok, true);
});

test("rechaza una línea si falta el área activa aunque el contexto global sea válido", () => {
  const defaults = parseFormDefaults(registerForm());
  const context = parseLineContext(`<select name="unidad1"><option value="1" selected>ADM CETOF</option></select>`, 1);

  assert.equal(validateNumberingContext(defaults, expectedContext).ok, true);
  assert.equal(validateLineContext(context, expectedContext).ok, false);
});

test("rechaza código o nombre distinto en el área activa, aunque coincida una opción inactiva", () => {
  const context = parseLineContext(`<select name="unidad1"><option value="1" selected>ADM CETOF</option></select>
    <select name="area1"><option value="1">ADM CETOF</option><option value="2" selected>OTRA ÁREA</option>
  </select>`, 1);

  assert.equal(context.area, "2");
  assert.equal(validateLineContext(context, expectedContext).ok, false);
});

test("rechaza el nombre activo de área incorrecto incluso si el código coincide", () => {
  const context = parseLineContext(`<select name="unidad1"><option value="1" selected>ADM CETOF</option></select>
    <select name="area1"><option value="1" selected>OTRA ÁREA</option></select>`, 1);

  assert.equal(validateLineContext(context, expectedContext).ok, false);
});

test("rechaza el código de unidad activa que no coincide", () => {
  const context = parseLineContext(`<select name="unidad1"><option value="2" selected>OTRA</option></select>
    <select name="area1"><option value="1" selected>ADM CETOF</option></select>`, 1);

  assert.equal(validateLineContext(context, expectedContext).ok, false);
});

test("acepta el área activa cuando coinciden código y nombre configurados", () => {
  const context = parseLineContext(`<select name="unidad1"><option value="1" selected>ADM CETOF</option></select>
    <select name="area1"><option value="1" selected>ADM CETOF</option></select>`, 1);

  assert.equal(validateLineContext(context, expectedContext).ok, true);
});

test("rechaza el contexto global si falta entidad u oficina activa", () => {
  const defaults = parseFormDefaults(`<input name="global_gestion" value="2026">
    <input name="global_mes" value="9"><input name="fecha" value="2026-09-01">`);
  const result = validateNumberingContext(defaults, expectedContext);

  assert.equal(result.ok, false);
});

test("usa nombres de petición estables aunque cambie el ID de la URL", () => {
  const requests = [];
  const http = {
    get(url, options) {
      requests.push({ method: "GET", url, options });
      return { status: 200, timings: { duration: 2 } };
    },
    post(url, body, options) {
      requests.push({ method: "POST", url, body, options });
      return { status: 200, timings: { duration: 3 } };
    },
  };
  const base = { http, cfg: { baseUrl: "https://example.test/app/", requestTimeout: "30s" }, session: { jar: {} }, type: 1 };

  getRequest({ ...base, path: "comprobantes/editar.php?codigo=10", operation: "persistence_redirect" });
  getRequest({ ...base, path: "comprobantes/editar.php?codigo=11", operation: "persistence_redirect" });
  postRequest({ ...base, path: "comprobantes/save.php", body: "payload", operation: "save" });

  assert.equal(requests[0].options.tags.name, "persistence_redirect");
  assert.equal(requests[1].options.tags.name, "persistence_redirect");
  assert.equal(requests[2].options.tags.name, "save");
  assert.deepEqual(requests.map(({ options }) => options.tags.operation), [
    "persistence_redirect", "persistence_redirect", "save",
  ]);
  assert.ok(requests.every(({ options }) => options.timeout === "30s"));
});

test("conserva el 302 original del módulo contable", () => {
  let captured;
  const response = getAccountingModuleRequest({
    http: {
      get(url, options) {
        captured = { url, options };
        return { status: options.redirects === 0 ? 302 : 200, timings: { duration: 1 } };
      },
    },
    cfg: { baseUrl: "https://example.test/app", requestTimeout: "30s" },
    recordOperation() {},
  }, { jar: {} });

  assert.match(captured.url, /modulo\.php\?codigo=3$/);
  assert.equal(captured.options.redirects, 0);
  assert.equal(captured.options.tags.name, "module");
  assert.equal(response.status, 302);
});

function twoLinePersistedVoucher({ headerGlosa = "G-V1", detailGlosa = "G-V1", includeSecondLine = true,
  totalDebit = "10.00", totalCredit = "10.00" } = {}) {
  const secondRow = includeSecondLine
    ? `<input name="debe2" value="0.00"><input name="haber2" value="10.00">
       <input name="glosa_detalle2" value="${detailGlosa}">
       <script>filaActiva=2;setBusquedaCuentaEdit(13291,5102200002,"GASTO EN IMPRENTA",1,1)</script>`
    : "";
  return `<select name="tipo_comprobante"><option value="1" selected>Ingreso</option></select>
    <input name="fecha" value="2026-09-01"><input name="glosa" value="${headerGlosa}">
    <input name="nro_correlativo" value="15">
    <input name="debe1" value="10.00"><input name="haber1" value="0.00">
    <input name="glosa_detalle1" value="${detailGlosa}">
    <script>filaActiva=1;setBusquedaCuentaEdit(13004,1101010001,"CAJA M/N",1,1)</script>
    ${secondRow}
    <input name="totaldeb" value="${totalDebit}"><input name="totalhab" value="${totalCredit}">`;
}

const expectedPersisted = {
  data: { type: 1, lines: [{ accountNumber: "1101010001", accountName: "CAJA M/N", debit: 10, credit: 0 },
    { accountNumber: "5102200002", accountName: "GASTO EN IMPRENTA", debit: 0, credit: 10 }] },
  id: "18370",
  glosa: "G-V1",
  date: "2026-09-01",
  accounts: [{ id: "13004" }, { id: "13291" }],
  proposedCorrelative: "14",
};

test("diagnostica glosa distinta entre cabecera V1 y detalles V2", () => {
  const result = parsePersistedVoucher(twoLinePersistedVoucher({ detailGlosa: "G-V2" }), expectedPersisted);

  assert.equal(result.ok, false);
  assert.match(result.reason, /fila 1: glosa/);
  assert.match(result.reason, /fila 2: glosa/);
  assert.doesNotMatch(result.reason, /G-V1|G-V2/);
});

test("diagnostica segunda fila ausente y totales inconsistentes", () => {
  const result = parsePersistedVoucher(twoLinePersistedVoucher({ includeSecondLine: false, totalDebit: "9.00" }), expectedPersisted);

  assert.equal(result.ok, false);
  assert.match(result.reason, /cantidad de filas \(esperadas 2, encontradas 1\)/);
  assert.match(result.reason, /total Debe/);
  assert.match(result.reason, /fila 2: cuenta, glosa, Debe, Haber/);
});
