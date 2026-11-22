import { Rate, Trend } from "k6/metrics";

export const flowFailureRate = new Rate("voucher_flow_failure_rate");
export const businessSuccess = new Rate("voucher_business_success");
export const operationDuration = new Trend("voucher_operation_duration", true);
export const flowDuration = new Trend("voucher_flow_duration", true);

export function recordOperation(response, operation, type) {
  const duration = Number(response?.timings?.duration);
  if (!Number.isFinite(duration)) return;
  operationDuration.add(duration, { operation, voucher_type: String(type ?? "none") });
}

export function recordFlowDuration(duration, type) {
  if (!Number.isFinite(duration)) return;
  flowDuration.add(duration, { voucher_type: String(type ?? "none") });
}
