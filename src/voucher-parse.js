function input(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`<input\\b(?=[^>]*\\bname=["']${escaped}["'])[^>]*>`, "i");
  const tag = String(html).match(expression)?.[0] || "";
  return tag.match(/\bvalue=["']([^"']*)/i)?.[1] || "";
}

function inputValue(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = String(html).match(new RegExp(`<input\\b(?=[^>]*\\bname=["']${escaped}["'])[^>]*>`, "i"))?.[0] || "";
  const value = tag.match(/\bvalue=["']([^"']*)/i)?.[1];
  if (value !== undefined) return value;
  const textarea = String(html).match(new RegExp(`<textarea\\b(?=[^>]*\\bname=["']${escaped}["'])[^>]*>([\\s\\S]*?)</textarea>`, "i"));
  return textarea?.[1]?.trim() || "";
}

export function parseFormDefaults(html) {
  const get = (...names) => names.map((name) => input(html, name)).find(Boolean) || "";
  const result = { entity: get("codEntidadComprobante", "cod_entidad"), office: get("codUnidadComprobante", "cod_unidad"),
    year: get("global_gestion", "gestion"), month: get("global_mes", "mes"), date: get("fecha"),
    unitName: get("unidad_organizacional"), glosaMaxLength: Number(String(html).match(/<input\b(?=[^>]*\bname=["']glosa["'])(?=[^>]*\bmaxlength=["']?(\d+))[^>]*>/i)?.[1] || 0) };
  return { ...result, ok: !!(result.year && result.month && result.date) };
}

export function resolveAccount(html, expected) {
  const source = String(html);
  const calls = [...source.matchAll(/setBusquedaCuenta\(([^)]*)\)/gi)];
  for (const call of calls) {
    const args = [...call[1].matchAll(/(['"])(.*?)\1/g)].map((value) => value[2]);
    if (!args.includes(expected.accountNumber) && !call[1].includes(expected.accountNumber)) continue;
    const values = args;
    const id = values.find((v) => /^\d{3,}$/.test(v) && v !== expected.accountNumber);
    const name = values.find((v) => /[A-ZÁÉÍÓÚÑ]/i.test(v) && !/^\d+$/.test(v));
    if (!id || (name && !name.trim().toUpperCase().includes(expected.accountName.toUpperCase()))) continue;
    return { id, name: expected.accountName, unit: "1", area: "1" };
  }
  const idMatch = source.match(new RegExp(`(?:idCuenta|codCuenta|codigoCuenta)["'=,: ]{1,8}(\\d+)[^\\n]{0,160}${expected.accountNumber}`));
  if (idMatch) return { id: idMatch[1], name: expected.accountName, unit: "1", area: "1" };
  return null;
}

export function verifyPersistedVoucher({ http, check, cfg, session, data, id, glosa, date, accounts, recordOperation }) {
  const options = { jar: session.jar, tags: { operation: "persistence", voucher_type: String(data.type) } };
  let response = http.get(`${cfg.baseUrl}/comprobantes/editar.php?codigo=${id}`, { ...options, redirects: 0 });
  check(response, { "edición devuelve la consulta de detalle": (r) => r.status === 200 && String(r.body).includes("edit_prueba.php") });
  const detailUrl = `${cfg.baseUrl}/comprobantes/edit_prueba.php?codigo=${id}`;
  recordOperation(response, "persistence_redirect", data.type);
  // k6 no ejecuta el cambio de página del HTML; consulta el detalle de forma explícita.
  response = http.get(detailUrl, options);
  recordOperation(response, "persistence_detail", data.type);
  const html = String(response.body);
  const rowCalls = [...html.matchAll(/setBusquedaCuentaEdit\(([^)]*)\)/gi)].map((match) => match[1]);
  const selector = html.match(/<select\b[^>]*\bname=["']tipo_comprobante["'][^>]*>([\s\S]*?)<\/select>/i)?.[1] || "";
  const typeName = [...selector.matchAll(/<option\b[^>]*>([^<]+)<\/option>/gi)].map((match) => match[1].trim()).filter(Boolean).pop();
  const typeFromName = { "Ingreso": 1, "Egreso": 2, "Traspaso": 3, "Ingreso NR": 4 }[typeName];
  const typeStored = inputValue(html, "tipo_comprobante") || typeFromName;
  const dateStored = inputValue(html, "fecha");
  const exactRows = data.lines.every((line, index) => rowCalls[index]?.includes(accounts[index].id) &&
    Number(inputValue(html, `debe${index + 1}`)) === line.debit && Number(inputValue(html, `haber${index + 1}`)) === line.credit &&
    inputValue(html, `glosa_detalle${index + 1}`) === glosa);
  const totalDebit = data.lines.reduce((sum, line) => sum + line.debit, 0);
  const totalCredit = data.lines.reduce((sum, line) => sum + line.credit, 0);
  const verified = response.status === 200 && String(typeStored) === String(data.type) && dateStored === date && html.includes(glosa) && exactRows &&
    Number(inputValue(html, "totaldeb")) === totalDebit && Number(inputValue(html, "totalhab")) === totalCredit;
  check({ ok: verified, status: response.status }, { "persistencia coincide con el comprobante": (r) => r.ok });
  const print = http.get(`${cfg.baseUrl}/comprobantes/imp.php?comp=${id}&mon=1`, options);
  recordOperation(print, "pdf", data.type);
  const pdfOk = print.status === 200 && String(print.headers["Content-Type"] || "").toLowerCase().includes("application/pdf") &&
    String(print.body).startsWith("%PDF");
  check({ ok: pdfOk, status: print.status }, { "PDF descargado con firma válida": (r) => r.ok });
  return { ok: verified && pdfOk, verified: verified && pdfOk };
}
