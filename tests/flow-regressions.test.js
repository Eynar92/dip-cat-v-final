import test from "node:test";
import assert from "node:assert/strict";
import { getRequest, postRequest } from "../src/http-client.js";
import { parseFormDefaults, validateNumberingContext } from "../src/voucher-parse.js";

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

function formWithArea(areaSelect) {
  return `<input name="global_gestion" value="2026">
    <input name="global_mes" value="9">
    <input name="fecha" value="2026-09-01">
    <select name="codEntidadComprobante"><option value="2" selected>CETOF</option></select>
    <select name="codUnidadComprobante"><option value="1" selected>ADM CETOF</option></select>
    ${areaSelect}`;
}

test("rechaza el contexto si el área esperada no está presente", () => {
  const defaults = parseFormDefaults(formWithArea(""));
  const result = validateNumberingContext(defaults, expectedContext);

  assert.equal(result.ok, false);
  assert.match(result.reason, /área activa/i);
});

test("valida el valor y el nombre del área activa, no una opción no seleccionada", () => {
  const defaults = parseFormDefaults(formWithArea(`<select name="codAreaComprobante">
    <option value="1">ADM CETOF</option>
    <option value="2" selected>OTRA ÁREA</option>
  </select>`));
  const result = validateNumberingContext(defaults, expectedContext);

  assert.equal(defaults.area, "2");
  assert.equal(result.ok, false);
});

test("acepta el área activa cuando coinciden código y nombre configurados", () => {
  const defaults = parseFormDefaults(formWithArea(`<select name="codAreaComprobante">
    <option value="2">OTRA ÁREA</option>
    <option value="1" selected>ADM CETOF</option>
  </select>`));

  assert.equal(validateNumberingContext(defaults, expectedContext).ok, true);
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
