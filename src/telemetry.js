export function createTelemetrySink({ enabled = true, now = () => new Date() } = {}) {
  const events = [];
  const subscribers = new Set();
  return {
    enabled,
    emit(name, payload = {}) {
      if (!enabled) return null;
      const event = { name, payload: redactTelemetryPayload(payload), timestamp: now().toISOString() };
      events.push(event);
      for (const subscriber of subscribers) subscriber(event);
      return event;
    },
    list() {
      return [...events];
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    flush() {
      const flushed = events.splice(0, events.length);
      return flushed;
    }
  };
}

export function redactTelemetryPayload(payload = {}) {
  if (Array.isArray(payload)) return payload.map((item) => redactTelemetryPayload(item));
  if (!payload || typeof payload !== "object") return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [
    key,
    /token|secret|password|key|authorization/i.test(key) ? "[REDACTED]" : redactTelemetryPayload(value)
  ]));
}

export function telemetryEvent(name, payload = {}, now = () => new Date()) {
  return { name, payload: redactTelemetryPayload(payload), timestamp: now().toISOString() };
}
