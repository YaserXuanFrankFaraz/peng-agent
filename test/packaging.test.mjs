import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { dmgLayout, parseDmgOptions } from "../src/dmg.js";
import { bundleManifest, macosBundleLayout, packageMacosApp, parseBundleOptions, renderInfoPlist, verifyMacosApp } from "../src/macos-bundle.js";

test("plans a Peng DMG with an Applications shortcut", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-dmg-plan-test-"));
  const options = parseDmgOptions(["--app", "dist/Peng.app", "--out", "dist/Peng-v0.1.0.dmg", "--staging", "tmp/image"], workspace, {});
  const layout = dmgLayout(options);

  assert.equal(options.appPath, path.join(workspace, "dist", "Peng.app"));
  assert.equal(options.outPath, path.join(workspace, "dist", "Peng-v0.1.0.dmg"));
  assert.equal(options.volumeName, "Peng v0.1.0");
  assert.equal(layout.stagingDir, path.join(workspace, "tmp", "image"));
  assert.equal(layout.appPath, path.join(layout.stagingDir, "Peng.app"));
  assert.equal(layout.applicationsLink, path.join(layout.stagingDir, "Applications"));
});

test("packages the Peng v0.1.0 macOS app bundle layout", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-bundle-test-"));
  const webui = path.join(workspace, "webui");
  await mkdir(webui, { recursive: true });
  await writeFile(path.join(webui, "index.html"), "<title>Peng</title>", "utf8");
  await mkdir(path.join(workspace, "bin"), { recursive: true });
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "resources"), { recursive: true });
  await writeFile(path.join(workspace, "resources", "peng.icns"), "test-icon", "utf8");
  await writeFile(path.join(workspace, "src", "server-entry.js"), "export const CRAFT_SERVER_MANIFEST = { name: 'craft-server' };\n", "utf8");
  await writeFile(path.join(workspace, "bin", "craft-server.mjs"), "#!/usr/bin/env node\nimport { CRAFT_SERVER_MANIFEST } from '../src/server-entry.js';\nif (process.argv.includes('--manifest')) console.log(JSON.stringify(CRAFT_SERVER_MANIFEST));\n", "utf8");

  const outDir = path.join(workspace, "dist", "Peng.app");
  const result = await packageMacosApp({
    args: ["--out", outDir, "--webui", webui],
    cwd: workspace,
    stdout: () => {}
  });
  const layout = macosBundleLayout(result.options);

  assert.equal(result.manifest.name, "Peng");
  assert.equal(result.manifest.version, "0.1.0");
  assert.equal(result.manifest.bundleIdentifier, "com.yaserxuanfrankfaraz.peng");
  assert.equal(result.options.executableName, "Peng");
  assert.deepEqual(bundleManifest(result.options, layout).urlSchemes, ["peng", "craftagents"]);
  assert.equal(bundleManifest(result.options, layout).urlSchemes.includes("peng"), true);
  assert.equal(bundleManifest(result.options, layout).urlSchemes.includes("craftagents"), true);
  assert.equal(bundleManifest(result.options, layout).ui.mode, "native-wkwebview");
  assert.equal(bundleManifest(result.options, layout).ui.externalBrowser, false);
  assert.match(await readFile(layout.infoPlist, "utf8"), /<string>com\.yaserxuanfrankfaraz\.peng<\/string>/);
  assert.match(await readFile(layout.infoPlist, "utf8"), /<string>Peng<\/string>/);
  assert.match(await readFile(layout.infoPlist, "utf8"), /<string>craftagents<\/string>/);
  assert.match(await readFile(layout.infoPlist, "utf8"), /<key>CFBundleIconFile<\/key>/);
  assert.equal(await readFile(layout.iconFile, "utf8"), "test-icon");
  assert.match(await readFile(path.join(layout.webuiDir, "index.html"), "utf8"), /Peng/);
  assert.match(await readFile(path.join(layout.runtimeWebuiDir, "index.html"), "utf8"), /Peng/);
  await access(layout.launcher, constants.X_OK);
  assert.match(await readFile(layout.manifest, "utf8"), /Contents\/MacOS\/Peng/);
  assert.equal(JSON.parse(await readFile(layout.manifest, "utf8")).server.node, path.relative(result.options.outDir, layout.nodeBinary));
  assert.equal(JSON.parse((await capture([layout.launcher, "--manifest"])).stdout).name, "peng-app");
});

test("plans macOS app bundle options without writing files", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-bundle-plan-test-"));
  const options = parseBundleOptions(["--out", "dist/App.app", "--name", "Peng Dev", "--sign", "--verify"], workspace, {});
  const lines = [];
  const result = await packageMacosApp({
    args: ["--out", "dist/App.app", "--name", "Peng Dev", "--dry-run"],
    cwd: workspace,
    env: {},
    stdout: (line) => lines.push(line)
  });

  assert.equal(options.outDir, path.join(workspace, "dist", "App.app"));
  assert.equal(options.appName, "Peng Dev");
  assert.equal(options.sign, true);
  assert.equal(options.verify, true);
  assert.equal(result.skipped, true);
  assert.equal(JSON.parse(lines[0]).options.appName, "Peng Dev");
  assert.match(renderInfoPlist(options), /<string>Peng Dev<\/string>/);
});

test("defaults macOS bundle inputs to imported resources and webui when present", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-imported-bundle-defaults-"));
  await mkdir(path.join(workspace, "resources", "webui", "assets"), { recursive: true });
  await writeFile(path.join(workspace, "resources", "webui", "index.html"), "<title>Imported Peng</title>", "utf8");
  await writeFile(path.join(workspace, "resources", "webui", "assets", "main-test.js"), "console.log('imported')\n", "utf8");
  await writeFile(path.join(workspace, "resources", "config-defaults.json"), "{\"defaults\":true}\n", "utf8");
  await mkdir(path.join(workspace, "bin"), { recursive: true });
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "server-entry.js"), "export const CRAFT_SERVER_MANIFEST = { name: 'craft-server' };\n", "utf8");
  await writeFile(path.join(workspace, "bin", "craft-server.mjs"), "#!/usr/bin/env node\nimport { CRAFT_SERVER_MANIFEST } from '../src/server-entry.js';\nif (process.argv.includes('--manifest')) console.log(JSON.stringify(CRAFT_SERVER_MANIFEST));\n", "utf8");

  const options = parseBundleOptions(["--out", "dist/Peng.app"], workspace, {});
  const result = await packageMacosApp({
    args: ["--out", "dist/Peng.app"],
    cwd: workspace,
    env: {},
    stdout: () => {}
  });
  const layout = macosBundleLayout(result.options);

  assert.equal(options.webuiDir, path.join(workspace, "resources", "webui"));
  assert.equal(options.resourcesDir, path.join(workspace, "resources"));
  assert.match(await readFile(path.join(layout.webuiDir, "index.html"), "utf8"), /Imported Peng/);
  assert.match(await readFile(path.join(layout.runtimeWebuiDir, "assets", "main-test.js"), "utf8"), /imported/);
  assert.match(await readFile(path.join(layout.sharedResourcesDir, "config-defaults.json"), "utf8"), /defaults/);
});

test("ad-hoc signs and verifies a packaged macOS app bundle", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-signed-bundle-test-"));
  const webui = path.join(workspace, "webui");
  await mkdir(webui, { recursive: true });
  await writeFile(path.join(webui, "index.html"), "<title>Peng</title>", "utf8");
  await mkdir(path.join(workspace, "bin"), { recursive: true });
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "server-entry.js"), "export const CRAFT_SERVER_MANIFEST = { name: 'craft-server' };\n", "utf8");
  await writeFile(path.join(workspace, "bin", "craft-server.mjs"), "#!/usr/bin/env node\nimport { CRAFT_SERVER_MANIFEST } from '../src/server-entry.js';\nif (process.argv.includes('--manifest')) console.log(JSON.stringify(CRAFT_SERVER_MANIFEST));\n", "utf8");

  const result = await packageMacosApp({
    args: ["--out", path.join(workspace, "dist", "Peng.app"), "--webui", webui, "--sign", "--verify"],
    cwd: workspace,
    stdout: () => {}
  });

  assert.equal(result.signature.ok, true);
  assert.equal(result.signature.identity, "-");
  assert.equal(result.verification.ok, true);
  assert.equal(JSON.parse((await capture([macosBundleLayout(result.options).launcher, "--manifest"])).stdout).name, "peng-app");
  assert.equal((await verifyMacosApp(result.options.outDir)).ok, true);
});

function capture(command) {
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
