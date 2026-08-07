export function parseMentions(text) {
  const mentions = [];
  for (const match of String(text ?? "").matchAll(/(^|\s)@([A-Za-z0-9_.-]+)/g)) {
    mentions.push({ value: match[2], index: match.index + match[1].length });
  }
  return mentions;
}

export function uniqueMentions(text) {
  return [...new Set(parseMentions(text).map((mention) => mention.value))];
}
