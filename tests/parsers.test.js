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
      setBusquedaCuentaEdit('13004','1101010001','CAJA M/N','1','1');
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

test("persisted parser rejects an account ID that only contains the expected ID", () => {
  const html = persistedHtml().replace("setBusquedaCuentaEdit('13004'", "setBusquedaCuentaEdit('913004'");
  const result = parsePersisted(html);
  assert.equal(result.ok, false);
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

