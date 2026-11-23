import { recordFlowDuration } from "./metrics.js";
import { getContext } from "./workflow.js";
import { requestVoucher } from "./voucher-requests.js";

function secretSafeMessage(error, cfg) {
  const safePart = (value) => {
    let message = String(value?.message || value || "Error inesperado en el flujo.");
    for (const secret of [cfg.user, cfg.password]) {
      if (secret) message = message.split(String(secret)).join("[redactado]");
    }
    return message.replace(/https?:\/\/[^\s]+/gi, "[URL de solicitud]").replace(/[\r\n]+/g, " ").slice(0, 300);
  };
  const details = { name: String(error?.name || "Error").slice(0, 80), message: safePart(error) };
  let cause = error?.cause;
  let depth = 0;
  while (cause && depth < 2) {
    if (!details.cause) details.cause = [];
    details.cause.push({ name: String(cause?.name || "Error").slice(0, 80), message: safePart(cause) });
    cause = cause?.cause;
    depth += 1;
  }
  return details;
}

function attemptEvent(ctx) {
  const cfg = ctx.cfg;
  const metadata = {
    runId: ctx.runId || cfg.runId,
    test: ctx.test || ctx.testName || cfg.testName,
    mode: ctx.mode || cfg.mode,
    scenario: ctx.scenario || cfg.testConfig?.scenarioCode,
    type: ctx.type ?? ctx.data?.type,
    vu: ctx.vu,
    iteration: ctx.iteration,
    glosa: ctx.glosa,
  };
  const event = {
    id: null,
    correlativeProposed: null,
    correlativeFinal: null,
    numberingContext: null,
    status: "failed-before-save",
    stage: "session",
    error: null,
  };
  Object.entries(metadata).forEach(([key, value]) => {
    if (value !== undefined && value !== null) event[key] = value;
  });
  return event;
}

function resultEvent(event, outcome) {
  if (outcome.id !== undefined) event.id = outcome.id;
  if (outcome.correlativeProposed !== undefined) event.correlativeProposed = outcome.correlativeProposed;
  if (outcome.correlativeFinal !== undefined) event.correlativeFinal = outcome.correlativeFinal;
  if (outcome.numberingContext !== undefined) event.numberingContext = outcome.numberingContext;
  if (outcome.status) event.status = outcome.status;
  if (outcome.stage) event.stage = outcome.stage;
  if (outcome.reason) event.error = { name: "FlowError", message: outcome.reason };
  return event;
}

export function createVoucher(ctx) {
  const startedAt = Date.now();
  const event = attemptEvent(ctx);
  let outcome = { ok: false };
  try {
    const session = ctx.session;
    if (!session?.authenticated || session.invalidated) {
      outcome = { ok: false, stage: "session", reason: "El flujo necesita una sesión autenticada." };
      return { ok: false, event: resultEvent(event, outcome) };
    }
    const flowContext = {
      ...ctx,
      onSessionInvalidResponse: (response) => {
        session.invalidated = true;
        ctx.onSessionInvalidResponse?.(response, session);
      },
    };

    event.stage = "context-validation";
    const context = getContext(flowContext, session);
    if (!context.ok) {
      if (session.invalidated) event.sessionInvalidated = true;
      outcome = { ok: false, stage: context.stage, reason: context.reason,
        numberingContext: context.numberingContext || null };
      return { ok: false, event: resultEvent(event, outcome) };
    }
    event.numberingContext = context.numberingContext;

    outcome = requestVoucher(flowContext, session, context, event);
    if (session.invalidated) event.sessionInvalidated = true;
    resultEvent(event, outcome);
    if (!outcome.ok && !outcome.status) {
      event.status = event.id ? "created-verification-incomplete" : "failed-before-save";
    }
    return { ok: outcome.ok, event };
  } catch (error) {
    const isSaveStage = event.stage === "save";
    event.status = event.id ? "created-verification-incomplete" : (isSaveStage ? "save-ambiguous" : "failed-before-save");
    event.error = secretSafeMessage(error, ctx.cfg);
    if (isSaveStage) event.stage = "save-ambiguous";
    return { ok: false, event };
  } finally {
    recordFlowDuration(Date.now() - startedAt, event.type);
  }
}
