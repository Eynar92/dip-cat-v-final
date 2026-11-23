import { authenticate } from "./workflow.js";
import { captureResponseCookies, exportActiveCookies, findSessionIdentity, hasCookie, installCookies } from "./session-cookies.js";

const VALID_POLICIES = ["per-iteration", "per-vu", "shared"];
const sessionsByVu = new Map();
const SAFE_SESSION_ERROR = "No se pudo preparar o instalar la sesión.";

function failedSession(stage = "session") {
  return { ok: false, session: null, stage, reason: SAFE_SESSION_ERROR };
}

function createSession(http, baseUrl, policy) {
  const jar = http.cookieJar();
  jar.clear(baseUrl);
  return { jar, policy, invalidated: false };
}

function authContext(ctx, session, cookieStore = null) {
  return {
    ...ctx,
    session,
    onAuthResponse: cookieStore
      ? (response, requestUrl) => captureResponseCookies(cookieStore, response, requestUrl)
      : undefined,
  };
}

function login(ctx, session, cookieStore = null) {
  const result = authenticate(authContext(ctx, session, cookieStore), session);
  if (!result.ok) return { ok: false, session: null, stage: result.stage, reason: result.reason };
  session.invalidated = false;
  session.authenticated = true;
  if (cookieStore) {
    try {
      session.identity = findSessionIdentity(exportActiveCookies(session.jar, ctx.cfg.baseUrl, cookieStore));
    } catch {
      return { ok: false, session: null, stage: "session-identity", reason: SAFE_SESSION_ERROR };
    }
  }
  return { ok: true, session, stage: null, reason: null };
}

export function validateSessionPolicy(policy) {
  if (!VALID_POLICIES.includes(policy)) {
    throw new Error(`sessionPolicy debe ser una de estas opciones: ${VALID_POLICIES.join(", ")}.`);
  }
  return policy;
}

export function prepareSession(ctx) {
  const policy = validateSessionPolicy(ctx.cfg.sessionPolicy);
  if (policy !== "shared") return null;

  try {
    const session = { jar: new ctx.http.CookieJar(), policy, invalidated: false };
    session.jar.clear(ctx.cfg.baseUrl);
    const cookieStore = new Map();
    const authenticated = login(ctx, session, cookieStore);
    if (!authenticated.ok) {
      return { ok: false, stage: authenticated.stage, reason: authenticated.reason };
    }
    const cookies = exportActiveCookies(session.jar, ctx.cfg.baseUrl, cookieStore);
    return { ok: true, cookies, identity: session.identity };
  } catch {
    return { ok: false, stage: "session-preparation", reason: SAFE_SESSION_ERROR };
  }
}

function sharedSession(ctx, setupData, vu) {
  if (!setupData?.ok) {
    return { ok: false, session: null, stage: setupData?.stage || "authentication", reason: setupData?.reason || "La sesión compartida no quedó preparada." };
  }
  const key = String(vu);
  const cached = sessionsByVu.get(key);
  if (cached) {
    if (cached.invalidated) {
      return { ok: false, session: null, stage: "session-expired", reason: "La sesión compartida dejó de estar autenticada." };
    }
    return { ok: true, session: cached, stage: null, reason: null };
  }

  const session = createSession(ctx.http, ctx.cfg.baseUrl, "shared");
  installCookies(session.jar, ctx.cfg.baseUrl, setupData.cookies);
  const identityCookie = setupData.identity;
  if (!identityCookie || !hasCookie(session.jar, ctx.cfg.baseUrl, identityCookie)) {
    return { ok: false, session: null, stage: "session-transfer", reason: "No se pudo instalar la identidad de sesión preparada." };
  }
  session.identity = identityCookie;
  session.authenticated = true;
  sessionsByVu.set(key, session);
  return { ok: true, session, stage: null, reason: null };
}

export function acquireSession(ctx, setupData = null) {
  const policy = validateSessionPolicy(ctx.cfg.sessionPolicy);
  if (policy === "shared") {
    try { return sharedSession(ctx, setupData, ctx.vu); }
    catch { return failedSession("session"); }
  }

  if (policy === "per-iteration") {
    try {
      const session = createSession(ctx.http, ctx.cfg.baseUrl, policy);
      return login(ctx, session, new Map());
    } catch {
      return failedSession("authentication");
    }
  }

  try {
    const key = String(ctx.vu);
    let session = sessionsByVu.get(key);
    if (session?.invalidated) {
      sessionsByVu.delete(key);
      session = null;
    }
    if (session) return { ok: true, session, stage: null, reason: null };

    session = createSession(ctx.http, ctx.cfg.baseUrl, policy);
    const result = login(ctx, session, new Map());
    if (result.ok) sessionsByVu.set(key, session);
    return result;
  } catch {
    return failedSession("authentication");
  }
}

export function invalidateSession(vu, currentSession = null) {
  const key = String(vu);
  const session = currentSession || sessionsByVu.get(key);
  if (!session) return;
  session.invalidated = true;
  if (session.policy === "per-vu") sessionsByVu.delete(key);
}

export function sessionIdentityInstalled(session, baseUrl) {
  return !!session?.identity && hasCookie(session.jar, baseUrl, session.identity);
}

export function sessionIdentityChanged(session, baseUrl) {
  return !!session?.identity && !sessionIdentityInstalled(session, baseUrl);
}
