export const VERSION = "0.1.0";
export const OBSERVED_YUUMIRA_VERSION = "0.11.12";

export function versionInfo(pkg = {}) {
  return {
    cloneVersion: pkg.version ?? VERSION,
    observedYuuMiraVersion: OBSERVED_YUUMIRA_VERSION
  };
}
