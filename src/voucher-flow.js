import { authenticate, getContext } from "./workflow.js";
import { requestVoucher } from "./voucher-requests.js";

export function createVoucher(ctx) {
  const { http, check, cfg, data, glosa, vu, iteration, scenario, recordOperation } = ctx;
  const cookieJar = http.cookieJar();
  cookieJar.clear(cfg.baseUrl);
  const session = { jar: cookieJar };
  if (!authenticate(ctx, session)) return { ok: false };
  const context = getContext(ctx, session);
  if (!context.ok) return { ok: false };

  const correlation = requestVoucher(ctx, session, context, glosa);
  const entry = { runId: cfg.runId, scenario, vu, iteration, type: data.type, glosa, id: correlation.id,
    correlative: correlation.correlative, createdAt: new Date().toISOString(), verified: correlation.verified || false,
    status: correlation.ok ? "verified" : correlation.id ? "created-verification-incomplete" : "no-id-returned" };
  console.log(`MANIFEST ${JSON.stringify(entry)}`);
  return { ok: correlation.verified };
}
