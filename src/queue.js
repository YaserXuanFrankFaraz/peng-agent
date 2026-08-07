import { createId } from "./id.js";

export function createQueuedMessage({
  threadId,
  content,
  role = "user",
  source = "client",
  status = "pending",
  replayAttempts = 0,
  createdAt = new Date().toISOString()
}) {
  if (!threadId) throw new Error("Queued message requires threadId.");
  if (!content || !String(content).trim()) throw new Error("Queued message requires content.");
  return {
    id: createId("queued_message"),
    threadId,
    role,
    content: String(content),
    source,
    status,
    replayAttempts,
    createdAt,
    updatedAt: createdAt
  };
}

export function markQueuedMessage(message, status, extra = {}) {
  return {
    ...message,
    ...extra,
    status,
    updatedAt: new Date().toISOString()
  };
}
