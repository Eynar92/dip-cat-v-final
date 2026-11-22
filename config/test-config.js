const TEST_NAMES = ["smoke", "concurrency-validation", "baseline", "sustained", "spike", "stress"];
const VALID_EXECUTORS = ["per-vu-iterations", "constant-vus", "ramping-vus"];

function required(name, value) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Falta configurar ${name}.`);
  }
  return value;
}

function validDuration(value) {
  return typeof value === "string" && /^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/i.test(value);
}

function validateTest(testName, test) {
  if (!test || typeof test !== "object") throw new Error(`La configuración de ${testName} no es válida.`);
  if (!/^[A-Z]{2}$/.test(test.scenarioCode || "")) throw new Error(`scenarioCode inválido para ${testName}.`);
  if (!Array.isArray(test.types) || test.types.length === 0 || new Set(test.types).size !== test.types.length ||
      test.types.some((type) => ![1, 2, 3, 4].includes(type))) {
    throw new Error(`types inválidos para ${testName}; usa tipos entre 1 y 4.`);
  }
  if (!VALID_EXECUTORS.includes(test.executor)) throw new Error(`Executor inválido para ${testName}.`);
  if (!Number.isFinite(test.pauseSeconds) || test.pauseSeconds < 0) throw new Error(`pauseSeconds inválido para ${testName}.`);
  if (!test.thresholds || typeof test.thresholds !== "object" || Object.keys(test.thresholds).length === 0) {
    throw new Error(`Faltan thresholds para ${testName}.`);
  }

  if (test.executor === "per-vu-iterations") {
    if (!Number.isInteger(test.vus) || test.vus < 1 || !Number.isInteger(test.iterationsPerVu) || test.iterationsPerVu < 1) {
      throw new Error(`${testName} requiere vus e iterationsPerVu mayores que cero.`);
    }
    if (!validDuration(test.maxDuration) || !validDuration(test.gracefulStop)) {
      throw new Error(`${testName} requiere maxDuration y gracefulStop con formato de duración válido.`);
    }
  } else if (test.executor === "constant-vus") {
    if (!Number.isInteger(test.vus) || test.vus < 1) throw new Error(`${testName} requiere vus mayores que cero.`);
    if (!validDuration(test.duration) || !validDuration(test.gracefulStop)) {
      throw new Error(`${testName} requiere duration y gracefulStop con formato de duración válido.`);
    }
  } else {
    if (!Array.isArray(test.stages) || test.stages.length === 0 || test.stages.some((stage) =>
      !stage.phase || !validDuration(stage.duration) || !Number.isInteger(stage.target) || stage.target < 0)) {
      throw new Error(`${testName} requiere stages con phase, duration y target válidos.`);
    }
    if (!validDuration(test.gracefulRampDown) || !validDuration(test.gracefulStop)) {
      throw new Error(`${testName} requiere gracefulRampDown y gracefulStop con formato de duración válido.`);
    }
  }
}

export function validateTestCatalog(catalog) {
  if (catalog?.version !== 1 || !catalog.tests || typeof catalog.tests !== "object") {
    throw new Error("config/tests.json debe declarar version 1 y el objeto tests.");
  }
  const actual = Object.keys(catalog.tests).sort();
  const expected = [...TEST_NAMES].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`config/tests.json debe contener exactamente: ${TEST_NAMES.join(", ")}.`);
  }
  for (const name of TEST_NAMES) validateTest(name, catalog.tests[name]);
  return catalog;
}

export function buildScenario(test) {
  if (test.executor === "per-vu-iterations") {
    return {
      executor: test.executor,
      vus: test.vus,
      iterations: test.iterationsPerVu,
      maxDuration: test.maxDuration,
      gracefulStop: test.gracefulStop,
      exec: "runVoucher",
    };
  }
  if (test.executor === "constant-vus") {
    return {
      executor: test.executor,
      vus: test.vus,
      duration: test.duration,
      gracefulStop: test.gracefulStop,
      exec: "runVoucher",
    };
  }
  return {
    executor: test.executor,
    stages: test.stages.map(({ duration, target }) => ({ duration, target })),
    gracefulRampDown: test.gracefulRampDown,
    gracefulStop: test.gracefulStop,
    exec: "runVoucher",
  };
}
