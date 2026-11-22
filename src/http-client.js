function makeUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/$/, "")}/${String(path).replace(/^\//, "")}`;
}

function requestOptions(cfg, session, operation, type, options = {}) {
  return {
    jar: session.jar,
    timeout: cfg.requestTimeout,
    tags: { operation, voucher_type: type == null ? "none" : String(type) },
    ...options,
  };
}

function record(response, operation, type, recordOperation) {
  if (recordOperation) recordOperation(response, operation, type);
  return response;
}

export function getRequest({ http, cfg, session, path, operation, type, recordOperation, options = {} }) {
  const response = http.get(makeUrl(cfg.baseUrl, path), requestOptions(cfg, session, operation, type, options));
  return record(response, operation, type, recordOperation);
}

export function postRequest({ http, cfg, session, path, body, operation, type, recordOperation, options = {} }) {
  const response = http.post(makeUrl(cfg.baseUrl, path), body, requestOptions(cfg, session, operation, type, options));
  return record(response, operation, type, recordOperation);
}
