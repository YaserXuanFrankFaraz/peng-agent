export const DEFAULT_CONFIG = {
  version: "1.0",
  defaults: {
    notificationsEnabled: true,
    colorTheme: "default",
    autoCapitalisation: true,
    sendMessageKey: "enter",
    spellCheck: false,
    keepAwakeWhileRunning: false,
    richToolDescriptions: true,
    extendedPromptCache: false,
    browserToolEnabled: true,
    computerUseEnabled: false,
    codexMemoryEnabled: false,
    memory: {
      extractionModel: null,
      maxScanSessions: 20,
      maxClaimPerStartup: 5,
      sessionAgeWindowDays: 30,
      idleMinutes: 30,
      maxUnusedDays: 60,
      phase2TopN: 50,
      ratePerMin: 5,
      disableOnExternalContext: false
    },
    observabilityEmitEnabled: true,
    codexArchiveScanRoots: ["~/.codex/archived_sessions"],
    knowledgeCockpitEnabled: false
  },
  workspaceDefaults: {
    thinkingLevel: "think",
    permissionMode: "safe",
    cyclablePermissionModes: ["safe", "allow-all"],
    localMcpServers: {
      enabled: true
    }
  }
};

export function mergeConfig(overrides = {}) {
  return deepMerge(DEFAULT_CONFIG, overrides);
}

function deepMerge(base, overrides) {
  if (!isPlainObject(base) || !isPlainObject(overrides)) return overrides;
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return merged;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
