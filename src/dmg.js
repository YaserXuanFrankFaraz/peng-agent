import { cp, mkdir, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { packageMacosApp } from "./macos-bundle.js";

export const DMG_DEFAULTS = {
  appName: "Peng",
  version: "0.1.0",
  volumeName: "Peng v0.1.0"
};

export function parseDmgOptions(args = [], cwd = process.cwd(), env = process.env) {
  const version = readFlag(args, "--version") ?? env.PENG_APP_VERSION ?? DMG_DEFAULTS.version;
  const appName = readFlag(args, "--name") ?? env.PENG_APP_NAME ?? DMG_DEFAULTS.appName;
  const appPath = readFlag(args, "--app") ?? env.PENG_APP_OUT ?? path.join(cwd, "dist", `${appName}.app`);
  const outPath = readFlag(args, "--out") ?? env.PENG_DMG_OUT ?? path.join(cwd, "dist", `${appName}-v${version}.dmg`);
  const stagingDir = readFlag(args, "--staging");
  return {
    appName,
    version,
    volumeName: readFlag(args, "--volume") ?? env.PENG_DMG_VOLUME ?? `${appName} v${version}`,
    appPath: absolutePath(appPath, cwd),
    outPath: absolutePath(outPath, cwd),
    stagingDir: stagingDir ? absolutePath(stagingDir, cwd) : null,
    sign: args.includes("--sign"),
    identity: readFlag(args, "--identity") ?? env.PENG_CODESIGN_IDENTITY ?? "-",
    verify: args.includes("--verify"),
    noBuild: args.includes("--no-build"),
    clean: !args.includes("--no-clean")
  };
}

export function dmgLayout(options) {
  const stagingDir = options.stagingDir ?? path.join(tmpdir(), `peng-dmg-${process.pid}`);
  return {
    stagingDir,
    appPath: path.join(stagingDir, `${options.appName}.app`),
    applicationsLink: path.join(stagingDir, "Applications")
  };
}

export async function packageDmg({ args = [], cwd = process.cwd(), env = process.env, stdout = console.log } = {}) {
  const options = parseDmgOptions(args, cwd, env);
  if (process.platform !== "darwin") {
    const error = new Error("Peng DMG packaging requires macOS.");
    error.code = "unsupported_platform";
    throw error;
  }

  if (!options.noBuild) {
    const appArgs = ["--out", options.appPath];
    if (options.sign) appArgs.push("--sign", "--identity", options.identity);
    if (options.verify) appArgs.push("--verify");
    await packageMacosApp({ args: appArgs, cwd, env, stdout });
  } else if (!existsSync(options.appPath)) {
    const error = new Error(`Peng app bundle not found: ${options.appPath}`);
    error.code = "app_not_found";
    throw error;
  }

  const layout = dmgLayout(options);
  if (options.clean) await rm(layout.stagingDir, { recursive: true, force: true });
  await mkdir(layout.stagingDir, { recursive: true });
  await cp(options.appPath, layout.appPath, { recursive: true });
  await symlink("/Applications", layout.applicationsLink);
  await mkdir(path.dirname(options.outPath), { recursive: true });

  try {
    const created = await captureCommand([
      "/usr/bin/hdiutil",
      "create",
      "-volname",
      options.volumeName,
      "-srcfolder",
      layout.stagingDir,
      "-ov",
      "-format",
      "UDZO",
      options.outPath
    ]);
    assertCommandSucceeded(created, "hdiutil create");
    const verification = options.verify ? await verifyDmg(options.outPath) : null;
    const result = { options, layout, output: options.outPath, verification };
    stdout(JSON.stringify({
      dmg: options.outPath,
      volume: options.volumeName,
      status: verification && !verification.ok ? "packaged_unverified" : "packaged",
      verification: verification ?? undefined
    }));
    if (verification && !verification.ok) {
      const error = new Error(`DMG failed verification: ${verification.stderr || verification.stdout || verification.code}`);
      error.code = "verification_failed";
      throw error;
    }
    return result;
  } finally {
    if (options.clean) await rm(layout.stagingDir, { recursive: true, force: true });
  }
}

export async function verifyDmg(dmgPath) {
  const result = await captureCommand(["/usr/bin/hdiutil", "verify", dmgPath]);
  return {
    ok: result.code === 0,
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    verifiedPath: dmgPath
  };
}

export function dmgHelp() {
  return `package-dmg

Usage:
  package-dmg [--out dist/Peng-v0.1.0.dmg] [--app dist/Peng.app] [--volume "Peng v0.1.0"] [--sign] [--identity -] [--verify] [--no-build]

The default command builds a self-contained Peng.app, then creates a compressed
macOS disk image containing Peng.app and an Applications shortcut.
`;
}

function absolutePath(value, cwd) {
  return path.isAbsolute(value) ? value : path.join(cwd, value);
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

function assertCommandSucceeded(result, label) {
  if (result.code === 0) return;
  const error = new Error(`${label} failed: ${result.stderr || result.stdout || result.code}`);
  error.code = "command_failed";
  throw error;
}

function captureCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
