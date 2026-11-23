import test from "node:test";
import assert from "node:assert/strict";
import {
  captureResponseCookies,
  exportActiveCookies,
  findSessionIdentity,
  installCookies,
  jarHasIdentity,
  prepareSessionPlan,
  sameSessionIdentity,
} from "../experiments/session-cookies.js";

function sessionCookie(value) {
  return {
    name: "PHPSESSID",
    value,
    domain: "financiero.example.test",
    path: "/financierodiplomado/",
    secure: false,
    http_only: true,
  };
}

test("shared condition authenticates once and assigns the same identity to both VUs", () => {
  let logins = 0;
  const preflights = [];
  const plan = prepareSessionPlan("shared", {
    vus: 2,
    login: () => { logins += 1; return { cookies: [sessionCookie("sid-shared")], identity: sessionCookie("sid-shared") }; },
    verify: (session, vu) => { preflights.push({ session, vu }); return true; },
  });

  assert.equal(logins, 1);
  assert.equal(plan.authenticationCount, 1);
  assert.equal(plan.sameServerSession, true);
  assert.equal(plan.vuSessions.length, 2);
  assert.equal(sameSessionIdentity(plan.vuSessions[0].identity, plan.vuSessions[1].identity), true);
  assert.deepEqual(preflights.map(({ vu }) => vu), [1, 2]);
});

test("independent condition authenticates twice and rejects a reused server identity before preflight", () => {
  let logins = 0;
  let verifications = 0;
  assert.throws(() => prepareSessionPlan("independent", {
    vus: 2,
    login: () => { logins += 1; return { cookies: [sessionCookie("same-sid")], identity: sessionCookie("same-sid") }; },
    verify: () => { verifications += 1; return true; },
  }), /identidades de sesión distintas/);
  assert.equal(logins, 2);
  assert.equal(verifications, 0);
});

test("independent condition verifies both sessions after both logins", () => {
  let logins = 0;
  let verifications = 0;
  const plan = prepareSessionPlan("independent", {
    vus: 2,
    login: () => { logins += 1; return { cookies: [sessionCookie(`sid-${logins}`)], identity: sessionCookie(`sid-${logins}`) }; },
    verify: () => { verifications += 1; return true; },
  });
  assert.equal(logins, 2);
  assert.equal(verifications, 2);
  assert.equal(plan.authenticationCount, 2);
  assert.equal(plan.authenticated, true);
  assert.equal(plan.sameServerSession, false);
});

test("preflight failure aborts the plan before iteration work can start", () => {
  let logins = 0;
  let verifications = 0;
  assert.throws(() => prepareSessionPlan("shared", {
    vus: 2,
    login: () => { logins += 1; return { cookies: [sessionCookie("sid")], identity: sessionCookie("sid") }; },
    verify: () => { verifications += 1; return verifications === 1; },
  }), /no se crean registros/);
  assert.equal(logins, 1);
  assert.equal(verifications, 2);
});

for (const vus of [5, 10]) {
  test(`shared session authenticates once and assigns the same identity to ${vus} VUs`, () => {
    let logins = 0;
    const preflightVus = [];
    const plan = prepareSessionPlan("shared", {
      vus,
      login: () => {
        logins += 1;
        const identity = sessionCookie("shared-session");
        return { cookies: [identity], identity };
      },
      verify: (session, vu) => {
        preflightVus.push(vu);
        return session.identity.value === "shared-session";
      },
    });

    assert.equal(logins, 1);
    assert.equal(plan.authenticationCount, 1);
    assert.equal(plan.vuSessions.length, vus);
    assert.equal(preflightVus.length, vus);
    assert.deepEqual(preflightVus, Array.from({ length: vus }, (_, index) => index + 1));
    assert.equal(plan.vuSessions.every((session) => sameSessionIdentity(session.identity, plan.vuSessions[0].identity)), true);
    assert.equal(new Set(plan.vuSessions).size, vus, "each VU receives its own session container");
    assert.equal(plan.sameServerSession, true);
  });

  test(`independent condition authenticates and preflights ${vus} distinct VU sessions`, () => {
    let logins = 0;
    const preflightVus = [];
    const plan = prepareSessionPlan("independent", {
      vus,
      login: (vu) => {
        logins += 1;
        const identity = sessionCookie(`session-${vu}`);
        return { cookies: [identity], identity };
      },
      verify: (session, vu) => {
        preflightVus.push(vu);
        return session.identity.value === `session-${vu}`;
      },
    });
    const identities = plan.vuSessions.map(({ identity }) => identity.value);

    assert.equal(logins, vus);
    assert.equal(plan.authenticationCount, vus);
    assert.equal(plan.vuSessions.length, vus);
    assert.deepEqual(preflightVus, Array.from({ length: vus }, (_, index) => index + 1));
    assert.equal(new Set(identities).size, vus);
    assert.equal(plan.sameServerSession, false);
  });
}

test("session plan rejects invalid VU counts and a one-VU independent comparison", () => {
  assert.throws(() => prepareSessionPlan("shared", { vus: 0, login() {}, verify() {} }), /entero positivo/);
  assert.throws(() => prepareSessionPlan("independent", { vus: 1, login() {}, verify() {} }), /al menos 2 VUs/);
});

test("independent condition rejects a repeated identity between non-adjacent VUs", () => {
  let verifications = 0;
  assert.throws(() => prepareSessionPlan("independent", {
    vus: 5,
    login: (vu) => {
      const identity = sessionCookie(vu === 5 ? "session-1" : `session-${vu}`);
      return { cookies: [identity], identity };
    },
    verify: () => { verifications += 1; return true; },
  }), /identidades de sesión distintas para todos los VUs/);
  assert.equal(verifications, 0);
});

test("captures and restores cookies with domain, path and security attributes", () => {
  const jar = {
    values: {},
    cookiesForURL() { return this.values; },
    set(url, name, value, attributes) { this.saved = { url, name, value, attributes }; },
  };
  const captured = new Map();
  const response = { cookies: { PHPSESSID: [{ ...sessionCookie("opaque-value"), max_age: 600 }] } };
  captureResponseCookies(captured, response);
  const active = { PHPSESSID: ["opaque-value"] };
  jar.cookiesForURL = () => active;
  const exported = exportActiveCookies(jar, "http://financiero.example.test/financierodiplomado", captured);
  const identity = findSessionIdentity(exported);

  assert.equal(identity.name, "PHPSESSID");
  assert.equal(jarHasIdentity({ cookiesForURL: () => active }, "http://financiero.example.test/financierodiplomado", identity), true);
  installCookies(jar, "http://financiero.example.test/financierodiplomado", exported);
  assert.equal(jar.saved.name, "PHPSESSID");
  assert.equal(jar.saved.value, "opaque-value");
  assert.equal(jar.saved.attributes.domain, "financiero.example.test");
  assert.equal(jar.saved.attributes.path, "/financierodiplomado/");
  assert.equal(jar.saved.attributes.http_only, true);
  assert.equal(jar.saved.attributes.max_age, 600);
});

test("preserves host-only cookies and explicit Domain attributes from Set-Cookie", () => {
  const captured = new Map();
  captureResponseCookies(captured, {
    url: "http://app.example.test/financierodiplomado/session.php",
    headers: { "Set-Cookie": "PHPSESSID=opaque; Path=/financierodiplomado/; HttpOnly; SameSite=Lax" },
  });
  captureResponseCookies(captured, {
    url: "https://app.example.test/financierodiplomado/session.php",
    headers: { "Set-Cookie": "AUTH=opaque2; Domain=.example.test; Path=/; Secure; HttpOnly" },
  });
  const cookies = [...captured.values()];
  assert.equal(cookies.find((cookie) => cookie.name === "PHPSESSID")?.host_only, true);
  assert.equal(cookies.find((cookie) => cookie.name === "PHPSESSID")?.path, "/financierodiplomado/");
  assert.equal(cookies.find((cookie) => cookie.name === "AUTH")?.host_only, false);
  assert.equal(cookies.find((cookie) => cookie.name === "AUTH")?.domain, "example.test");
  assert.equal(cookies.find((cookie) => cookie.name === "AUTH")?.secure, true);
});

test("fails closed if active cookies lack response metadata or a unique session cookie", () => {
  assert.throws(() => exportActiveCookies(
    { cookiesForURL: () => ({ custom: ["value"] }) },
    "https://example.test/app",
    new Map(),
  ), /No hay metadatos para la cookie activa/);
  assert.throws(() => findSessionIdentity([
    sessionCookie("one"),
    { ...sessionCookie("two"), path: "/" },
  ]), /No se pudo identificar una única cookie/);
});
