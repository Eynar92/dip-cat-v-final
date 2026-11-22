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
  return { ok: correlation.verified };
}
