import { Rate, Trend } from "k6/metrics";

export const flowFailureRate = new Rate("voucher_flow_failure_rate");
export const operationDuration = new Trend("voucher_operation_duration", true);
export const businessSuccess = new Rate("voucher_business_success");

export function recordOperation(response, operation, type) {
  operationDuration.add(response.timings.duration, { operation, voucher_type: String(type) });
}
