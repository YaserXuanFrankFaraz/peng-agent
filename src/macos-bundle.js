import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const MACOS_BUNDLE_DEFAULTS = {
  appName: "Peng",
  bundleIdentifier: "com.yaserxuanfrankfaraz.peng",
  version: "0.1.0",
  executableName: "Peng",
  urlSchemes: ["peng", "craftagents"]
};

export function parseBundleOptions(args = [], cwd = process.cwd(), env = process.env) {
  const outDir = readFlag(args, "--out") ?? env.PENG_APP_OUT ?? path.join(cwd, "dist", "Peng.app");
  const defaultResourcesDir = path.join(cwd, "resources");
  const importedWebuiDir = path.join(defaultResourcesDir, "webui");
  const defaultIconPath = path.join(defaultResourcesDir, "peng.icns");
  const iconPath = readFlag(args, "--icon") ?? env.PENG_APP_ICON ?? (existsSync(defaultIconPath) ? defaultIconPath : null);
  return {
    ...MACOS_BUNDLE_DEFAULTS,
    appName: readFlag(args, "--name") ?? env.PENG_APP_NAME ?? MACOS_BUNDLE_DEFAULTS.appName,
    bundleIdentifier: readFlag(args, "--bundle-id") ?? env.PENG_BUNDLE_ID ?? MACOS_BUNDLE_DEFAULTS.bundleIdentifier,
    version: readFlag(args, "--version") ?? env.PENG_APP_VERSION ?? MACOS_BUNDLE_DEFAULTS.version,
    executableName: readFlag(args, "--executable") ?? env.PENG_EXECUTABLE_NAME ?? MACOS_BUNDLE_DEFAULTS.executableName,
    outDir: path.isAbsolute(outDir) ? outDir : path.join(cwd, outDir),
    serverBinary: readFlag(args, "--server-binary"),
    bunBinary: readFlag(args, "--bun-binary") ?? env.PENG_BUN_BINARY ?? env.BUN_BINARY ?? findExecutable("bun", env),
    nodeBinary: readFlag(args, "--node-binary") ?? env.PENG_NODE_BINARY ?? (findExecutable("bun", env) ? null : process.execPath),
    webuiDir: readFlag(args, "--webui") ?? (existsSync(importedWebuiDir) ? importedWebuiDir : path.join(cwd, "webui")),
    resourcesDir: readFlag(args, "--resources") ?? (existsSync(defaultResourcesDir) ? defaultResourcesDir : null),
    iconPath: iconPath ? (path.isAbsolute(iconPath) ? iconPath : path.join(cwd, iconPath)) : null,
    sign: hasFlag(args, "--sign"),
    identity: readFlag(args, "--identity") ?? env.PENG_CODESIGN_IDENTITY ?? "-",
    verify: hasFlag(args, "--verify"),
    clean: !hasFlag(args, "--no-clean"),
    dryRun: hasFlag(args, "--dry-run")
  };
}

export async function packageMacosApp({ args = [], cwd = process.cwd(), env = process.env, stdout = console.log } = {}) {
  const options = parseBundleOptions(args, cwd, env);
  const layout = macosBundleLayout(options);
  if (options.dryRun) {
    const plan = { options, layout, skipped: true };
    stdout(JSON.stringify(plan));
    return plan;
  }

  if (options.clean) await rm(options.outDir, { recursive: true, force: true });
  await mkdir(layout.macosDir, { recursive: true });
  await mkdir(layout.serverDir, { recursive: true });
  await mkdir(layout.sharedResourcesDir, { recursive: true });
  await mkdir(layout.serverBinDir, { recursive: true });

  await writeFile(layout.infoPlist, renderInfoPlist(options), "utf8");
  await writeFile(layout.pkgInfo, "APPL????", "utf8");
  await writeFile(layout.launcher, renderLauncherScript(), "utf8");
  await chmod(layout.launcher, 0o755);
  await copyWebui(options.webuiDir, layout.webuiDir, options.appName);
  await copyWebui(options.webuiDir, layout.runtimeWebuiDir, options.appName);
  await cp(path.join(cwd, "src"), layout.serverSourceDir, { recursive: true });
  if (options.resourcesDir) await copyIfExists(options.resourcesDir, layout.sharedResourcesDir);
  if (options.iconPath) await copyIfExists(options.iconPath, layout.iconFile);
  if (options.serverBinary) {
    await cp(path.resolve(cwd, options.serverBinary), layout.serverBinary);
    await chmod(layout.serverBinary, 0o755);
  } else {
    await cp(path.join(cwd, "bin", "craft-server.mjs"), layout.serverEntrypoint);
  }
  if (options.nodeBinary) {
    await cp(path.resolve(cwd, options.nodeBinary), layout.nodeBinary);
    await chmod(layout.nodeBinary, 0o755);
  }
  if (options.bunBinary) {
    await cp(path.resolve(cwd, options.bunBinary), layout.bunBinary);
    await chmod(layout.bunBinary, 0o755);
  }
  await writeFile(layout.manifest, `${JSON.stringify(bundleManifest(options, layout), null, 2)}\n`, "utf8");
  const signature = options.sign ? await signMacosApp(options.outDir, { identity: options.identity }) : null;
  if (signature && !signature.ok) {
    const error = new Error(`App bundle signing failed: ${signature.stderr || signature.stdout || signature.code}`);
    error.code = "signing_failed";
    throw error;
  }
  const verification = options.verify ? await verifyMacosApp(options.outDir) : null;

  const result = { options, layout, manifest: bundleManifest(options, layout), signature, verification, skipped: false };
  stdout(JSON.stringify({
    app: options.outDir,
    executable: layout.launcher,
    status: verification && !verification.ok ? "packaged_unverified" : "packaged",
    signature: signature ?? undefined,
    verification: verification ?? undefined
  }));
  if (verification && !verification.ok) {
    const error = new Error(`App bundle failed verification: ${verification.stderr || verification.stdout || verification.code}`);
    error.code = "verification_failed";
    throw error;
  }
  return result;
}

export async function signMacosApp(appPath, { identity = "-" } = {}) {
  await cleanMacosSigningAttributes(appPath);
  const result = await captureCommand(["codesign", "--force", "--deep", "--sign", identity, appPath]);
  return {
    ok: result.code === 0,
    identity,
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export async function verifyMacosApp(appPath) {
  await cleanMacosSigningAttributes(appPath);
  const result = await captureCommand(["codesign", "--verify", "--deep", "--strict", "--verbose=2", appPath]);
  if (result.code !== 0 && isRecoverableXattrVerificationFailure(result)) {
    const fallback = await verifyMacosAppFromTemporaryCopy(appPath);
    return {
      ...fallback,
      originalPath: appPath,
      originalFailure: result,
      recoveredViaTemporaryCopy: fallback.ok
    };
  }
  return {
    ok: result.code === 0,
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    verifiedPath: appPath
  };
}

export async function cleanMacosSigningAttributes(appPath) {
  await runCommand(["xattr", "-cr", appPath]);
  for (const attribute of ["com.apple.FinderInfo", "com.apple.fileprovider.fpfs#P", "com.apple.provenance"]) {
    await captureCommand(["xattr", "-d", attribute, appPath]);
  }
  // File Provider can restore bundle-root metadata between recursive cleanup and codesign.
  await captureCommand(["xattr", "-c", appPath]);
}

async function verifyMacosAppFromTemporaryCopy(appPath) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "peng-codesign-verify-"));
  const tempApp = path.join(tempRoot, path.basename(appPath));
  await cp(appPath, tempApp, { recursive: true });
  await cleanMacosSigningAttributes(tempApp);
  const result = await captureCommand(["codesign", "--verify", "--deep", "--strict", "--verbose=2", tempApp]);
  await rm(tempRoot, { recursive: true, force: true });
  return {
    ok: result.code === 0,
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    verifiedPath: tempApp
  };
}

function isRecoverableXattrVerificationFailure(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  return /resource fork|Finder information|FinderInfo|invalid attached data/i.test(text);
}

export function macosBundleLayout(options) {
  const contentsDir = path.join(options.outDir, "Contents");
  const resourcesRoot = path.join(contentsDir, "Resources");
  const serverDir = path.join(resourcesRoot, "server");
  return {
    contentsDir,
    macosDir: path.join(contentsDir, "MacOS"),
    resourcesRoot,
    serverDir,
    serverBinDir: path.join(serverDir, "bin"),
    serverSourceDir: path.join(serverDir, "src"),
    webuiDir: path.join(serverDir, "resources", "webui"),
    runtimeWebuiDir: path.join(serverDir, "webui"),
    sharedResourcesDir: path.join(resourcesRoot, "resources"),
    infoPlist: path.join(contentsDir, "Info.plist"),
    pkgInfo: path.join(contentsDir, "PkgInfo"),
    launcher: path.join(contentsDir, "MacOS", options.executableName),
    serverBinary: path.join(serverDir, "craft-server"),
    bunBinary: path.join(serverDir, "bun"),
    nodeBinary: path.join(serverDir, "node"),
    serverEntrypoint: path.join(serverDir, "bin", "craft-server.mjs"),
    iconFile: path.join(resourcesRoot, "Peng.icns"),
    manifest: path.join(serverDir, "bundle-manifest.json")
  };
}

export function renderInfoPlist(options) {
  const schemes = options.urlSchemes.map((scheme) => `          <string>${xmlEscape(scheme)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${xmlEscape(options.appName)}</string>
  <key>CFBundleExecutable</key>
  <string>${xmlEscape(options.executableName)}</string>
  <key>CFBundleIdentifier</key>
  <string>${xmlEscape(options.bundleIdentifier)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${xmlEscape(options.appName)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
${options.iconPath ? `  <key>CFBundleIconFile</key>\n  <string>Peng.icns</string>\n` : ""}
  <key>CFBundleShortVersionString</key>
  <string>${xmlEscape(options.version)}</string>
  <key>CFBundleVersion</key>
  <string>${xmlEscape(options.version)}</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>${xmlEscape(options.bundleIdentifier)}</string>
      <key>CFBundleURLSchemes</key>
      <array>
${schemes}
      </array>
    </dict>
  </array>
</dict>
</plist>
`;
}

export function renderLauncherScript() {
  return `#!/bin/sh
set -eu
APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SERVER_DIR="$APP_DIR/Resources/server"
if [ -x "$SERVER_DIR/craft-server" ]; then
  cd "$SERVER_DIR"
  exec "$SERVER_DIR/craft-server" "$@"
fi
cd "$SERVER_DIR"
if [ -x "$SERVER_DIR/bun" ]; then
  exec "$SERVER_DIR/bun" "$SERVER_DIR/bin/craft-server.mjs" "$@"
fi
if [ -x "$SERVER_DIR/node" ]; then
  exec "$SERVER_DIR/node" "$SERVER_DIR/bin/craft-server.mjs" "$@"
fi
exec node "$SERVER_DIR/bin/craft-server.mjs" "$@"
`;
}

export function bundleManifest(options, layout) {
  return {
    name: options.appName,
    bundleIdentifier: options.bundleIdentifier,
    version: options.version,
    executable: path.relative(options.outDir, layout.launcher),
    server: {
      binary: options.serverBinary ? path.relative(options.outDir, layout.serverBinary) : null,
      bun: options.bunBinary ? path.relative(options.outDir, layout.bunBinary) : null,
      node: options.nodeBinary ? path.relative(options.outDir, layout.nodeBinary) : null,
      entrypoint: path.relative(options.outDir, layout.serverEntrypoint),
      webui: path.relative(options.outDir, layout.webuiDir),
      runtimeWebui: path.relative(options.outDir, layout.runtimeWebuiDir),
      source: path.relative(options.outDir, layout.serverSourceDir)
    },
    icon: options.iconPath ? path.relative(options.outDir, layout.iconFile) : null,
    urlSchemes: options.urlSchemes
  };
}

export function bundleHelp() {
  return `package-macos-app

Usage:
  package-macos-app [--out dist/Peng.app] [--server-binary dist/craft-server] [--bun-binary /path/to/bun] [--node-binary /path/to/node] [--webui webui] [--resources <dir>] [--icon resources/peng.icns] [--name Peng] [--version 0.1.0] [--sign] [--identity -] [--verify] [--dry-run]

Environment:
  PENG_APP_OUT         Output .app path
  PENG_APP_NAME        Display name override
  PENG_BUNDLE_ID       Bundle identifier override
  PENG_APP_VERSION     Version override
  PENG_BUN_BINARY      Bun executable to embed when using the script entrypoint
  PENG_NODE_BINARY     Node executable to embed when using the script entrypoint
  PENG_CODESIGN_IDENTITY  Codesign identity override, defaults to ad-hoc "-"

  PENG_*             Peng packaging environment variables.
`;
}

function runCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(`${command[0]} exited with code ${code}`);
      error.code = "command_failed";
      reject(error);
    });
  });
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

async function copyIfExists(source, destination) {
  try {
    await readFile(source);
  } catch (error) {
    if (error.code !== "EISDIR") throw error;
  }
  await cp(source, destination, { recursive: true });
}

async function copyWebui(source, destination, appName) {
  await copyIfExists(source, destination);
  await brandWebuiTree(destination, appName);
}

async function brandWebuiTree(root, appName) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await brandWebuiTree(target, appName);
      continue;
    }
    if (!/\.(?:css|html|js|json|svg|txt|webmanifest)$/i.test(entry.name)) continue;
    const source = await readFile(target, "utf8");
    const branded = source.replaceAll("Peng", appName);
    if (branded !== source) await writeFile(target, branded, "utf8");
  }
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function findExecutable(name, env = process.env) {
  const pathValue = env.PATH ?? process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
