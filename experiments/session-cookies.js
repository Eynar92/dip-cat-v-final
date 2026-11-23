const KNOWN_SESSION_COOKIE_NAMES = new Set([
  "phpsessid",
  "jsessionid",
  "asp.net_sessionid",
]);

function cookieKey(cookie) {
  return `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}\u0000${cookie.host_only ? "host" : "domain"}`;
}

function cookieScopeUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, "")}/`;
}

function parseRequestUrl(requestUrl) {
  const match = String(requestUrl || "").match(/^https?:\/\/(\[[^\]]+\]|[^/:?#]+)(?::\d+)?(\/[^?#]*)?/i);
  if (!match) return null;
  const path = match[2] || "/";
  return {
    hostname: match[1].replace(/^\[|\]$/g, ""),
    pathname: path,
  };
}

function safeCookie(cookie, fallbackName, fallbackUrl) {
  const name = String(cookie?.name || fallbackName || "");
  const value = String(cookie?.value ?? "");
  let fallbackDomain = "";
  let fallbackPath = "";
  try {
    const url = new URL(fallbackUrl);
    fallbackDomain = url.hostname;
    fallbackPath = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) || "/";
  } catch {}
  const domain = String(cookie?.domain || fallbackDomain);
  const path = String(cookie?.path || fallbackPath);
  if (!name || !domain || !path || !value) return null;

  const result = {
    name,
    value,
    domain,
    path,
    host_only: !!cookie.host_only,
    secure: !!cookie.secure,
    http_only: !!(cookie.http_only ?? cookie.httpOnly),
  };
  const maxAge = cookie.max_age ?? cookie.maxAge;
  if (Number.isFinite(maxAge)) result.max_age = maxAge;
  if (cookie.expires) result.expires = String(cookie.expires);
  return result;
}

function headerValues(headers, name) {
  const values = [];
  for (const [headerName, rawValue] of Object.entries(headers || {})) {
    if (headerName.toLowerCase() !== name.toLowerCase()) continue;
    if (Array.isArray(rawValue)) values.push(...rawValue.map(String));
    else values.push(String(rawValue));
  }
  return values;
}

function parseSetCookie(rawValue, requestUrl) {
  const [pair, ...attributes] = String(rawValue).split(";");
  const separator = pair.indexOf("=");
  if (separator < 1) return null;
  const url = parseRequestUrl(requestUrl);
  if (!url) return null;
  const cookie = {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
    domain: url.hostname,
    path: url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) || "/",
    host_only: true,
    secure: false,
    http_only: false,
  };
  for (const rawAttribute of attributes) {
    const [rawName, ...rawParts] = rawAttribute.trim().split("=");
    const name = rawName.toLowerCase();
    const value = rawParts.join("=").trim();
    if (name === "domain" && value) {
      cookie.domain = value.replace(/^\./, "");
      cookie.host_only = false;
    }
    else if (name === "path" && value) cookie.path = value;
    else if (name === "secure") cookie.secure = true;
    else if (name === "httponly") cookie.http_only = true;
    else if (name === "max-age" && /^-?\d+$/.test(value)) cookie.max_age = Number(value);
    else if (name === "expires" && value) cookie.expires = value;
  }
  return cookie.name && cookie.value && cookie.domain && cookie.path ? cookie : null;
}

function splitSetCookieValues(value) {
  return String(value).split(/,\s*(?=[^,;=\s]+\s*=)/);
}

export function captureResponseCookies(cookieStore, response, requestUrl = response?.url) {
  const setCookieHeaders = headerValues(response?.headers, "set-cookie");
  let capturedCount = 0;
  if (setCookieHeaders.length) {
    for (const value of setCookieHeaders.flatMap(splitSetCookieValues)) {
      const cookie = parseSetCookie(value, requestUrl);
      if (cookie) {
        cookieStore.set(cookieKey(cookie), cookie);
        capturedCount += 1;
      }
    }
    return capturedCount;
  }

  for (const [name, values] of Object.entries(response?.cookies || {})) {
    for (const rawCookie of values || []) {
      const cookie = safeCookie(rawCookie, name, requestUrl);
      if (cookie) {
        cookieStore.set(cookieKey(cookie), cookie);
        capturedCount += 1;
      }
    }
  }
  return capturedCount;
}

export function exportActiveCookies(jar, baseUrl, cookieStore) {
  const active = jar.cookiesForURL(cookieScopeUrl(baseUrl)) || {};
  const result = [];
  for (const [name, values] of Object.entries(active)) {
    for (const value of values || []) {
      const matches = [...cookieStore.values()].filter((cookie) => cookie.name === name && cookie.value === value);
      if (!matches.length) {
        const capturedNames = [...new Set([...cookieStore.values()].map((cookie) => cookie.name))];
        throw new Error(`No hay metadatos para la cookie activa ${name}; cookies capturadas: ${capturedNames.join(", ") || "ninguna"}.`);
      }
      result.push(...matches);
    }
  }
  if (!result.length) throw new Error("La autenticación no dejó cookies aplicables a la URL del ambiente.");
  const unique = new Map(result.map((cookie) => [cookieKey(cookie), cookie]));
  return [...unique.values()];
}

export function findSessionIdentity(cookies) {
  const candidates = cookies.filter((cookie) => {
    const normalizedName = cookie.name.toLowerCase();
    return KNOWN_SESSION_COOKIE_NAMES.has(normalizedName) || /session|sessid|sessionid|^sid$/i.test(cookie.name);
  });
  const preferred = candidates.filter((cookie) => KNOWN_SESSION_COOKIE_NAMES.has(cookie.name.toLowerCase()));
  const selected = preferred.length ? preferred : candidates;
  const identities = new Map(selected.map((cookie) => [cookieKey(cookie), cookie]));
  if (identities.size !== 1) {
    throw new Error("No se pudo identificar una única cookie de sesión del servidor con certeza.");
  }
  return identities.values().next().value;
}

export function sameSessionIdentity(first, second) {
  return !!first && !!second && cookieKey(first) === cookieKey(second) && first.value === second.value;
}

export function installCookies(jar, baseUrl, cookies) {
  for (const cookie of cookies) {
    const attributes = {
      path: cookie.path,
      secure: !!cookie.secure,
      http_only: !!cookie.http_only,
    };
    if (!cookie.host_only) attributes.domain = cookie.domain;
    if (Number.isFinite(cookie.max_age)) attributes.max_age = cookie.max_age;
    if (cookie.expires) attributes.expires = cookie.expires;
    jar.set(baseUrl, cookie.name, cookie.value, attributes);
  }
}

export function jarHasIdentity(jar, baseUrl, expectedIdentity) {
  const values = jar.cookiesForURL(cookieScopeUrl(baseUrl))?.[expectedIdentity.name] || [];
  return values.includes(expectedIdentity.value);
}

export function prepareSessionPlan(condition, { login, verify }) {
  if (![
    "shared",
    "independent",
  ].includes(condition)) throw new Error("La condición debe ser shared o independent.");

  const authenticationCount = condition === "shared" ? 1 : 2;
  const authenticatedSessions = Array.from({ length: authenticationCount }, (_, index) => login(index + 1));
  const sameServerSession = condition === "shared"
    ? sameSessionIdentity(authenticatedSessions[0].identity, authenticatedSessions[0].identity)
    : sameSessionIdentity(authenticatedSessions[0].identity, authenticatedSessions[1].identity);

  if (condition === "independent" && sameServerSession) {
    throw new Error("Los dos logins no produjeron identidades de sesión distintas; no se crean registros.");
  }

  const vuSessions = condition === "shared"
    ? [authenticatedSessions[0], authenticatedSessions[0]]
    : authenticatedSessions;
  const authenticated = vuSessions.every((session, index) => verify(session, index + 1));
  if (!authenticated) throw new Error("El preflight no confirmó todas las sesiones; no se crean registros.");

  const finalSameServerSession = sameSessionIdentity(vuSessions[0].identity, vuSessions[1].identity);
  if (condition === "shared" && !finalSameServerSession) {
    throw new Error("La identidad de sesión compartida cambió durante el preflight; no se crean registros.");
  }
  if (condition === "independent" && finalSameServerSession) {
    throw new Error("Las sesiones independientes convergieron durante el preflight; no se crean registros.");
  }

  return { authenticationCount, authenticated, sameServerSession: finalSameServerSession, vuSessions };
}
