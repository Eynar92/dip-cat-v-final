import test from "node:test";
import assert from "node:assert/strict";
import { validateSessionRun } from "../experiments/session-run-validation.js";

const runId = "run-test-01";
const condition = "shared";
const types = [3, 1];

function manifest() {
  return [1, 2].flatMap((vu) => [1, 2].map((iteration) => ({
    runId,
    condition,
    id: String(100 + vu * 10 + iteration),
    type: types[iteration - 1],
    vu,
    iteration,
    status: "verified",
  })));
}

function verified(events = manifest()) {
  return events.map((event) => ({
    sourceRunId: runId,
    condition,
    id: event.id,
    type: event.type,
    vu: event.vu,
    iteration: event.iteration,
    status: "verified-after-run",
    ok: true,
    stage: "verified",
  }));
}

function check(overrides = {}) {
  const events = manifest();
  const results = verified(events);
  return validateSessionRun({
    runId,
    condition,
    measuredExitCode: 0,
    manifestEvents: events,
    verificationAttempted: true,
    verifierExitCode: 0,
    verifierAuthEvents: [{ authenticated: true, authenticationCount: 1 }],
    verificationEvents: results,
    vus: 2,
    iterationsPerVu: 2,
    typeByIteration: types,
    ...overrides,
  });
}

test("accepts a complete measured run and a complete matching verification", () => {
  assert.deepEqual(check().errors, []);
  assert.equal(check().ok, true);
});

test("fails when the verifier exits nonzero and emits no events", () => {
  const result = check({ verifierExitCode: 1, verificationEvents: [] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /verificador terminó con código 1/i);
  assert.match(result.errors.join(" "), /verificación posterior incompleta/i);
});

test("fails when the verifier exits zero but emits no events", () => {
  const result = check({ verificationEvents: [] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /verificación posterior incompleta/i);
});

test("fails when a post-verification result is missing", () => {
  const results = verified().slice(1);
  const result = check({ verificationEvents: results });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /resultado posterior del intento .* falta/i);
});

test("fails on duplicate manifest attempts, duplicate IDs and unrelated verification events", () => {
  const events = manifest();
  events[1].id = events[0].id;
  events.push({ ...events[0] });
  const results = verified(events.slice(0, 4));
  results.push({ ...results[0], sourceRunId: "another-run", id: "999" });
  const result = check({ manifestEvents: events, verificationEvents: results });
  assert.equal(result.ok, false);
  assert.equal(result.duplicateIds.length, 1);
  assert.match(result.errors.join(" "), /ID .* repetido/i);
  assert.match(result.errors.join(" "), /falta o está duplicado en el manifiesto/i);
  assert.match(result.errors.join(" "), /Resultado posterior de otra corrida/);
});

test("fails when any post-verification record explicitly fails", () => {
  const results = verified();
  results[2] = { ...results[2], ok: false, status: "verification-failed", stage: "persistence-validation" };
  const result = check({ verificationEvents: results });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /no fue confirmado por el verificador/i);
});

test("requires a read-only verifier run and matching authentication when IDs exist", () => {
  const notAttempted = check({ verificationAttempted: false });
  assert.match(notAttempted.errors.join(" "), /no se ejecutó la verificación posterior/i);
  const noAuthentication = check({ verifierAuthEvents: [] });
  assert.match(noAuthentication.errors.join(" "), /Autenticación del verificador ausente/i);
});
