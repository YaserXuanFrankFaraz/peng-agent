import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function createCredentialBackendFromEnv(env = process.env) {
  const mode = env.YUUMIRA_CREDENTIAL_STORE ?? env.YUUMIRA_SECRET_STORE;
  if (mode === "macos-keychain" || mode === "keychain") {
    return new MacOSKeychainCredentialBackend({
      service: env.YUUMIRA_KEYCHAIN_SERVICE ?? "YuuMira Cleanroom"
    });
  }
  return null;
}

export class MacOSKeychainCredentialBackend {
  constructor({ service = "YuuMira Cleanroom" } = {}) {
    this.name = "macos-keychain";
    this.service = service;
  }

  async saveSecret({ sourceSlug, field, value }) {
    const account = secretAccount(sourceSlug, field);
    await execFileAsync("security", [
      "add-generic-password",
      "-a",
      account,
      "-s",
      this.service,
      "-w",
      value,
      "-U"
    ]);
    return { backend: this.name, service: this.service, account };
  }

  async readSecret(ref) {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-a",
        ref.account,
        "-s",
        ref.service ?? this.service,
        "-w"
      ]);
      return stdout.replace(/\n$/, "");
    } catch (error) {
      if (error.code === 44 || error.stderr?.includes("could not be found")) return null;
      throw error;
    }
  }

  async deleteSecret(ref) {
    try {
      await execFileAsync("security", [
        "delete-generic-password",
        "-a",
        ref.account,
        "-s",
        ref.service ?? this.service
      ]);
    } catch (error) {
      if (error.code === 44 || error.stderr?.includes("could not be found")) return;
      throw error;
    }
  }
}

export function serializeSecret(value) {
  if (typeof value === "string") return { encoding: "string", text: value };
  return { encoding: "json", text: JSON.stringify(value) };
}

export function deserializeSecret(text, encoding = "string") {
  if (text === null || text === undefined) return null;
  return encoding === "json" ? JSON.parse(text) : text;
}

function secretAccount(sourceSlug, field) {
  return `source:${sourceSlug}:${field}`;
}
