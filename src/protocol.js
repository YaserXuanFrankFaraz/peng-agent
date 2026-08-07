import { createId } from "./id.js";

export const PROTOCOL_VERSION = 1;

export function createProtocolEvent({ type, threadId = null, step = null, sequence = null, payload = {}, createdAt = new Date().toISOString() }) {
  if (!type) throw new Error("Protocol event requires type.");
  return {
    id: createId("protocol_event"),
    version: PROTOCOL_VERSION,
    type,
    threadId,
    step,
    sequence,
    payload,
    createdAt
  };
}

export function sanitizeProtocolPayload(value) {
  if (typeof value === "string") return value.length > 12000 ? `${value.slice(0, 12000)}...` : value;
  if (Array.isArray(value)) return value.map((item) => sanitizeProtocolPayload(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /authorization|api[_-]?key|token|secret|password/i.test(key) ? "[REDACTED]" : sanitizeProtocolPayload(item)
    ])
  );
}

export function renderProtocolEvent(event) {
  const step = event.step === null || event.step === undefined ? "" : ` step=${event.step}`;
  return `${event.createdAt}\t${event.type}${step}\t${event.threadId ?? ""}`;
}
