export function createRunControl({
  threadId,
  status = "running",
  reason = null,
  heartbeatAt = new Date().toISOString(),
  updatedAt = heartbeatAt
}) {
  if (!threadId) throw new Error("Run control requires threadId.");
  return {
    threadId,
    status,
    reason,
    heartbeatAt,
    updatedAt
  };
}

export function updateRunControl(control, patch = {}) {
  const now = new Date().toISOString();
  return {
    ...control,
    ...patch,
    updatedAt: now,
    heartbeatAt: patch.heartbeatAt ?? control.heartbeatAt
  };
}

export function isStopRequested(control) {
  return control?.status === "stop_requested";
}

export function heartbeatAgeMs(control, now = Date.now()) {
  if (!control?.heartbeatAt) return Infinity;
  return Math.max(0, now - Date.parse(control.heartbeatAt));
}
