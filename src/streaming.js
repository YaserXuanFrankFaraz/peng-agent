import { createId } from "./id.js";

export function createStreamAccumulator({ toolNameMap = new Map() } = {}) {
  return {
    content: "",
    toolCalls: new Map(),
    toolCallIndexes: new Map(),
    diagnostics: [],
    toolNameMap
  };
}

export function applyStreamEvent(accumulator, event) {
  if (!event) return accumulator;
  if (event.type === "content.delta") {
    accumulator.content += event.delta ?? "";
    return accumulator;
  }
  if (event.type === "tool.delta") {
    const existingId = event.id ?? accumulator.toolCallIndexes.get(event.index);
    const id = existingId ?? event.index ?? createId("tool_call");
    const current = accumulator.toolCalls.get(id) ?? {
      id,
      index: event.index ?? null,
      name: "",
      arguments: ""
    };
    if (event.index !== undefined && event.index !== null) accumulator.toolCallIndexes.set(event.index, id);
    if (event.name) current.name = event.name;
    if (event.argumentsDelta) current.arguments += event.argumentsDelta;
    accumulator.toolCalls.set(id, current);
    return accumulator;
  }
  if (event.type === "diagnostic") accumulator.diagnostics.push(event);
  return accumulator;
}

export function finalizeStream(accumulator) {
  const toolCalls = [...accumulator.toolCalls.values()].map((call) => {
    const repaired = repairToolArguments(call.arguments);
    if (repaired.repaired) {
      accumulator.diagnostics.push({
        type: "diagnostic",
        code: "tool_arguments_repaired",
        id: call.id,
        message: repaired.message
      });
    }
    return {
      id: call.id,
      name: accumulator.toolNameMap.get(call.name) ?? call.name,
      input: repaired.value
    };
  });
  return {
    content: accumulator.content,
    toolCalls,
    diagnostics: accumulator.diagnostics
  };
}

export function repairToolArguments(value) {
  if (!value || !String(value).trim()) return { value: {}, repaired: false };
  if (typeof value === "object") return { value, repaired: false };
  const text = String(value).trim();
  const parsed = tryParseJson(text);
  if (parsed.ok) return { value: parsed.value, repaired: false };

  const balanced = balanceJsonObject(text);
  if (balanced !== text) {
    const repaired = tryParseJson(balanced);
    if (repaired.ok) {
      return {
        value: repaired.value,
        repaired: true,
        message: "Balanced incomplete tool-call JSON arguments."
      };
    }
  }

  return {
    value: { value: text },
    repaired: true,
    message: "Wrapped malformed tool-call arguments as a string value."
  };
}

export async function collectStream(stream, { onEvent } = {}) {
  const accumulator = createStreamAccumulator();
  for await (const event of stream) {
    applyStreamEvent(accumulator, event);
    if (onEvent) await onEvent(event);
  }
  return finalizeStream(accumulator);
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function balanceJsonObject(text) {
  let next = text;
  const opens = (text.match(/{/g) ?? []).length;
  const closes = (text.match(/}/g) ?? []).length;
  if (opens > closes) next += "}".repeat(opens - closes);
  const brackets = (text.match(/\[/g) ?? []).length;
  const bracketCloses = (text.match(/]/g) ?? []).length;
  if (brackets > bracketCloses) next += "]".repeat(brackets - bracketCloses);
  return next;
}
