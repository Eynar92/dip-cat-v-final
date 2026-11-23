export function withoutSetupData(summary) {
  const { setup_data: _setupData, ...safeSummary } = summary;
  return safeSummary;
}

export function writeSessionSummary(summary) {
  const destination = __ENV.EXPERIMENT_SUMMARY_PATH;
  if (!destination) throw new Error("Falta EXPERIMENT_SUMMARY_PATH para escribir el resumen seguro.");
  return { [destination]: `${JSON.stringify(withoutSetupData(summary), null, 2)}\n` };
}
