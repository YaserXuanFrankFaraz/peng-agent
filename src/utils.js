import path from "node:path";

export function isSafeUrl(value, { allowLocalhost = true } = {}) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (!allowLocalhost && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function serviceUrl(base, pathname = "") {
  const url = new URL(pathname, base);
  return url.toString();
}

export function workspaceSlug(name) {
  return String(name ?? "workspace")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
}

export function isIgnoredFile(file, patterns = []) {
  const normalized = String(file).replaceAll(path.sep, "/");
  return patterns.some((pattern) => normalized.includes(String(pattern).replaceAll(path.sep, "/")));
}

export function toolName(commandLine) {
  const [first = ""] = String(commandLine ?? "").trim().split(/\s+/);
  return path.basename(first);
}

export function logoResourcePath(name = "craft_app_icon.png") {
  return `/resources/craft-logos/${encodeURIComponent(name)}`;
}
