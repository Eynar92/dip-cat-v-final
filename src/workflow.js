import { recordOperation as defaultRecord } from "./metrics.js";
import { getAccountingModuleRequest, getRequest, isUnauthenticatedResponse, postRequest } from "./http-client.js";
import { parseFormDefaults, validateNumberingContext } from "./voucher-parse.js";

function request(ctx, session, path, operation, type = null, options = {}) {
  return getRequest({ ...ctx, session, path, operation, type, options,
    recordOperation: ctx.recordOperation || defaultRecord,
    onSessionInvalidResponse: ctx.onSessionInvalidResponse });
}

function isSuccessful(check, response, name, predicate) {
  return check(response, { [name]: predicate });
}

export function authenticate(ctx, session) {
  const { check, cfg } = ctx;
  let response = request(ctx, session, "login.html", "login_form");
  ctx.onAuthResponse?.(response, `${cfg.baseUrl.replace(/\/$/, "")}/login.html`);
  if (!isSuccessful(check, response, "formulario de acceso disponible", (value) => value.status === 200)) {
    return { ok: false, stage: "login-form", reason: "El formulario de acceso no respondió correctamente." };
  }

  response = postRequest({ ...ctx, session, path: "session.php", body: { user: cfg.user, password: cfg.password },
    operation: "login_submit", type: null, recordOperation: ctx.recordOperation || defaultRecord,
    onSessionInvalidResponse: ctx.onSessionInvalidResponse,
    options: { redirects: 0, headers: { "Content-Type": "application/x-www-form-urlencoded" } } });
  ctx.onAuthResponse?.(response, `${cfg.baseUrl.replace(/\/$/, "")}/session.php`);
  if (!isSuccessful(check, response, "autenticación aceptada", (value) => [302, 303].includes(value.status))) {
    return { ok: false, stage: "authentication", reason: "El ambiente rechazó la autenticación." };
  }

  response = request(ctx, session, "index.php", "auth_check");
  ctx.onAuthResponse?.(response, `${cfg.baseUrl.replace(/\/$/, "")}/index.php`);
  const authenticated = isSuccessful(check, response, "sesión autenticada",
    (value) => value.status === 200 && !String(value.body).includes('name="password"'));
  return authenticated ? { ok: true } : { ok: false, stage: "authentication", reason: "La sesión no quedó autenticada." };
}

export function checkAuthenticatedSession(ctx, session) {
  const response = request(ctx, session, "index.php", "auth_check");
  ctx.onAuthResponse?.(response, `${ctx.cfg.baseUrl.replace(/\/$/, "")}/index.php`);
  return isSuccessful(ctx.check, response, "sesión autenticada en preflight",
    (value) => value.status === 200 && !String(value.body).includes('name="password"'));
}

function sessionStillAuthenticated(_ctx, response) {
  return !isUnauthenticatedResponse(response);
}

export function getContext(ctx, session) {
  const { check, cfg } = ctx;
  let response = getAccountingModuleRequest({ ...ctx, recordOperation: ctx.recordOperation || defaultRecord }, session);
  if (!sessionStillAuthenticated(ctx, response)) {
    return { ok: false, stage: "session", reason: "La respuesta indicó que la sesión no estaba autenticada." };
  }
  if (!isSuccessful(check, response, "módulo contable disponible", (value) => [302, 303].includes(value.status))) {
    return { ok: false, stage: "accounting-module", reason: "No se pudo abrir el módulo contable." };
  }

  response = request(ctx, session, "index.php?opcion=homeModulo", "context");
  if (!sessionStillAuthenticated(ctx, response)) return { ok: false, stage: "session", reason: "La respuesta indicó que la sesión no estaba autenticada." };
  if (!isSuccessful(check, response, "contexto contable disponible", (value) => value.status === 200)) {
    return { ok: false, stage: "accounting-context", reason: "No se pudo cargar el contexto contable." };
  }

  const listing = request(ctx, session, "index.php?opcion=listComprobantes", "listing");
  if (!sessionStillAuthenticated(ctx, listing)) return { ok: false, stage: "session", reason: "La respuesta indicó que la sesión no estaba autenticada." };
  if (!isSuccessful(check, listing, "listado de comprobantes disponible", (value) => value.status === 200)) {
    return { ok: false, stage: "voucher-list", reason: "No se pudo cargar el listado de comprobantes." };
  }

  const register = request(ctx, session, "comprobantes/register.php", "form");
  if (!sessionStillAuthenticated(ctx, register)) return { ok: false, stage: "session", reason: "La respuesta indicó que la sesión no estaba autenticada." };
  if (!isSuccessful(check, register, "formulario de comprobante disponible", (value) => value.status === 200)) {
    return { ok: false, stage: "voucher-form", reason: "No se pudo abrir el formulario de comprobantes." };
  }

  const defaults = parseFormDefaults(register.body);
  const contextCheck = validateNumberingContext(defaults, cfg.expectedContext);
  const contextOk = check({ ok: contextCheck.ok }, {
    "contexto activo coincide con la configuración": (value) => value.ok,
  });
  if (!contextOk) {
    return { ok: false, stage: "context-validation", reason: contextCheck.reason, defaults };
  }
  return { ok: true, defaults, html: String(register.body), numberingContext: {
    managementYear: defaults.year,
    workMonth: defaults.month,
    entityCode: defaults.entity,
    officeCode: defaults.office,
    areaCode: defaults.area || null,
  } };
}
