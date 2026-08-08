import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nativeHostSource = fileURLToPath(new URL("../native/PengApp.swift", import.meta.url));

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
  const bunBinary = readFlag(args, "--bun-binary") ?? env.PENG_BUN_BINARY ?? env.BUN_BINARY ?? null;
  const nodeBinary = readFlag(args, "--node-binary") ?? env.PENG_NODE_BINARY ?? (bunBinary ? null : process.execPath);
  return {
    ...MACOS_BUNDLE_DEFAULTS,
    appName: readFlag(args, "--name") ?? env.PENG_APP_NAME ?? MACOS_BUNDLE_DEFAULTS.appName,
    bundleIdentifier: readFlag(args, "--bundle-id") ?? env.PENG_BUNDLE_ID ?? MACOS_BUNDLE_DEFAULTS.bundleIdentifier,
    version: readFlag(args, "--version") ?? env.PENG_APP_VERSION ?? MACOS_BUNDLE_DEFAULTS.version,
    executableName: readFlag(args, "--executable") ?? env.PENG_EXECUTABLE_NAME ?? MACOS_BUNDLE_DEFAULTS.executableName,
    outDir: path.isAbsolute(outDir) ? outDir : path.join(cwd, outDir),
    serverBinary: readFlag(args, "--server-binary"),
    bunBinary,
    nodeBinary,
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
  await buildNativeLauncher(layout.launcher);
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
    await embedNodeRuntime(path.resolve(cwd, options.nodeBinary), layout);
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
  if (result.code !== 0 && isRecoverableXattrVerificationFailure(result)) {
    const fallback = await signMacosAppFromTemporaryCopy(appPath, identity);
    return {
      ...fallback,
      originalPath: appPath,
      originalFailure: result,
      recoveredViaTemporaryCopy: fallback.ok
    };
  }
  return {
    ok: result.code === 0,
    identity,
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function signMacosAppFromTemporaryCopy(appPath, identity) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "peng-codesign-"));
  const tempApp = path.join(tempRoot, path.basename(appPath));
  try {
    await cp(appPath, tempApp, { recursive: true });
    await cleanMacosSigningAttributes(tempApp);
    const result = await captureCommand(["codesign", "--force", "--deep", "--sign", identity, tempApp]);
    if (result.code !== 0) {
      return {
        ok: false,
        identity,
        code: result.code,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr
      };
    }
    await rm(appPath, { recursive: true, force: true });
    await cp(tempApp, appPath, { recursive: true });
    return {
      ok: true,
      identity,
      code: result.code,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
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
    nodeLibrariesDir: path.join(resourcesRoot, "lib"),
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
  <key>NSHighResolutionCapable</key>
  <true/>
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
DATA_DIR=$(printenv PENG_DATA_DIR || true)
[ -n "$DATA_DIR" ] || DATA_DIR="$HOME/Library/Application Support/Peng"
LOG_DIR="$HOME/Library/Logs/Peng"
PID_FILE="$DATA_DIR/server.pid"
URL_FILE="$DATA_DIR/server.url"
LOG_FILE="$LOG_DIR/server.log"
mkdir -p "$DATA_DIR" "$LOG_DIR"

run_server() {
  cd "$SERVER_DIR"
  if [ -x "$SERVER_DIR/craft-server" ]; then
    exec "$SERVER_DIR/craft-server" "$@"
  fi
  if [ -x "$SERVER_DIR/bun" ]; then
    exec "$SERVER_DIR/bun" "$SERVER_DIR/bin/craft-server.mjs" "$@"
  fi
  if [ -x "$SERVER_DIR/node" ]; then
    exec "$SERVER_DIR/node" "$SERVER_DIR/bin/craft-server.mjs" "$@"
  fi
  NODE_RUNTIME=$(command -v node || true)
  [ -n "$NODE_RUNTIME" ] || { echo "Peng could not find a JavaScript runtime." >&2; exit 1; }
  exec "$NODE_RUNTIME" "$SERVER_DIR/bin/craft-server.mjs" "$@"
}

is_running() {
  [ -f "$PID_FILE" ] || return 1
  SERVER_PID=$(cat "$PID_FILE")
  [ -n "$SERVER_PID" ] || return 1
  kill -0 "$SERVER_PID" 2>/dev/null
}

read_url() {
  [ -f "$URL_FILE" ] || return 1
  cat "$URL_FILE"
}

# LaunchServices can pass a process serial number when Finder opens a shell app.
case "$#" in
  0) ;;
  *) case "$1" in -psn_*) set -- ;; esac ;;
esac

if [ "$#" -eq 1 ] && [ "$1" = "--stop" ]; then
  if is_running; then
    kill "$SERVER_PID" 2>/dev/null || true
    i=0
    while kill -0 "$SERVER_PID" 2>/dev/null && [ "$i" -lt 20 ]; do
      sleep 0.1
      i=$((i + 1))
    done
    echo "Peng server stopped."
  else
    echo "Peng server is not running."
  fi
  rm -f "$PID_FILE" "$URL_FILE"
  exit 0
fi

if [ "$#" -eq 1 ] && [ "$1" = "--status" ]; then
  if is_running; then
    EXISTING_URL=$(read_url || true)
    if [ -n "$EXISTING_URL" ] && /usr/bin/curl -fsS "$EXISTING_URL/health" >/dev/null 2>&1; then
      echo "Peng is running at $EXISTING_URL"
      exit 0
    fi
  fi
  echo "Peng server is not running."
  exit 0
fi

# Explicit arguments keep the original headless server contract for CLI and diagnostics.
if [ "$#" -gt 0 ]; then
  run_server "$@"
fi

if is_running; then
  EXISTING_URL=$(read_url || true)
  if [ -n "$EXISTING_URL" ]; then
    echo "Peng server is already running at $EXISTING_URL"
    exit 0
  fi
fi
rm -f "$PID_FILE" "$URL_FILE"

HOST=$(printenv PENG_HOST || true)
[ -n "$HOST" ] || HOST=127.0.0.1
PORT=$(printenv PENG_PORT || true)
[ -n "$PORT" ] || PORT=0
WORKSPACE=$(printenv PENG_WORKSPACE || true)
[ -n "$WORKSPACE" ] || WORKSPACE="$HOME"
cd "$SERVER_DIR"
if [ -x "$SERVER_DIR/craft-server" ]; then
  nohup "$SERVER_DIR/craft-server" --host "$HOST" --port "$PORT" --workspace "$WORKSPACE" --json >"$LOG_FILE" 2>&1 < /dev/null &
elif [ -x "$SERVER_DIR/bun" ]; then
  nohup "$SERVER_DIR/bun" "$SERVER_DIR/bin/craft-server.mjs" --host "$HOST" --port "$PORT" --workspace "$WORKSPACE" --json >"$LOG_FILE" 2>&1 < /dev/null &
elif [ -x "$SERVER_DIR/node" ]; then
  nohup "$SERVER_DIR/node" "$SERVER_DIR/bin/craft-server.mjs" --host "$HOST" --port "$PORT" --workspace "$WORKSPACE" --json >"$LOG_FILE" 2>&1 < /dev/null &
else
  NODE_RUNTIME=$(command -v node || true)
  [ -n "$NODE_RUNTIME" ] || { echo "Peng could not find a JavaScript runtime." >&2; exit 1; }
  nohup "$NODE_RUNTIME" "$SERVER_DIR/bin/craft-server.mjs" --host "$HOST" --port "$PORT" --workspace "$WORKSPACE" --json >"$LOG_FILE" 2>&1 < /dev/null &
fi
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$PID_FILE"

URL=""
i=0
while [ "$i" -lt 100 ]; do
  if [ -f "$LOG_FILE" ]; then
    URL=$(sed -n 's/.*"url":"\\([^"]*\\)".*/\\1/p' "$LOG_FILE" | tail -n 1 || true)
  fi
  if [ -n "$URL" ] && /usr/bin/curl -fsS "$URL/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    cat "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE" "$URL_FILE"
    exit 1
  fi
  sleep 0.1
  i=$((i + 1))
done

if [ -z "$URL" ]; then
  echo "Peng server did not become ready. See $LOG_FILE" >&2
  exit 1
fi
printf '%s\n' "$URL" > "$URL_FILE"
# The native WKWebView host owns the UI; this legacy shell template never opens a browser.
echo "Peng is running at $URL"
`;
}

async function buildNativeLauncher(destination) {
  if (process.platform !== "darwin") {
    throw new Error("Peng native macOS packaging requires macOS.");
  }
  const architecture = process.arch === "x64" ? "x86_64" : "arm64";
  const result = await captureCommand([
    "swiftc",
    "-O",
    "-module-cache-path",
    path.join(tmpdir(), "peng-swift-module-cache"),
    "-target",
    `${architecture}-apple-macosx13.0`,
    "-framework",
    "AppKit",
    "-framework",
    "WebKit",
    "-o",
    destination,
    nativeHostSource
  ]);
  if (result.code !== 0) {
    const error = new Error(`Unable to build Peng native host: ${result.stderr || result.stdout || result.code}`);
    error.code = "native_host_build_failed";
    throw error;
  }
  await chmod(destination, 0o755);
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
      nodeLibraries: options.nodeBinary ? path.relative(options.outDir, layout.nodeLibrariesDir) : null,
      entrypoint: path.relative(options.outDir, layout.serverEntrypoint),
      webui: path.relative(options.outDir, layout.webuiDir),
      runtimeWebui: path.relative(options.outDir, layout.runtimeWebuiDir),
      source: path.relative(options.outDir, layout.serverSourceDir)
    },
    ui: {
      mode: "native-wkwebview",
      externalBrowser: false
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

async function embedNodeRuntime(sourceNode, layout) {
  await mkdir(layout.nodeLibrariesDir, { recursive: true });
  const queue = [sourceNode];
  const seen = new Set();
  const dependencies = [];

  while (queue.length > 0) {
    const source = queue.shift();
    const key = await canonicalPath(source);
    if (seen.has(key)) continue;
    seen.add(key);
    const libraries = await macosDynamicLibraries(source);
    for (const reference of libraries) {
      const resolved = await resolveMacosLibrary(reference, source);
      if (!resolved || isSystemMacosLibrary(resolved)) continue;
      const dependency = { source: resolved, reference, owner: source };
      dependencies.push(dependency);
      queue.push(resolved);
    }
  }

  const copied = new Map();
  for (const dependency of dependencies) {
    const name = path.basename(dependency.source);
    if (name === path.basename(sourceNode) || copied.has(name)) continue;
    const destination = path.join(layout.nodeLibrariesDir, name);
    await cp(dependency.source, destination, { dereference: true });
    await chmod(destination, 0o755);
    copied.set(name, destination);
  }

  for (const dependency of dependencies) {
    const name = path.basename(dependency.source);
    if (!copied.has(name)) continue;
    const owner = dependency.owner === sourceNode
      ? `@loader_path/../lib/${name}`
      : `@loader_path/${name}`;
    await runCommand(["install_name_tool", "-change", dependency.reference, owner, dependency.owner === sourceNode ? layout.nodeBinary : path.join(layout.nodeLibrariesDir, path.basename(dependency.owner))]);
  }
  for (const destination of copied.values()) {
    await runCommand(["install_name_tool", "-id", `@rpath/${path.basename(destination)}`, destination]);
  }
}

async function macosDynamicLibraries(binaryPath) {
  const result = await captureCommand(["otool", "-L", binaryPath]);
  if (result.code !== 0) {
    const error = new Error(`Unable to inspect macOS runtime dependencies: ${result.stderr || result.stdout || result.code}`);
    error.code = "runtime_dependency_inspection_failed";
    throw error;
  }
  return result.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" (compatibility")[0])
    .filter(Boolean);
}

async function resolveMacosLibrary(reference, owner) {
  const candidates = [];
  if (reference.startsWith("@loader_path/")) {
    candidates.push(path.resolve(path.dirname(owner), reference.slice("@loader_path/".length)));
  } else if (reference.startsWith("@executable_path/")) {
    candidates.push(path.resolve(path.dirname(owner), reference.slice("@executable_path/".length)));
  } else if (reference.startsWith("@rpath/")) {
    const relative = reference.slice("@rpath/".length);
    candidates.push(path.resolve(path.dirname(owner), relative));
    candidates.push(path.resolve(path.dirname(owner), "../lib", relative));
  } else {
    candidates.push(reference);
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return canonicalPath(candidate);
  }
  return null;
}

async function canonicalPath(value) {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function isSystemMacosLibrary(libraryPath) {
  return libraryPath.startsWith("/usr/lib/") ||
    libraryPath.startsWith("/System/Library/") ||
    libraryPath.startsWith("/System/Applications/");
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
