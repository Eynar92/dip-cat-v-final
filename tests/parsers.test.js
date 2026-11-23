import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFormDefaults,
  parseLineContext,
  parsePersistedVoucher,
  resolveAccount,
  validateNumberingContext,
} from "../src/voucher-parse.js";

const account = { accountNumber: "1101010001", accountName: "CAJA M/N" };
const data = {
  type: 1,
  lines: [
    { accountNumber: "1101010001", accountName: "CAJA M/N", debit: 10, credit: 0 },
    { accountNumber: "5102200002", accountName: "GASTO EN IMPRENTA", debit: 0, credit: 10 },
  ],
};
const accounts = [
  { id: "13004", name: "CAJA M/N", unit: "1", area: "1" },
  { id: "13291", name: "GASTO EN IMPRENTA", unit: "1", area: "1" },
];
const glosa = "DIP_Cato-G6-test-CV-V1-I1";

function persistedHtml(overrides = {}) {
  const fields = {
    tipo_comprobante: "1",
    fecha: "2026-09-01",
    nro_correlativo: "13",
    glosa,
    glosa_detalle1: glosa,
    glosa_detalle2: glosa,
    debe1: "10",
    haber1: "0",
    debe2: "0",
    haber2: "10",
    totaldeb: "10",
    totalhab: "10",
    ...overrides,
  };
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input name="${name}" value="${value}">`)
    .join("\n");
  return `${inputs}
    <script>
      filaActiva=1;
      setBusquedaCuentaEdit('13004','1101010001','CAJA M/N','1','1');
      filaActiva=2;
      setBusquedaCuentaEdit('13291','5102200002','GASTO EN IMPRENTA','1','1');
    </script>`;
}

function parsePersisted(html) {
  return parsePersistedVoucher(html, {
    data,
    id: "18363",
    glosa,
    date: "2026-09-01",
    accounts,
    proposedCorrelative: "12",
  });
}

test("parseFormDefaults rejects missing or empty required fields", () => {
  const valid = '<select name="codEntidadComprobante"><option value="2" selected>CETOF</option></select><select name="codUnidadComprobante"><option value="1" selected>ADM CETOF</option></select><input name="global_gestion" value="2026"><input name="global_mes" value="9"><input name="fecha" value="2026-09-01">';
  assert.equal(parseFormDefaults(valid).ok, true);
  assert.equal(parseFormDefaults('<input name="global_gestion" value="2026"><input name="global_mes" value="9">').ok, false);
  assert.equal(parseFormDefaults(valid.replace('<input name="fecha" value="2026-09-01">', "")).ok, false);
});

test("numbering context reads the active values and ignores matching inactive options", () => {
  const expected = {
    managementYear: 2026,
    workMonth: 9,
    entityCode: 2,
    entityName: "CETOF",
    officeCode: 1,
    officeName: "ADM CETOF",
    areaCode: 1,
    areaName: "ADM CETOF",
  };
  const activeContext = `<input name="global_gestion" value="2026"><input name="global_mes" value="9">
    <input name="fecha" value="2026-09-01">
    <select name="codEntidadComprobante"><option value="99">Otra</option><option value="2" selected>CETOF</option></select>
    <select name="codUnidadComprobante"><option value="5">Otra oficina</option><option value="1" selected>ADM CETOF</option></select>
    <select name="codAreaComprobante"><option value="3">Otra área</option><option value="1" selected>ADM CETOF</option></select>`;
  const inactiveMatch = activeContext
    .replace('<option value="2" selected>CETOF</option>', '<option value="2">CETOF</option>')
    .replace('<option value="99">Otra</option>', '<option value="99" selected>Otra</option>');

  assert.equal(validateNumberingContext(parseFormDefaults(activeContext), expected).ok, true);
  assert.equal(validateNumberingContext(parseFormDefaults(inactiveMatch), expected).ok, false);
});

test("line context uses the selected unit and area options", () => {
  const html = `<select name="unidad1"><option value="2">Otra</option><option value="1" selected>ADM CETOF</option></select>
    <select name="area1"><option value="3">Otra</option><option value="1" selected>ADM CETOF</option></select>`;
  const context = parseLineContext(html, 1);
  assert.equal(context.ok, true);
  assert.equal(context.unit, "1");
  assert.equal(context.area, "1");
  const otherSelection = parseLineContext(html.replace('value="2">Otra', 'value="2" selected>Otra'), 1);
  assert.equal(otherSelection.ok, true);
  assert.equal(otherSelection.unit, "2");
});

test("resolveAccount does not accept a partially matching account number", () => {
  const valid = `<script>setBusquedaCuenta('13004','1101010001','CAJA M/N','1','1');</script>`;
  const partial = `<script>setBusquedaCuenta('13004','91101010001','CAJA M/N','1','1');</script>`;
  assert.equal(resolveAccount(valid, account)?.id, "13004");
  assert.equal(resolveAccount(partial, account), null);
});

test("persisted parser reports the final correlative without requiring it to equal the proposal", () => {
  const result = parsePersisted(persistedHtml());
  assert.equal(result.ok, true);
  assert.equal(result.valid, true);
  assert.equal(result.correlativeFinal, "13");
  assert.notEqual(result.correlativeFinal, "12");
});

test("persisted parser compares final correlative when original evidence supplies one", () => {
  assert.equal(parsePersistedVoucher(persistedHtml(), {
    data, id: "18363", glosa, date: "2026-09-01", accounts, proposedCorrelative: "12",
    expectedCorrelativeFinal: "13",
  }).ok, true);
  const mismatch = parsePersistedVoucher(persistedHtml(), {
    data, id: "18363", glosa, date: "2026-09-01", accounts, proposedCorrelative: "12",
    expectedCorrelativeFinal: "14",
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /correlativo final no coincide/);
});

test("persisted parser rejects an account ID that only contains the expected ID", () => {
  const html = persistedHtml().replace("setBusquedaCuentaEdit('13004'", "setBusquedaCuentaEdit('913004'");
  const result = parsePersisted(html);
  assert.equal(result.ok, false);
});

test("persisted parser validates the account ID only in codigoCuenta", () => {
  const auxiliaryContainsExpected = persistedHtml().replace(
    "setBusquedaCuentaEdit('13004','1101010001','CAJA M/N','1','1')",
    "setBusquedaCuentaEdit('99999','1101010001','CAJA M/N','13004','1')",
  );
  const result = parsePersisted(auxiliaryContainsExpected);
  assert.equal(result.ok, false);
  assert.match(result.reason, /fila 1: cuenta/);
});

test("persisted parser associates callbacks with explicit filaActiva rows", () => {
  const swapped = persistedHtml().replace(
    "filaActiva=1;\n      setBusquedaCuentaEdit('13004','1101010001','CAJA M/N','1','1');\n      filaActiva=2;\n      setBusquedaCuentaEdit('13291','5102200002','GASTO EN IMPRENTA','1','1');",
    "filaActiva=1;\n      setBusquedaCuentaEdit('13291','5102200002','GASTO EN IMPRENTA','1','1');\n      filaActiva=2;\n      setBusquedaCuentaEdit('13004','1101010001','CAJA M/N','1','1');",
  );
  const result = parsePersisted(swapped);
  assert.equal(result.ok, false);
  assert.match(result.reason, /fila 1: cuenta/);
  assert.match(result.reason, /fila 2: cuenta/);
});

test("persisted parser rejects absent and incomplete account callbacks", () => {
  const absent = persistedHtml().replace(/filaActiva=2;\s*setBusquedaCuentaEdit\([^;]+;?/, "");
  const incomplete = persistedHtml().replace(
    "setBusquedaCuentaEdit('13004','1101010001','CAJA M/N','1','1')",
    "setBusquedaCuentaEdit('13004','1101010001','CAJA M/N','1')",
  );
  assert.equal(parsePersisted(absent).ok, false);
  const result = parsePersisted(incomplete);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no se pudo verificar la firma o la fila/);
});

test("sanitized persisted response sample identifies the account ID and its explicit row", () => {
  const sample = persistedHtml().replaceAll("'1','1'", "'0',''");
  const result = parsePersisted(sample);
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows.map(({ accountId, accountNumber, accountName }) => ({ accountId, accountNumber, accountName })), [
    { accountId: "13004", accountNumber: "1101010001", accountName: "CAJA M/N" },
    { accountId: "13291", accountNumber: "5102200002", accountName: "GASTO EN IMPRENTA" },
  ]);
});

test("persisted parser rejects a missing amount even when the expected amount is zero", () => {
  const html = persistedHtml().replace('<input name="haber1" value="0">', "");
  assert.equal(parsePersisted(html).ok, false);
});

test("persisted parser rejects empty numeric fields and incomplete details", () => {
  assert.equal(parsePersisted(persistedHtml({ debe1: "" })).ok, false);
  assert.equal(parsePersisted(persistedHtml({ glosa_detalle2: "" })).ok, false);
  assert.equal(parsePersisted(persistedHtml({ totalhab: "" })).ok, false);
});

