import test from "node:test";
import assert from "node:assert/strict";
import {
  captureResponseCookies,
  exportActiveCookies,
  findSessionIdentity,
  hasCookie,
  installCookies,
} from "../src/session-cookies.js";
import { sessionPolicyForCondition, validateSessionComparisonProfile } from "../experiments/session-condition.js";

function cookieJar(activeCookies = {}) {
  return {
    activeCookies,
    cookiesForURL() { return this.activeCookies; },
    set(url, name, value, attributes) {
      this.installed = { url, name, value, attributes };
    },
  };
}

test("shared session cookies are transferred with verified security attributes", () => {
  const baseUrl = "https://financiero.example.test/financierodiplomado/";
  const captured = new Map();
  captureResponseCookies(captured, {
    headers: { "Set-Cookie": "PHPSESSID=opaque-value; Path=/financierodiplomado/; HttpOnly; Secure; Max-Age=600" },
  }, `${baseUrl}session.php`);
  const jar = cookieJar({ PHPSESSID: ["opaque-value"] });
  const cookies = exportActiveCookies(jar, baseUrl, captured);
  const identity = findSessionIdentity(cookies);

  assert.equal(identity.name, "PHPSESSID");
  assert.equal(hasCookie(jar, baseUrl, identity), true);
  installCookies(jar, baseUrl, cookies);
  assert.equal(jar.installed.name, "PHPSESSID");
  assert.equal(jar.installed.value, "opaque-value");
  assert.equal(jar.installed.attributes.path, "/financierodiplomado/");
  assert.equal(jar.installed.attributes.secure, true);
  assert.equal(jar.installed.attributes.http_only, true);
  assert.equal(jar.installed.attributes.max_age, 600);
});

test("cookie capture preserves host-only and explicit Domain scopes", () => {
  const captured = new Map();
  captureResponseCookies(captured, {
    headers: { "Set-Cookie": "PHPSESSID=one; Path=/app; HttpOnly" },
  }, "http://app.example.test/app/login");
  captureResponseCookies(captured, {
    headers: { "Set-Cookie": "AUTH=two; Domain=.example.test; Path=/; Secure" },
  }, "https://app.example.test/app/login");

  const cookies = [...captured.values()];
  assert.equal(cookies.find((cookie) => cookie.name === "PHPSESSID")?.host_only, true);
  assert.equal(cookies.find((cookie) => cookie.name === "PHPSESSID")?.path, "/app");
  assert.equal(cookies.find((cookie) => cookie.name === "AUTH")?.host_only, false);
  assert.equal(cookies.find((cookie) => cookie.name === "AUTH")?.domain, "example.test");
  assert.equal(cookies.find((cookie) => cookie.name === "AUTH")?.secure, true);
});

test("session identity detection fails closed when the server identity is ambiguous", () => {
  assert.throws(() => findSessionIdentity([
    { name: "PHPSESSID", value: "one", domain: "example.test", path: "/", host_only: true },
    { name: "JSESSIONID", value: "two", domain: "example.test", path: "/", host_only: true },
  ]), /No se pudo identificar una única cookie/);
});

test("experiment conditions use the shared and per-VU strategies from the common implementation", () => {
  assert.equal(sessionPolicyForCondition("shared"), "shared");
  assert.equal(sessionPolicyForCondition("independent"), "per-vu");
  assert.throws(() => sessionPolicyForCondition("unknown"), /shared o independent/);
});

test("comparison profile rejects a load larger than the reviewed two-VU scope", () => {
  const valid = { executor: "per-vu-iterations", vus: 2, iterationsPerVu: 2,
    typeByIteration: [3, 1], cloud: { loadZone: "amazon:us:ashburn" } };
  assert.equal(validateSessionComparisonProfile(valid), valid);
  assert.throws(() => validateSessionComparisonProfile({ ...valid, vus: 50 }), /2 VUs/);
  assert.throws(() => validateSessionComparisonProfile({ ...valid, iterationsPerVu: 3 }), /2 VUs/);
  assert.throws(() => validateSessionComparisonProfile({ ...valid, typeByIteration: [1, 3] }), /2 VUs/);
});
