import { resolveAccount, parseFormDefaults, verifyPersistedVoucher } from "./voucher-parse.js";
import { recordOperation as measure } from "./metrics.js";

const path = (name) => `comprobantes/${name}`;

function get(http, cfg, session, url, operation, type, extras = {}) {
  const response = http.get(url, { jar: session.jar, tags: { operation, voucher_type: String(type) }, ...extras });
  measure(response, operation, type);
  return response;
}

export function requestVoucher(ctx, session, context, glosa) {
  const { http, check: verify, cfg, data, vu, iteration, scenario, recordOperation } = ctx;
  const type = data.type;
  const form = context.html;
  const defaults = parseFormDefaults(form);
  if (!defaults.ok || (defaults.glosaMaxLength && glosa.length > defaults.glosaMaxLength)) return { ok: false };
  const query = `tipo_comprobante=${type}&codEntidadComprobante=${cfg.expectedContext.entityCode}&codUnidadComprobante=${cfg.expectedContext.officeCode}`;
  let response = get(http, cfg, session, `${cfg.baseUrl}/${path(`ajaxCorrelativo.php?${query}`)}`, "correlative", type);
  if (!verify(response, { "correlativo disponible": (r) => r.status === 200 })) return { ok: false };
  const correlative = response.body.match(/name=["']nro_correlativo["'][^>]*value=["']([^"']+)/i)?.[1] || response.body.match(/value=["']([^"']+)["'][^>]*name=["']nro_correlativo/i)?.[1];
  if (!/^\d+$/.test(correlative || "")) return { ok: false };
  response = get(http, cfg, session, `${cfg.baseUrl}/${path(`ajax_fecha_comprobante.php?${query}&fecha=${encodeURIComponent(defaults.date)}&codigo=0`)}`, "date", type);
  const date = response.body.match(/name=["']fecha["'][^>]*value=["']([^"']+)/i)?.[1] || response.body.match(/value=["']([^"']+)["'][^>]*name=["']fecha/i)?.[1];
  const proposedDate = new Date(`${date}T00:00:00Z`);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date || "") && !Number.isNaN(proposedDate.getTime()) &&
    proposedDate.getUTCFullYear() === cfg.expectedContext.managementYear && proposedDate.getUTCMonth() + 1 === cfg.expectedContext.workMonth;
  if (!verify(response, { "fecha permitida para el contexto": (r) => r.status === 200 && validDate })) return { ok: false };

  const accounts = [];
  for (let index = 0; index < data.lines.length; index += 1) {
  response = get(http, cfg, session, `${cfg.baseUrl}/${path(`ajaxCuentaContable.php?idFila=${index + 1}&codEntidadComprobante=${cfg.expectedContext.entityCode}&glosa=${encodeURIComponent(glosa)}`)}`, "detail_form", type);
    if (!verify(response, { [`formulario de detalle ${index + 1}`]: (r) => r.status === 200 })) return { ok: false };
    const accountResponse = get(http, cfg, session, `${cfg.baseUrl}/${path(`ajaxBusquedaCuenta.php?nro_cuenta=${data.lines[index].accountNumber}&cuenta=&padre=&auxiliar=`)}`, "account_search", type);
    const account = resolveAccount(accountResponse.body, data.lines[index]);
    if (!verify(accountResponse, { [`cuenta correcta ${index + 1}`]: (r) => r.status === 200 && !!account })) return { ok: false };
    accounts.push(account);
  }
  const payload = buildPayload(defaults, data, accounts, glosa, correlative, date);
  const boundary = `----k6-${glosa.replace(/[^A-Za-z0-9]/g, "")}`;
  const body = Object.entries(payload).map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join("") + `--${boundary}--\r\n`;
  response = http.post(`${cfg.baseUrl}/${path("save.php")}`, body, { jar: session.jar, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, tags: { operation: "save", voucher_type: String(type) } });
  recordOperation(response, "save", type);
  const id = response.body.match(/imp\.php\?comp=(\d+)&mon=(\d+)/i)?.[1];
  if (!verify(response, { "guardado devuelve identificador": (r) => r.status === 200 && !!id })) {
    console.log(`MANIFEST ${JSON.stringify({ runId: cfg.runId, scenario, vu, iteration, type, glosa, id: id || null, correlative, verified: false, status: "save-ambiguous" })}`);
    return { ok: false, id, correlative, verified: false };
  }

  let result;
  try {
    result = verifyPersistedVoucher({ http, check: verify, cfg, session, data, id, glosa, date, accounts, recordOperation });
  } catch (_) {
    result = { ok: false, verified: false };
  }
  const manifest = { runId: cfg.runId, scenario, vu, iteration, type, glosa, id, correlative, verified: !!result.verified,
    status: result.verified ? "verified" : "created-verification-incomplete" };
  console.log(`MANIFEST ${JSON.stringify(manifest)}`);
  return { ok: result.ok, id, correlative, verified: result.verified };
}

function buildPayload(d, data, accounts, glosa, correlative, date) {
  const debit = data.lines.reduce((sum, line) => sum + line.debit, 0).toFixed(2);
  const credit = data.lines.reduce((sum, line) => sum + line.credit, 0).toFixed(2);
  if (debit !== credit) throw new Error("El fixture debe estar balanceado antes del guardado.");
  const p = { validacion_libretas: 1, cantidad_filas: data.lines.length, codigo_comprobante: 0,
    codigo_iva_direfido: 0, cod_cuenta_configuracion_iva: "9473,1473,13041", cod_sis_configuracion: 0,
    global_gestion: d.year, global_mes: d.month, gestion: d.year, unidad_organizacional: d.unitName || "ADM CETOF - ADM CETOF",
    tipo_comprobante: data.type, nro_correlativo: correlative,
    fecha: date, pagado_a: "", glosa, validar_factura: "on", totaldeb: debit, totalhab: credit, total_dif: "0.00",
    tipo_documento_otro: -100, cantidad_archivosadjuntos: 0, facturas: "[[],[]]", estados_cuentas: "[[],[]]" };
  data.lines.forEach((line, i) => {
    const n = i + 1;
    Object.assign(p, { [`unidad${n}`]: accounts[i].unit, [`area${n}`]: accounts[i].area, [`cuenta${n}`]: accounts[i].id,
      [`cuenta_auxiliar${n}`]: "0", [`cod_detallelibreta${n}`]: "0", [`cod_detallesolicitudsis${n}`]: "0",
      [`cod_actividadproyecto${n}`]: "0", [`cod_accnum${n}`]: "0", [`debe${n}`]: line.debit, [`haber${n}`]: line.credit,
      [`cod_tipo_cheque${n}`]: "", [`nro_cheque${n}`]: "", [`glosa_detalle${n}`]: glosa });
  });
  return p;
}
