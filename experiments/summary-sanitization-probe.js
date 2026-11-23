import { check } from "k6";
import { Rate } from "k6/metrics";
import { writeSessionSummary } from "./session-summary.js";

const probeRate = new Rate("probe_rate");

export const options = { vus: 1, iterations: 1, thresholds: { probe_rate: ["rate==1"] } };

export function setup() {
  return { cookie: "COOKIE_SENTINEL_DO_NOT_PERSIST_7d13a9" };
}

export default function () {
  check({ ok: true }, { "offline summary probe": (value) => value.ok });
  probeRate.add(true);
}

export function handleSummary(data) {
  return writeSessionSummary(data);
}
