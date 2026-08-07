export function systemPrompt({ productName = "Peng", workspace = process.cwd() } = {}) {
  return `You are ${productName}, an AI agent working in ${workspace}.`;
}

export function taskPrompt(input, context = {}) {
  return {
    role: "user",
    content: String(input ?? ""),
    context
  };
}

export function appendContext(prompt, contextText) {
  return `${prompt}\n\n<context>\n${contextText}\n</context>`;
}
