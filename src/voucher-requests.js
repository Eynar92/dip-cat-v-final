import { recordOperation as defaultRecord } from "./metrics.js";
import { getRequest, postRequest } from "./http-client.js";
import { parseLineContext, parseFormDefaults, parsePersistedVoucher, resolveAccount, validateLineContext } from "./voucher-parse.js";

function requestContext(ctx, session, operation, type, path) {
  return { http: ctx.http, cfg: ctx.cfg, session, path, operation, type,
    recordOperation: ctx.recordOperation || defaultRecord };
}

function checkResponse(check, response, name, predicate) {
  return check(response, { [name]: predicate });
}

function failure(stage, reason, details = {}) {
  return { ok: false, stage, reason, ...details };
}

function extractCorrelative(html) {
  const source = String(html);
  const input = source.match(/<input\b(?=[^>]*\bname=["']nro_correlativo["'])[^>]*>/i)?.[0] ||
    source.match(/<input\b(?=[^>]*\bvalue=["']\d+["'])[^>]*\bname=["']nro_correlativo["'][^>]*>/i)?.[0] || "";
  const value = input.match(/\bvalue=["']([^"']*)["']/i)?.[1] || "";
  return /^\d+$/.test(value) ? value : null;
}

function extractDate(html) {
  const source = String(html);
  const tag = source.match(/<input\b(?=[^>]*\bname=["']fecha["'])[^>]*>/i)?.[0] || "";
  const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] || "";
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function dateMatchesContext(date, expectedContext) {
  if (!date) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date &&
    parsed.getUTCFullYear() === Number(expectedContext.managementYear) &&
    parsed.getUTCMonth() + 1 === Number(expectedContext.workMonth);
}

function selectedContextIsValid(lineContext, expectedContext) {
  return validateLineContext(lineContext, expectedContext);
}

function buildPayload({ defaults, data, accounts, glosa, correlative, date }) {
  const debit = data.lines.reduce((sum, line) => sum + line.debit, 0);
  const credit = data.lines.reduce((sum, line) => sum + line.credit, 0);
  if (debit !== credit) throw new Error("La plantilla no está balanceada.");
  if (!defaults.unitName) throw new Error("El formulario no contiene el nombre activo de la unidad organizacional.");

  const payload = {
    validacion_libretas: 1,
    cantidad_filas: data.lines.length,
    codigo_comprobante: 0,
    codigo_iva_direfido: 0,
    cod_cuenta_configuracion_iva: "9473,1473,13041",
    cod_sis_configuracion: 0,
    global_gestion: defaults.year,
    global_mes: defaults.month,
    gestion: defaults.year,
    unidad_organizacional: defaults.unitName,
    tipo_comprobante: data.type,
    nro_correlativo: correlative,
    fecha: date,
    pagado_a: "",
    glosa,
    validar_factura: "on",
    totaldeb: debit.toFixed(2),
    totalhab: credit.toFixed(2),
    total_dif: "0.00",
    tipo_documento_otro: -100,
    cantidad_archivosadjuntos: 0,
    facturas: "[[],[]]",
    estados_cuentas: "[[],[]]",
  };

  data.lines.forEach((line, index) => {
    const row = index + 1;
    const account = accounts[index];
    Object.assign(payload, {
      [`unidad${row}`]: account.unit,
      [`area${row}`]: account.area,
      [`cuenta${row}`]: account.id,
      [`cuenta_auxiliar${row}`]: "0",
      [`cod_detallelibreta${row}`]: "0",
      [`cod_detallesolicitudsis${row}`]: "0",
      [`cod_actividadproyecto${row}`]: "0",
      [`cod_accnum${row}`]: "0",
      [`debe${row}`]: line.debit,
      [`haber${row}`]: line.credit,
      [`cod_tipo_cheque${row}`]: "",
      [`nro_cheque${row}`]: "",
      [`glosa_detalle${row}`]: glosa,
    });
  });
  return payload;
}

function toMultipart(payload, glosa) {
  const boundary = `----k6-${glosa.replace(/[^A-Za-z0-9]/g, "")}`;
  const fields = Object.entries(payload).map(([name, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("");
  return { boundary, body: `${fields}--${boundary}--\r\n` };
}

export function verifyPersistedVoucher({ http, check, cfg, session, data, id, glosa, date, accounts,
  proposedCorrelative, recordOperation, onParsed }) {
  const record = recordOperation || defaultRecord;
  const options = { jar: session.jar, timeout: cfg.requestTimeout,
    tags: { name: "persistence_redirect", operation: "persistence_redirect", voucher_type: String(data.type) }, redirects: 0 };
  const redirectPage = http.get(`${cfg.baseUrl.replace(/\/$/, "")}/comprobantes/editar.php?codigo=${encodeURIComponent(id)}`, options);
  record(redirectPage, "persistence_redirect", data.type);
  const redirectOk = checkResponse(check, redirectPage, "edición identifica la consulta de detalle",
    (response) => response.status === 200 && String(response.body).includes("edit_prueba.php"));
  if (!redirectOk) return { ok: false, parsed: null, stage: "persistence-link", reason: "La página de edición no indicó el detalle persistido." };

  const detail = http.get(`${cfg.baseUrl.replace(/\/$/, "")}/comprobantes/edit_prueba.php?codigo=${encodeURIComponent(id)}`, {
    jar: session.jar, timeout: cfg.requestTimeout,
    tags: { name: "persistence_detail", operation: "persistence_detail", voucher_type: String(data.type) },
  });
  record(detail, "persistence_detail", data.type);
  const responseOk = checkResponse(check, detail, "detalle persistido disponible", (response) => response.status === 200);
  if (!responseOk) return { ok: false, parsed: null, stage: "persistence-detail", reason: "No se pudo leer el detalle persistido." };

  const parsed = parsePersistedVoucher(detail.body, { data, id, glosa, date, accounts, proposedCorrelative });
  if (onParsed) onParsed(parsed);
  const dataOk = check({ ok: parsed.ok }, { "persistencia coincide con el comprobante": (result) => result.ok });
  if (!dataOk) return { ok: false, parsed, stage: "persistence-validation", reason: parsed.reason };

  const pdf = http.get(`${cfg.baseUrl.replace(/\/$/, "")}/comprobantes/imp.php?comp=${encodeURIComponent(id)}&mon=1`, {
    jar: session.jar, timeout: cfg.requestTimeout,
    tags: { name: "pdf", operation: "pdf", voucher_type: String(data.type) },
  });
  record(pdf, "pdf", data.type);
  const pdfOk = check(pdf, { "PDF descargado con firma válida": (response) =>
    response.status === 200 && String(response.headers["Content-Type"] || "").toLowerCase().includes("application/pdf") &&
    String(response.body).startsWith("%PDF") });
  return pdfOk
    ? { ok: true, parsed, stage: "verified", reason: null }
    : { ok: false, parsed, stage: "pdf-verification", reason: "El PDF no pasó la validación de formato." };
}

export function requestVoucher(ctx, session, context, event) {
  const { check, cfg, data, glosa } = ctx;
  const defaults = context.defaults || parseFormDefaults(context.html);
  const numberContext = context.numberingContext;
  if (!defaults.ok || !numberContext) return failure("voucher-form", "No se pudieron leer los valores activos del formulario.");
  if (defaults.glosaMaxLength && glosa.length > defaults.glosaMaxLength) {
    return failure("glosa-validation", "La glosa supera el límite declarado por el formulario.");
  }

  const query = `tipo_comprobante=${encodeURIComponent(data.type)}&codEntidadComprobante=${encodeURIComponent(numberContext.entityCode)}` +
    `&codUnidadComprobante=${encodeURIComponent(numberContext.officeCode)}`;
  event.numberingContext = numberContext;
  event.stage = "correlative";
  let response = getRequest(requestContext(ctx, session, "correlative", data.type,
    `comprobantes/ajaxCorrelativo.php?${query}`));
  if (!checkResponse(check, response, "correlativo disponible", (value) => value.status === 200)) {
    return failure("correlative", "No se pudo consultar el correlativo propuesto.");
  }
  const correlativeProposed = extractCorrelative(response.body);
  if (!correlativeProposed) return failure("correlative", "La respuesta no contiene un correlativo numérico.");
  event.correlativeProposed = correlativeProposed;

  event.stage = "date";
  response = getRequest(requestContext(ctx, session, "date", data.type,
    `comprobantes/ajax_fecha_comprobante.php?${query}&fecha=${encodeURIComponent(defaults.date)}&codigo=0`));
  const date = extractDate(response.body);
  const dateOk = checkResponse(check, response, "fecha permitida para el contexto",
    (value) => value.status === 200 && dateMatchesContext(date, cfg.expectedContext));
  if (!dateOk) return failure("date", "El ambiente no devolvió una fecha válida para el contexto.", { correlativeProposed });

  const accounts = [];
  for (let index = 0; index < data.lines.length; index += 1) {
    const row = index + 1;
    event.stage = "line-context";
    response = getRequest(requestContext(ctx, session, "detail_form", data.type,
      `comprobantes/ajaxCuentaContable.php?idFila=${row}&codEntidadComprobante=${encodeURIComponent(numberContext.entityCode)}&glosa=${encodeURIComponent(glosa)}`));
    if (!checkResponse(check, response, `formulario de detalle ${row}`, (value) => value.status === 200)) {
      return failure("account-options", `No se pudo cargar la línea ${row} del detalle.`, { correlativeProposed });
    }
    const lineContext = parseLineContext(response.body, row);
    const activeContext = selectedContextIsValid(lineContext, cfg.expectedContext);
    if (!check({ ok: activeContext.ok }, { [`contexto activo de la línea ${row}`]: (value) => value.ok })) {
      return failure("line-context", activeContext.reason, { correlativeProposed });
    }

    const line = data.lines[index];
    event.stage = "account-search";
    response = getRequest(requestContext(ctx, session, "account_search", data.type,
      `comprobantes/ajaxBusquedaCuenta.php?nro_cuenta=${encodeURIComponent(line.accountNumber)}&cuenta=&padre=&auxiliar=`));
    const account = resolveAccount(response.body, line);
    const accountOk = checkResponse(check, response, `cuenta correcta ${row}`,
      (value) => value.status === 200 && !!account);
    if (!accountOk) return failure("account-search", `No se encontró la cuenta exacta de la línea ${row}.`, { correlativeProposed });
    accounts.push({ ...account, unit: lineContext.unit, area: lineContext.area });
  }

  const payload = buildPayload({ defaults, data, accounts, glosa, correlative: correlativeProposed, date });
  const multipart = toMultipart(payload, glosa);
  event.stage = "save";
  response = postRequest({ ...ctx, session, path: "comprobantes/save.php", body: multipart.body,
    operation: "save", type: data.type, recordOperation: ctx.recordOperation || defaultRecord,
    options: { headers: { "Content-Type": `multipart/form-data; boundary=${multipart.boundary}` } } });
  const id = String(response.body).match(/imp\.php\?comp=(\d+)&(?:amp;)?mon=(\d+)/i)?.[1] || null;
  event.id = id;
  const saveOk = check(response, { "guardado devuelve identificador": (value) => value.status === 200 && !!id });
  if (!id) return failure("save", "La respuesta al guardado no permite confirmar si creó el comprobante.", {
    status: "save-ambiguous", correlativeProposed, id: null, numberingContext: numberContext,
  });

  event.stage = "persistence";
  const persisted = verifyPersistedVoucher({ http: ctx.http, check, cfg, session, data, id, glosa, date, accounts,
    proposedCorrelative: correlativeProposed, recordOperation: ctx.recordOperation,
    onParsed: (parsed) => { event.correlativeFinal = parsed.correlativeFinal; } });
  const correlativeFinal = persisted.parsed?.correlativeFinal || null;
  event.correlativeFinal = correlativeFinal;
  if (!persisted.ok || !saveOk) {
    return failure("created-verification-incomplete", persisted.reason || "El guardado no tuvo una respuesta HTTP válida.", {
      status: "created-verification-incomplete", id, correlativeProposed, correlativeFinal,
      numberingContext: numberContext, verificationStage: persisted.stage,
    });
  }

  return { ok: true, stage: "verified", status: "verified", id, correlativeProposed,
    correlativeFinal, numberingContext: numberContext, reason: null };
}
