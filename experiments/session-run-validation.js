function attemptKey(event) {
  return `${event.vu}:${event.iteration}`;
}

function eventKey(event) {
  return `${event.runId}:${event.condition}:${event.id}:${event.type}:${event.vu}:${event.iteration}`;
}

export function validateSessionRun({
  runId,
  condition,
  measuredExitCode,
  manifestEvents,
  verificationAttempted,
  summaryAvailable = true,
  verificationSummaryAvailable = true,
  verifierExitCode,
  verifierAuthEvents,
  verificationEvents,
  vus,
  iterationsPerVu,
  typeByIteration,
}) {
  const expectedCount = vus * iterationsPerVu;
  const errors = [];
  const attempts = Array.isArray(manifestEvents) ? manifestEvents : [];
  const authEvents = Array.isArray(verifierAuthEvents) ? verifierAuthEvents : [];
  const verifiedRecords = Array.isArray(verificationEvents) ? verificationEvents : [];
  const byAttempt = new Map();
  const seenIds = new Map();
  const eventsToVerify = [];

  if (measuredExitCode !== 0) errors.push(`La ejecución medida terminó con código ${measuredExitCode}.`);
  if (!summaryAvailable) errors.push("No se escribió el resumen estadístico seguro de la ejecución medida.");
  if (attempts.length !== expectedCount) {
    errors.push(`Manifiesto incompleto: se esperaban ${expectedCount} eventos y llegaron ${attempts.length}.`);
  }

  for (const event of attempts) {
    const key = attemptKey(event);
    byAttempt.set(key, (byAttempt.get(key) || 0) + 1);
    if (event.runId !== runId) errors.push(`Evento de manifiesto ajeno al RUN_ID esperado en intento ${key}.`);
    if (event.condition !== condition) errors.push(`Condición inesperada en intento ${key}.`);
    const expectedType = typeByIteration[event.iteration - 1];
    if (!Number.isInteger(event.vu) || event.vu < 1 || event.vu > vus ||
        !Number.isInteger(event.iteration) || event.iteration < 1 || event.iteration > iterationsPerVu) {
      errors.push(`Identidad VU/iteración fuera del plan: ${key}.`);
    }
    if (event.type !== expectedType) errors.push(`Tipo inesperado en intento ${key}.`);
    if (event.status !== "verified" || !/^\d+$/.test(String(event.id ?? ""))) {
      errors.push(`El intento ${key} no terminó verificado con ID consultable (estado: ${event.status || "desconocido"}).`);
    }
    if (event.id !== undefined && event.id !== null && String(event.id) !== "") {
      const id = String(event.id);
      const prior = seenIds.get(id) || [];
      prior.push(key);
      seenIds.set(id, prior);
      eventsToVerify.push(event);
    }
  }

  for (let vu = 1; vu <= vus; vu += 1) {
    for (let iteration = 1; iteration <= iterationsPerVu; iteration += 1) {
      const key = `${vu}:${iteration}`;
      if (byAttempt.get(key) !== 1) errors.push(`El intento ${key} falta o está duplicado en el manifiesto.`);
    }
  }
  const duplicateIds = [...seenIds.entries()].filter(([, keys]) => keys.length > 1).map(([id, keys]) => ({ id, attempts: keys }));
  for (const duplicate of duplicateIds) errors.push(`ID ${duplicate.id} repetido entre intentos: ${duplicate.attempts.join(", ")}.`);

  const shouldVerify = eventsToVerify.length > 0;
  if (verificationAttempted !== shouldVerify) {
    errors.push(shouldVerify ? "Había IDs consultables, pero no se ejecutó la verificación posterior." :
      "Se declaró verificación posterior sin IDs consultables.");
  }
  if (shouldVerify && verifierExitCode !== 0) errors.push(`El verificador terminó con código ${verifierExitCode ?? "desconocido"}.`);
  if (shouldVerify && !verificationSummaryAvailable) errors.push("No se escribió el resumen estadístico seguro de la verificación posterior.");
  if (shouldVerify && authEvents.length !== 1) errors.push(`Autenticación del verificador ausente o duplicada (${authEvents.length}).`);
  if (shouldVerify && authEvents.some((event) => event.authenticated !== true || event.authenticationCount !== 1)) {
    errors.push("La autenticación de solo lectura del verificador no quedó confirmada.");
  }

  if (shouldVerify && verifiedRecords.length !== eventsToVerify.length) {
    errors.push(`Verificación posterior incompleta: se esperaban ${eventsToVerify.length} resultados y llegaron ${verifiedRecords.length}.`);
  }
  const expectedByAttempt = new Map(eventsToVerify.map((event) => [attemptKey(event), event]));
  const resultsByAttempt = new Map();
  for (const result of verifiedRecords) {
    const key = attemptKey(result);
    const matching = resultsByAttempt.get(key) || [];
    matching.push(result);
    resultsByAttempt.set(key, matching);
    const expected = expectedByAttempt.get(key);
    if (!expected) {
      errors.push(`Resultado posterior ajeno o sin intento esperado: ${eventKey(result)}.`);
      continue;
    }
    if (result.sourceRunId !== runId || result.condition !== condition) {
      errors.push(`Resultado posterior de otra corrida o condición para intento ${key}.`);
    }
    if (result.sourceRunId !== runId || result.condition !== condition ||
        String(result.id) !== String(expected.id) || result.type !== expected.type ||
        result.vu !== expected.vu || result.iteration !== expected.iteration) {
      errors.push(`El resultado posterior no corresponde al manifiesto para intento ${key}.`);
    }
    if (result.ok !== true || result.status !== "verified-after-run" || result.stage !== "verified") {
      errors.push(`El intento ${key} no fue confirmado por el verificador (estado: ${result.status || "desconocido"}).`);
    }
  }
  for (const expected of eventsToVerify) {
    const key = attemptKey(expected);
    if ((resultsByAttempt.get(key) || []).length !== 1) {
      errors.push(`El resultado posterior del intento ${key} falta o está duplicado.`);
    }
  }

  return { ok: errors.length === 0, errors, duplicateIds, expectedAttempts: expectedCount,
    manifestEvents: attempts.length, verificationExpected: eventsToVerify.length,
    verificationResults: verifiedRecords.length };
}
