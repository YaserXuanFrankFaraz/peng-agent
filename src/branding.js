export const BRANDING = {
  productName: "Peng",
  appName: "Peng",
  bundleIdentifier: "com.yaserxuanfrankfaraz.peng",
  urlSchemes: ["peng", "yuumira", "craftagents"],
  craftName: "Craft Agents"
};

export function branding(overrides = {}) {
  return { ...BRANDING, ...overrides };
}

export function appTitle(suffix = "") {
  return suffix ? `${BRANDING.productName} - ${suffix}` : BRANDING.productName;
}
