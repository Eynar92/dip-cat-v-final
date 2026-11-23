import http from "k6/http";
import { check } from "k6";
import { SharedArray } from "k6/data";
import { loadConfig } from "../src/config.js";
import { authenticate, getContext } from "../src/workflow.js";
import { getRequest } from "../src/http-client.js";
import { parseLineContext, resolveAccount, validateLineContext } from "../src/voucher-parse.js";
import { verifyPersistedVoucher } from "../src/voucher-requests.js";
import { recordOperation } from "../src/metrics.js";
import { writeSessionSummary } from "./session-summary.js";

const cfg = loadConfig();
const events = JSON.parse(open(__ENV.EXPERIMENT_VERIFY_INPUT));
const templates = new SharedArray("plantillas para verificación posterior", () => JSON.parse(open("../data/vouchers.json")));
const context = { http, cfg, check, recordOperation };

export const options = { vus: 1, iterations: 1, noCookiesReset: true };

export function handleSummary(data) {
  return writeSessionSummary(data);
}

function readExpectedAccounts(session, data, numberingContext) {
  const accounts = [];
  for (let index = 0; index < data.lines.length; index += 1) {
    const row = index + 1;
    const lineResponse = getRequest({ ...context, session,
      path: `comprobantes/ajaxCuentaContable.php?idFila=${row}&codEntidadComprobante=${encodeURIComponent(numberingContext.entityCode)}&glosa=post-run-verification`,
      operation: "post_verify_detail_form", type: data.type });
    if (lineResponse.status !== 200) return { ok: false, reason: `No se pudo leer el contexto de la línea ${row}.` };
    const lineContext = parseLineContext(lineResponse.body, row);
    if (!validateLineContext(lineContext, cfg.expectedContext).ok) {
      return { ok: false, reason: `El contexto activo de la línea ${row} no coincide.` };
    }

    const line = data.lines[index];
    const accountResponse = getRequest({ ...context, session,
      path: `comprobantes/ajaxBusquedaCuenta.php?nro_cuenta=${encodeURIComponent(line.accountNumber)}&cuenta=&padre=&auxiliar=`,
      operation: "post_verify_account_search", type: data.type });
    const account = resolveAccount(accountResponse.body, line);
    if (accountResponse.status !== 200 || !account) {
      return { ok: false, reason: `No se encontró la cuenta esperada de la línea ${row}.` };
    }
    accounts.push({ ...account, unit: lineContext.unit, area: lineContext.area });
  }
  return { ok: true, accounts };
}

export default function verifyRecords() {
  const session = { jar: http.cookieJar(), authenticated: false };
  const login = authenticate(context, session);
  console.log(`POST_VERIFY_AUTH ${JSON.stringify({ authenticated: login.ok, authenticationCount: 1 })}`);
  if (!login.ok) {
    events.forEach((event) => console.log(`POST_VERIFY ${JSON.stringify({
      sourceRunId: event.runId, condition: event.condition, id: event.id, type: event.type,
      vu: event.vu, iteration: event.iteration, ok: false, stage: "authentication",
      reason: "Falló la autenticación de solo lectura posterior.",
    })}`));
    return;
  }

  const actualContext = getContext(context, session);
  if (!actualContext.ok) {
    events.forEach((event) => console.log(`POST_VERIFY ${JSON.stringify({
      sourceRunId: event.runId, condition: event.condition, id: event.id, type: event.type,
      vu: event.vu, iteration: event.iteration, ok: false, stage: actualContext.stage,
      reason: "No se pudo confirmar el contexto para la consulta posterior.",
    })}`));
    return;
  }

  for (const event of events) {
    const data = templates.find((voucher) => voucher.type === event.type);
    if (!event.id || !data || !event.date) {
      console.log(`POST_VERIFY ${JSON.stringify({
        sourceRunId: event.runId, condition: event.condition, id: event.id, type: event.type,
        vu: event.vu, iteration: event.iteration, ok: false, stage: "input-validation",
        reason: "El manifiesto no contiene los datos necesarios para la consulta posterior.",
      })}`);
      continue;
    }

    const accountResult = readExpectedAccounts(session, data, event.numberingContext);
    if (!accountResult.ok) {
      console.log(`POST_VERIFY ${JSON.stringify({
        sourceRunId: event.runId, condition: event.condition, id: event.id, type: event.type,
        vu: event.vu, iteration: event.iteration, ok: false, stage: "account-resolution",
        reason: accountResult.reason,
      })}`);
      continue;
    }

    let parsed = null;
    let pdf = null;
    const result = verifyPersistedVoucher({
      http, check, cfg, session, data, id: String(event.id), glosa: event.glosa,
      date: event.date, accounts: accountResult.accounts,
      proposedCorrelative: event.correlativeProposed,
      expectedCorrelativeFinal: event.expectedCorrelativeFinal,
      recordOperation,
      onParsed: (value) => { parsed = value; },
      onPdf: (value) => { pdf = value; },
    });
    console.log(`POST_VERIFY ${JSON.stringify({
      sourceRunId: event.runId,
      condition: event.condition,
      id: String(event.id),
      type: event.type,
      vu: event.vu,
      iteration: event.iteration,
      status: result.ok ? "verified-after-run" : "verification-failed",
      ok: result.ok,
      stage: result.stage,
      parsed: parsed ? {
        type: parsed.type,
        date: parsed.date,
        glosa: parsed.glosa,
        correlativeFinal: parsed.correlativeFinal,
        correlativeFinalExpected: parsed.correlativeFinalExpected,
        totalDebit: parsed.totalDebit,
        totalCredit: parsed.totalCredit,
        rows: parsed.rows.map((row) => ({
          index: row.index,
          accountId: row.accountId,
          accountNumber: row.accountNumber,
          accountName: row.accountName,
          accountMatched: row.accountMatched,
          debit: row.debit,
          credit: row.credit,
          glosa: row.glosa,
          valid: row.valid,
        })),
        issues: parsed.issues,
      } : null,
      pdf,
      correlativeFinal: parsed?.correlativeFinal || null,
      issues: parsed?.issues || [],
      reason: result.reason || null,
    })}`);
  }
}
