const SESSION_COOKIE_NAMES = new Set(["phpsessid", "jsessionid", "asp.net_sessionid"]);

function scopeUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, "")}/`;
}

function cookieKey(cookie) {
  return `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}\u0000${cookie.host_only ? "host" : "domain"}`;
}

function parseRequestUrl(requestUrl) {
  const match = String(requestUrl || "").match(/^https?:\/\/(\[[^\]]+\]|[^/:?#]+)(?::\d+)?(\/[^?#]*)?/i);
  if (!match) return null;
  return { hostname: match[1].replace(/^\[|\]$/g, ""), pathname: match[2] || "/" };
}

function validExpires(value) {
  if (typeof value !== "string" || /^[+-]?\d+$/.test(value.trim())) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function parseSetCookie(value, requestUrl) {
  const [pair, ...attributes] = String(value).split(";");
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
    const [rawName, ...parts] = rawAttribute.trim().split("=");
    const name = rawName.toLowerCase();
    const valuePart = parts.join("=").trim();
    if (name === "domain" && valuePart) {
      cookie.domain = valuePart.replace(/^\./, "");
      cookie.host_only = false;
    } else if (name === "path" && valuePart) cookie.path = valuePart;
    else if (name === "secure") cookie.secure = true;
    else if (name === "httponly") cookie.http_only = true;
    else if (name === "max-age" && /^\d+$/.test(valuePart) && Number(valuePart) > 0) cookie.max_age = Number(valuePart);
    else if (name === "expires" && valuePart && validExpires(valuePart)) cookie.expires = validExpires(valuePart);
  }
  return cookie.name && cookie.value && cookie.domain && cookie.path ? cookie : null;
}

function setCookieValues(response) {
  const values = [];
  for (const [name, value] of Object.entries(response?.headers || {})) {
    if (name.toLowerCase() !== "set-cookie") continue;
    values.push(...(Array.isArray(value) ? value.map(String) : [String(value)]));
  }
  return values.flatMap((value) => String(value).split(/,\s*(?=[^,;=\s]+=)/));
}

export function captureResponseCookies(store, response, requestUrl) {
  let count = 0;
  for (const value of setCookieValues(response)) {
    const cookie = parseSetCookie(value, requestUrl || response?.url);
    if (cookie) {
      store.set(cookieKey(cookie), cookie);
      count += 1;
    }
  }
  if (count) return count;

  for (const [name, cookies] of Object.entries(response?.cookies || {})) {
    const cookieList = Array.isArray(cookies) ? cookies : [cookies];
    for (const raw of cookieList) {
      const url = parseRequestUrl(requestUrl || response?.url);
      if (!url) continue;
      const cookie = {
        name: String(raw?.name || name),
        value: String(raw?.value ?? ""),
        domain: String(raw?.domain || url.hostname).replace(/^\./, ""),
        path: String(raw?.path || (url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) || "/")),
        host_only: !raw?.domain,
        secure: !!raw?.secure,
        http_only: !!(raw?.http_only ?? raw?.httpOnly),
        ...(Number.isFinite(raw?.max_age ?? raw?.maxAge) && Number(raw.max_age ?? raw.maxAge) > 0
          ? { max_age: Number(raw.max_age ?? raw.maxAge) } : {}),
        ...(validExpires(raw?.expires) ? { expires: validExpires(raw.expires) } : {}),
      };
      if (!cookie.name || !cookie.value) continue;
      store.set(cookieKey(cookie), cookie);
      count += 1;
    }
  }
  return count;
}

export function exportActiveCookies(jar, baseUrl, store) {
  const active = jar.cookiesForURL(scopeUrl(baseUrl)) || {};
  const result = [];
  for (const [name, values] of Object.entries(active)) {
    for (const value of values || []) {
      let matches = [...store.values()].filter((cookie) => cookie.name === name && cookie.value === value);
      if (!matches.length) {
        const sameName = [...store.values()].filter((cookie) => cookie.name === name);
        if (sameName.length === 1) matches = [{ ...sameName[0], value: String(value) }];
      }
      if (!matches.length) {
        const knownNames = [...new Set([...store.values()].map((cookie) => cookie.name))].join(", ") || "ninguna";
        throw new Error(`No hay atributos verificables para la cookie activa ${name}; metadatos capturados: ${knownNames}.`);
      }
      result.push(...matches);
    }
  }
  const unique = new Map(result.map((cookie) => [cookieKey(cookie), cookie]));
  if (!unique.size) throw new Error("La autenticación no dejó cookies aplicables al ambiente.");
  return [...unique.values()];
}

export function installCookies(jar, baseUrl, cookies) {
  for (const cookie of cookies || []) {
    const attributes = { path: cookie.path, secure: !!cookie.secure, http_only: !!cookie.http_only };
    if (!cookie.host_only) attributes.domain = cookie.domain;
    if (Number.isFinite(cookie.max_age) && cookie.max_age > 0) attributes.max_age = cookie.max_age;
    if (validExpires(cookie.expires)) attributes.expires = cookie.expires;
    jar.set(baseUrl, cookie.name, cookie.value, attributes);
  }
}

export function hasSessionIdentity(cookies) {
  return (cookies || []).some((cookie) => SESSION_COOKIE_NAMES.has(cookie.name.toLowerCase()) ||
    /session|sessid|sessionid|^sid$/i.test(cookie.name));
}

export function findSessionIdentity(cookies) {
  const candidates = (cookies || []).filter((cookie) => SESSION_COOKIE_NAMES.has(cookie.name.toLowerCase()) ||
    /session|sessid|sessionid|^sid$/i.test(cookie.name));
  const preferred = candidates.filter((cookie) => SESSION_COOKIE_NAMES.has(cookie.name.toLowerCase()));
  const selected = preferred.length ? preferred : candidates;
  const unique = new Map(selected.map((cookie) => [cookieKey(cookie), cookie]));
  if (unique.size !== 1) throw new Error("No se pudo identificar una única cookie de sesión del servidor.");
  return unique.values().next().value;
}

export function hasCookie(jar, baseUrl, cookie) {
  return (jar.cookiesForURL(scopeUrl(baseUrl))?.[cookie.name] || []).includes(cookie.value);
}
