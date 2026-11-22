const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function findTag(source, tagName, attributeName, attributeValue) {
  const expression = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  return [...String(source).matchAll(expression)].map((match) => match[0]).find((tag) => {
    const attribute = readAttribute(tag, attributeName);
    return attribute.present && attribute.value === String(attributeValue);
  }) || "";
}

function readAttribute(tag, name) {
  const expression = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(?:(["'])([\\s\\S]*?)\\1|([^\\s>]+))`, "i");
  const match = String(tag).match(expression);
  return { present: !!match, value: match ? (match[2] ?? match[3] ?? "") : "" };
}

function readControl(html, name) {
  const source = String(html);
  const selectTag = findTag(source, "select", "name", name);
  if (selectTag) {
    const selectMatch = source.match(new RegExp(`(${selectTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?<\\/select>)`, "i"));
    const selectHtml = selectMatch?.[1] || "";
    const options = [...selectHtml.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)];
    const active = options.find((option) => /\bselected(?:\s|=|>)/i.test(option[0])) ||
      options.find((option) => !/\bdisabled(?:\s|=|>)/i.test(option[0]));
    if (!active) return { present: false, value: "", label: "" };
    const value = readAttribute(active[0].match(/<option\b[^>]*>/i)?.[0] || "", "value");
    const label = active[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
    return { present: value.present, value: value.value, label };
  }

  const inputTag = findTag(source, "input", "name", name);
  if (inputTag) {
    const value = readAttribute(inputTag, "value");
    return { present: value.present, value: value.value, label: value.value };
  }

  const textareaTag = findTag(source, "textarea", "name", name);
  if (textareaTag) {
    const textarea = source.match(new RegExp(`(${textareaTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?<\\/textarea>)`, "i"));
    const value = textarea?.[1]?.match(/^[^>]*>([\s\S]*?)<\/textarea>/i)?.[1]?.trim() || "";
    return { present: value !== "", value, label: value };
  }
  return { present: false, value: "", label: "" };
}

function firstControl(html, names) {
  for (const name of names) {
    const control = readControl(html, name);
    if (control.present) return control;
  }
  return { present: false, value: "", label: "" };
}

function parseCalls(source, functionName) {
  const text = String(source);
  const starts = [...text.matchAll(new RegExp(`\\b${escapeRegExp(functionName)}\\s*\\(`, "gi"))];
  return starts.map((start) => {
    const open = start.index + start[0].lastIndexOf("(");
    let depth = 1;
    let quote = "";
    let escaped = false;
    let close = open + 1;
    for (; close < text.length && depth > 0; close += 1) {
      const character = text[close];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
      } else if (character === "'" || character === '"' || character === "`") quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
    }
    return depth === 0 ? splitArguments(text.slice(open + 1, close - 1)) : [];
  }).filter((args) => args.length > 0);
}

function splitArguments(source) {
  const args = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
    } else if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      args.push(unquote(source.slice(start, index)));
      start = index + 1;
    }
  }
  args.push(unquote(source.slice(start)));
  return args;
}

function unquote(value) {
  const trimmed = String(value).trim();
  if (trimmed.length >= 2 && ["'", '"', "`"].includes(trimmed[0]) && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1).replace(/\\(['"`\\])/g, "$1");
  }
  return trimmed;
}

function normalizedText(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
}

function parseMoney(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function sameMoney(actualValue, expectedValue) {
  const actual = parseMoney(actualValue);
  const expected = parseMoney(expectedValue);
  return actual !== null && expected !== null && actual === expected;
}

export function parseFormDefaults(html) {
  const entity = firstControl(html, ["codEntidadComprobante", "cod_entidad"]);
  const office = firstControl(html, ["codUnidadComprobante", "cod_unidad"]);
  const area = firstControl(html, ["codAreaComprobante", "cod_area"]);
  const year = firstControl(html, ["global_gestion", "gestion"]);
  const month = firstControl(html, ["global_mes", "mes"]);
  const date = firstControl(html, ["fecha"]);
  const unitName = firstControl(html, ["unidad_organizacional"]);
  const glosa = findTag(html, "input", "name", "glosa");
  const maxLength = readAttribute(glosa, "maxlength");
  return {
    entity: entity.value,
    entityName: entity.label,
    office: office.value,
    officeName: office.label,
    area: area.value,
    areaName: area.label,
    year: year.value,
    month: month.value,
    date: date.value,
    unitName: unitName.value || office.label,
    glosaMaxLength: maxLength.present && /^\d+$/.test(maxLength.value) ? Number(maxLength.value) : 0,
    ok: entity.present && office.present && year.present && month.present && date.present,
  };
}

export function parseLineContext(html, index) {
  const unit = firstControl(html, [`unidad${index}`, `codUnidad${index}`, "codUnidadComprobante"]);
  const area = firstControl(html, [`area${index}`, `codArea${index}`, "codAreaComprobante"]);
  return { unit: unit.value, unitName: unit.label, area: area.value, areaName: area.label,
    ok: unit.present && area.present && /^\d+$/.test(unit.value) && /^\d+$/.test(area.value) };
}

export function validateNumberingContext(defaults, expected) {
  if (!defaults?.ok || !expected) return { ok: false, reason: "No se pudieron leer los controles activos del contexto." };
  const checks = [
    ["gestión", defaults.year, expected.managementYear],
    ["mes", defaults.month, expected.workMonth],
    ["entidad", defaults.entity, expected.entityCode],
    ["oficina", defaults.office, expected.officeCode],
  ];
  const areaIsExpected = expected.areaCode !== undefined && expected.areaCode !== null;
  if (areaIsExpected && !defaults.area) return { ok: false, reason: "No se pudo leer el área activa del contexto." };
  if (areaIsExpected) checks.push(["área", defaults.area, expected.areaCode]);
  const mismatch = checks.find(([, actual, configured]) => String(actual) !== String(configured));
  if (mismatch) return { ok: false, reason: `El valor activo de ${mismatch[0]} no coincide con la configuración.` };
  const namedChecks = [["entidad", defaults.entityName, expected.entityName], ["oficina", defaults.officeName, expected.officeName]]
    .filter(([, , configured]) => configured !== undefined && configured !== null);
  if (expected.areaName !== undefined && expected.areaName !== null) {
    if (!defaults.areaName) return { ok: false, reason: "No se pudo leer el nombre del área activa." };
    namedChecks.push(["área", defaults.areaName, expected.areaName]);
  }
  const nameMismatch = namedChecks.find(([, actual, configured]) => !normalizedText(actual).includes(normalizedText(configured)));
  return nameMismatch
    ? { ok: false, reason: `El nombre activo de ${nameMismatch[0]} no coincide con la configuración.` }
    : { ok: true };
}

export function resolveAccount(html, expected) {
  const expectedNumber = String(expected?.accountNumber ?? "");
  const expectedName = normalizedText(expected?.accountName ?? "");
  if (!expectedNumber || !expectedName) return null;

  for (const args of parseCalls(html, "setBusquedaCuenta")) {
    if (!args.some((argument) => argument === expectedNumber)) continue;
    const nameMatches = args.some((argument) => normalizedText(argument).includes(expectedName));
    if (!nameMatches) continue;
    const accountIds = args.filter((argument) => /^\d{3,}$/.test(argument) && argument !== expectedNumber);
    const id = accountIds[0];
    if (!id) continue;
    if (expected.accountId && id !== String(expected.accountId)) continue;
    return { id, accountNumber: expectedNumber, name: expected.accountName };
  }
  return null;
}

function readPersistedType(html) {
  const selected = readControl(html, "tipo_comprobante");
  if (selected.present && /^\d+$/.test(selected.value)) return selected.value;
  const byName = { "INGRESO": "1", "EGRESO": "2", "TRASPASO": "3", "INGRESO NR": "4" };
  return byName[normalizedText(selected.label)] || "";
}

function readExactAccountIds(html) {
  return parseCalls(html, "setBusquedaCuentaEdit").map((args) => args.filter((argument) => /^\d+$/.test(argument)));
}

export function parsePersistedVoucher(html, expected) {
  const source = String(html);
  const { data, glosa, date, accounts, proposedCorrelative } = expected || {};
  const type = readPersistedType(source);
  const storedDate = readControl(source, "fecha");
  const storedGlosa = readControl(source, "glosa");
  const finalCorrelative = readControl(source, "nro_correlativo");
  const totalDebit = readControl(source, "totaldeb");
  const totalCredit = readControl(source, "totalhab");
  const totalDifference = firstControl(source, ["total_dif", "totaldif"]);
  const rowCalls = readExactAccountIds(source);
  const lines = Array.isArray(data?.lines) ? data.lines : [];
  const rows = lines.map((line, index) => {
    const debit = readControl(source, `debe${index + 1}`);
    const credit = readControl(source, `haber${index + 1}`);
    const lineGlosa = readControl(source, `glosa_detalle${index + 1}`);
    const expectedId = String(accounts?.[index]?.id ?? "");
    const callbackTokens = rowCalls[index] || [];
    return {
      index: index + 1,
      accountId: expectedId,
      accountMatched: !!expectedId && callbackTokens.some((token) => token === expectedId),
      debit: debit.value,
      credit: credit.value,
      glosa: lineGlosa.value,
      valid: debit.present && credit.present && lineGlosa.present &&
        !!expectedId && callbackTokens.some((token) => token === expectedId) &&
        sameMoney(debit.value, line.debit) && sameMoney(credit.value, line.credit) && lineGlosa.value === glosa,
    };
  });
  const expectedDebit = lines.reduce((sum, line) => sum + line.debit, 0);
  const expectedCredit = lines.reduce((sum, line) => sum + line.credit, 0);
  const correlativeFinal = finalCorrelative.present && /^\d+$/.test(finalCorrelative.value) ? finalCorrelative.value : null;
  const expectedContext = {
    type: String(data?.type ?? ""),
    date: String(date ?? ""),
    glosa: String(glosa ?? ""),
  };
  const valid = !!data && lines.length > 0 && rowCalls.length === lines.length &&
    type === expectedContext.type && storedDate.present && storedDate.value === expectedContext.date &&
    storedGlosa.present && storedGlosa.value === expectedContext.glosa && correlativeFinal !== null &&
    totalDebit.present && totalCredit.present && sameMoney(totalDebit.value, expectedDebit) &&
    sameMoney(totalCredit.value, expectedCredit) &&
    (!totalDifference.present || sameMoney(totalDifference.value, 0)) && rows.every((row) => row.valid);
  return {
    ok: valid,
    valid,
    type,
    date: storedDate.present ? storedDate.value : null,
    glosa: storedGlosa.present ? storedGlosa.value : null,
    correlativeProposed: proposedCorrelative == null ? null : String(proposedCorrelative),
    correlativeFinal,
    totalDebit: totalDebit.present ? totalDebit.value : null,
    totalCredit: totalCredit.present ? totalCredit.value : null,
    rows,
    reason: valid ? null : "La persistencia no coincide o faltan campos requeridos.",
  };
}
