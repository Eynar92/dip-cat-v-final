export function withoutSetupData(summary) {
  const { setup_data: _setupData, ...safeSummary } = summary || {};
  return safeSummary;
}

export function writeSafeSummary(summary, destination) {
  if (!destination) throw new Error("Falta K6_SAFE_SUMMARY_PATH para escribir el resumen sin setup_data.");
  return { [destination]: `${JSON.stringify(withoutSetupData(summary), null, 2)}\n` };
}
