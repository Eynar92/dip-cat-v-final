import { recordOperation as defaultRecord } from "./metrics.js";
import { parseFormDefaults } from "./voucher-parse.js";

export function authenticate({ http, check, cfg, recordOperation = defaultRecord }, session) {
  let response = http.get(`${cfg.baseUrl}/login.html`, { jar: session.jar, tags: { operation: "login", voucher_type: "none" } });
  if (!check(response, { "formulario de acceso disponible": (r) => r.status === 200 })) return false;
  response = http.post(`${cfg.baseUrl}/session.php`, { user: cfg.user, password: cfg.password }, {
    jar: session.jar, redirects: 0, headers: { "Content-Type": "application/x-www-form-urlencoded" }, tags: { operation: "login_submit", voucher_type: "none" },
  });
  recordOperation(response, "login_submit", 0);
  const accepted = check(response, { "autenticación aceptada": (r) => [302, 303].includes(r.status) });
  if (!accepted) return false;
  response = http.get(`${cfg.baseUrl}/index.php`, { jar: session.jar, tags: { operation: "auth_check", voucher_type: "none" } });
  return check(response, { "sesión autenticada": (r) => r.status === 200 && !r.body.includes("name=\"password\"") });
}

export function getContext({ http, check, cfg, recordOperation = defaultRecord }, session) {
  let response = http.get(`${cfg.baseUrl}/modulo.php?codigo=3`, { jar: session.jar, redirects: 0, tags: { operation: "context", voucher_type: "none" } });
  const moduleOk = check(response, { "módulo contable disponible": (r) => [302, 303].includes(r.status) });
  if (!moduleOk) return { ok: false };
  response = http.get(`${cfg.baseUrl}/index.php?opcion=homeModulo`, { jar: session.jar, tags: { operation: "context", voucher_type: "none" } });
  if (!check(response, { "contexto contable disponible": (r) => r.status === 200 })) return { ok: false };
  const html = String(response.body);
  // El listado expone la sesión y el formulario confirma entidad/oficina antes de crear.
  const listing = http.get(`${cfg.baseUrl}/index.php?opcion=listComprobantes`, { jar: session.jar, tags: { operation: "context", voucher_type: "none" } });
  const register = http.get(`${cfg.baseUrl}/comprobantes/register.php`, { jar: session.jar, tags: { operation: "form", voucher_type: "none" } });
  const form = String(register.body);
  const expected = cfg.expectedContext;
  const defaults = parseFormDefaults(form);
  const unitLabel = String(form).includes(expected.officeName) && String(form).includes(expected.areaName) && String(form).includes(expected.entityName);
  const verified = register.status === 200 && listing.status === 200 && defaults.ok && unitLabel &&
    Number(defaults.year) === expected.managementYear && Number(defaults.month) === expected.workMonth &&
    defaults.unitName.includes(expected.officeName);
  return { ok: check({ ok: verified, status: register.status }, { "contexto disponible sin cambiar parámetros": (r) => r.ok }),
    year: defaults.year, month: defaults.month, html: form };
}
