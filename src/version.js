export const VERSION = "0.1.0";

export function versionInfo(pkg = {}) {
  return {
    version: pkg.version ?? VERSION,
    product: "Peng"
  };
}
