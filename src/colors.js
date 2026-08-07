export const DEFAULT_THEME_COLORS = {
  background: "#0f172a",
  surface: "#111827",
  accent: "#38bdf8",
  text: "#e5e7eb",
  muted: "#94a3b8",
  danger: "#ef4444",
  success: "#22c55e",
  warning: "#f59e0b"
};

export function themeColor(name, fallback = null, theme = DEFAULT_THEME_COLORS) {
  return theme[name] ?? fallback;
}

export function cssVariables(theme = DEFAULT_THEME_COLORS) {
  return Object.fromEntries(Object.entries(theme).flatMap(([key, value]) => [
    [`--peng-${key}`, value]
  ]));
}
