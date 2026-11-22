import test from "node:test";
import assert from "node:assert/strict";
import { extractManifestEvents } from "../run.js";

test("extracts a raw MANIFEST JSON line", () => {
  const event = { runId: "run-a", test: "smoke", id: "18355", verified: true };

  assert.deepEqual(extractManifestEvents(`MANIFEST ${JSON.stringify(event)}`), [event]);
});

test("decodes the escaped msg field emitted by k6 v2.3.0", () => {
  const event = {
    runId: "26112218540b8fd0",
    test: "concurrency-validation",
    id: "18370",
    glosa: "DIP_Cato-G6-26112218540b8fd0-CV-V1-I4",
    verified: true,
  };
  const message = `MANIFEST ${JSON.stringify(event)}`;
  const k6Line = `time="2026-11-22T18:54:00-04:00" level=info msg=${JSON.stringify(message)} source=console`;

  assert.deepEqual(extractManifestEvents(k6Line), [event]);
});

test("ignores unrelated console lines and malformed manifest JSON", () => {
  const log = [
    "time=2026-11-22T18:54:00 level=info msg=starting source=console",
    "MANIFEST {not-json}",
  ].join("\n");

  assert.deepEqual(extractManifestEvents(log), []);
});
