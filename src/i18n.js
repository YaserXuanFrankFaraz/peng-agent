const DEFAULT_MESSAGES = {
  "app.name": "Peng",
  "status.ready": "Ready",
  "status.running": "Running",
  "status.failed": "Failed",
  "action.cancel": "Cancel",
  "action.retry": "Retry"
};

export function createI18n({ locale = "en", messages = {} } = {}) {
  const table = { ...DEFAULT_MESSAGES, ...messages };
  return {
    locale,
    messages: table,
    t(key, values = {}) {
      return formatMessage(table[key] ?? key, values);
    }
  };
}

export function formatMessage(template, values = {}) {
  return String(template).replace(/\{([^}]+)\}/g, (_, key) => values[key] ?? `{${key}}`);
}
