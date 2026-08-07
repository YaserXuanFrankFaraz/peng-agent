import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditYuuMiraBundle, inspectWebuiRpcCoverage } from "../src/bundle-audit.js";

test("audits installed bundle shape against clone resources", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-bundle-audit-"));
  const appPath = path.join(workspace, "YuuMira.app");
  const appResources = path.join(appPath, "Contents", "Resources");
  const appServer = path.join(appResources, "server");
  const appShared = path.join(appResources, "resources");
  const cloneResources = path.join(workspace, "resources");
  await mkdir(path.join(appPath, "Contents"), { recursive: true });
  await mkdir(path.join(appServer, "bin"), { recursive: true });
  await mkdir(path.join(appServer, "vendor", "bun"), { recursive: true });
  await mkdir(path.join(appServer, "resources", "webui", "assets"), { recursive: true });
  await mkdir(path.join(appShared, "bin"), { recursive: true });
  await mkdir(path.join(appShared, "scripts"), { recursive: true });
  await mkdir(path.join(appShared, "tool-icons"), { recursive: true });
  await mkdir(path.join(appShared, "themes"), { recursive: true });
  await mkdir(path.join(appShared, "docs"), { recursive: true });
  await mkdir(path.join(appShared, "permissions"), { recursive: true });
  await mkdir(path.join(appShared, "release-notes"), { recursive: true });
  await mkdir(path.join(appShared, "craft-logos"), { recursive: true });
  await writeFile(path.join(appPath, "Contents", "Info.plist"), `<?xml version="1.0"?>
<plist><dict>
<key>CFBundleIdentifier</key><string>app.yuuone.yuumira</string>
<key>CFBundleExecutable</key><string>craft-agents-tauri</string>
<key>CFBundleShortVersionString</key><string>0.11.11</string>
<key>CFBundleURLSchemes</key><array><string>yuumira</string><string>craftagents</string></array>
</dict></plist>
`, "utf8");
  await writeFile(path.join(appServer, "bin", "craft-server"), "server\n", "utf8");
  await writeFile(path.join(appServer, "vendor", "bun", "bun"), "bun\n", "utf8");
  await chmod(path.join(appServer, "bin", "craft-server"), 0o755);
  await writeFile(path.join(appServer, "package.json"), JSON.stringify({
    name: "craft-server-dist",
    version: "0.11.11",
    private: true,
    workspaces: ["packages/*"]
  }), "utf8");
  for (const [directory, name] of [
    ["core", "@craft-agent/core"],
    ["messaging-gateway", "@craft-agent/messaging-gateway"],
    ["messaging-whatsapp-worker", "@craft-agent/messaging-whatsapp-worker"],
    ["pi-agent-server", "@craft-agent/pi-agent-server"],
    ["server", "@craft-agent/server"],
    ["server-core", "@craft-agent/server-core"],
    ["session-tools-core", "@craft-agent/session-tools-core"],
    ["shared", "@craft-agent/shared"]
  ]) {
    await mkdir(path.join(appServer, "packages", directory), { recursive: true });
    await writeFile(path.join(appServer, "packages", directory, "package.json"), JSON.stringify({
      name,
      version: "0.11.11",
      license: "Apache-2.0",
      exports: { ".": "./dist/index.js" }
    }), "utf8");
  }
  await writeFile(path.join(appServer, "resources", "webui", "index.html"), "<title>YuuMira</title>", "utf8");
  await writeFile(path.join(appServer, "resources", "webui", "assets", "main.js"), "console.log('app')", "utf8");
  await writeFile(path.join(appShared, "tool-icons", "terminal.svg"), "<svg />", "utf8");
  await writeFile(path.join(appShared, "themes", "default.json"), "{}", "utf8");
  await writeFile(path.join(appShared, "docs", "skills.md"), "# Skills\n", "utf8");
  await writeFile(path.join(appShared, "permissions", "default.json"), "{}", "utf8");
  await writeFile(path.join(appShared, "release-notes", "0.11.11.md"), "# Release\n", "utf8");
  await writeFile(path.join(appShared, "craft-logos", "craft_logo_black.png"), "logo", "utf8");
  await writeFile(path.join(appShared, "config-defaults.json"), "{}", "utf8");
  await writeFile(path.join(appShared, "source.png"), "source", "utf8");

  await mkdir(path.join(cloneResources, "webui", "assets"), { recursive: true });
  await mkdir(path.join(cloneResources, "bin"), { recursive: true });
  await mkdir(path.join(cloneResources, "scripts"), { recursive: true });
  await mkdir(path.join(cloneResources, "tool-icons"), { recursive: true });
  await mkdir(path.join(cloneResources, "themes"), { recursive: true });
  await mkdir(path.join(cloneResources, "docs"), { recursive: true });
  await mkdir(path.join(cloneResources, "permissions"), { recursive: true });
  await mkdir(path.join(cloneResources, "release-notes"), { recursive: true });
  await mkdir(path.join(cloneResources, "craft-logos"), { recursive: true });
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "yuumira-cleanroom" }), "utf8");
  await writeFile(path.join(cloneResources, "webui", "index.html"), "<title>YuuMira</title>", "utf8");
  await writeFile(path.join(appServer, "resources", "webui", "assets", "main.js"), "globalThis.rpc('sessions:get')", "utf8");
  await writeFile(path.join(cloneResources, "webui", "assets", "main.js"), "globalThis.rpc('sessions:get')", "utf8");
  await writeFile(path.join(workspace, "src", "server.js"), "export function handle(channel) { return channel === \"sessions:get\"; }\n", "utf8");
  for (const helper of ["doc-diff", "docx-tool", "ical-tool", "img-tool", "markitdown", "pdf-tool", "pptx-tool", "xlsx-tool"]) {
    await writeFile(path.join(appShared, "bin", helper), "#!/bin/sh\n", "utf8");
    await writeFile(path.join(cloneResources, "bin", helper), "#!/bin/sh\n", "utf8");
  }
  for (const script of ["doc_diff.py", "docx_tool.py", "ical_tool.py", "img_tool.py", "markitdown_cli.py", "pdf_tool.py", "pptx_tool.py", "xlsx_tool.py"]) {
    await writeFile(path.join(appShared, "scripts", script), "print('ok')\n", "utf8");
    await writeFile(path.join(cloneResources, "scripts", script), "print('ok')\n", "utf8");
  }
  await writeFile(path.join(cloneResources, "tool-icons", "terminal.svg"), "<svg />", "utf8");
  await writeFile(path.join(cloneResources, "themes", "default.json"), "{}", "utf8");
  await writeFile(path.join(cloneResources, "docs", "skills.md"), "# Skills\n", "utf8");
  await writeFile(path.join(cloneResources, "permissions", "default.json"), "{}", "utf8");
  await writeFile(path.join(cloneResources, "release-notes", "0.11.11.md"), "# Release\n", "utf8");
  await writeFile(path.join(cloneResources, "craft-logos", "craft_logo_black.png"), "logo", "utf8");
  await writeFile(path.join(cloneResources, "config-defaults.json"), "{}", "utf8");
  await writeFile(path.join(cloneResources, "source.png"), "source", "utf8");

  const result = auditYuuMiraBundle({ appPath, workspace, resourceDir: cloneResources });

  assert.equal(result.app.bundleIdentifier, "app.yuuone.yuumira");
  assert.equal(result.app.executable, "craft-agents-tauri");
  assert.equal(result.app.packages.names.includes("@craft-agent/shared"), true);
  assert.equal(result.app.packages.manifests.length, 8);
  assert.equal(result.comparisons.checks.find((item) => item.id === "server.packages").ok, true);
  assert.equal(result.comparisons.checks.find((item) => item.id === "server.exports.observed").ok, true);
  assert.equal(result.comparisons.checks.find((item) => item.id === "resources.webui.rpc").ok, true);
  assert.equal(result.clone.components.webui.fileCount, 2);
  assert.deepEqual(result.clone.webuiRpcCoverage.missing, []);
  assert.equal(result.comparisons.ok, true);
});

test("tracks missing webui RPC channel coverage against server source", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-webui-rpc-"));
  const cloneResources = path.join(workspace, "resources");
  await mkdir(path.join(cloneResources, "webui", "assets"), { recursive: true });
  await mkdir(path.join(workspace, "src"), { recursive: true });
	await writeFile(path.join(cloneResources, "webui", "assets", "main.js"), `
	    send("sessions:get");
	    send("menu:newChat");
	    send("messaging:wa:startConnect");
	    send("notCraftRpc:ignored");
	  `, "utf8");
  await writeFile(path.join(workspace, "src", "server.js"), `
    export function handle(channel) {
      if (channel === "sessions:get") return [];
      if (channel.startsWith("shell:")) return {};
      return null;
    }
  `, "utf8");

  const coverage = inspectWebuiRpcCoverage({ workspace, resourceDir: cloneResources });

	  assert.deepEqual(coverage.channels, ["menu:newChat", "messaging:wa:startConnect", "sessions:get"]);
	  assert.equal(coverage.implemented, 1);
	  assert.deepEqual(coverage.missing, ["menu:newChat", "messaging:wa:startConnect"]);
	});

test("tracks installed package export coverage against clone modules", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-export-coverage-"));
  const appPath = path.join(workspace, "YuuMira.app");
  const appServer = path.join(appPath, "Contents", "Resources", "server");
  const cloneResources = path.join(workspace, "resources");
  await mkdir(path.join(appPath, "Contents"), { recursive: true });
  await mkdir(path.join(appServer, "bin"), { recursive: true });
  await mkdir(path.join(appServer, "packages", "shared"), { recursive: true });
  await mkdir(path.join(appServer, "packages", "server-core"), { recursive: true });
  await mkdir(path.join(appServer, "resources", "webui"), { recursive: true });
  await mkdir(path.join(appPath, "Contents", "Resources", "resources"), { recursive: true });
  await mkdir(path.join(cloneResources, "webui"), { recursive: true });
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(appPath, "Contents", "Info.plist"), `<?xml version="1.0"?>
<plist><dict>
<key>CFBundleIdentifier</key><string>app.yuuone.yuumira</string>
<key>CFBundleExecutable</key><string>craft-agents-tauri</string>
<key>CFBundleShortVersionString</key><string>0.11.11</string>
<key>CFBundleURLSchemes</key><array><string>yuumira</string><string>craftagents</string></array>
</dict></plist>
`, "utf8");
  await writeFile(path.join(appServer, "bin", "craft-server"), "server\n", "utf8");
  await writeFile(path.join(appServer, "package.json"), JSON.stringify({ name: "craft-server-dist", version: "0.11.11", private: true }), "utf8");
  await writeFile(path.join(appServer, "packages", "shared", "package.json"), JSON.stringify({
    name: "@craft-agent/shared",
    version: "0.11.11",
    license: "Apache-2.0",
    exports: {
      ".": "./dist/index.js",
      "./memory": "./dist/memory.js",
      "./terminal/db": "./dist/terminal/db.js",
      "./desktop/native-bridge": "./dist/desktop/native-bridge.js"
    }
  }), "utf8");
  await writeFile(path.join(appServer, "packages", "server-core", "package.json"), JSON.stringify({
    name: "@craft-agent/server-core",
    version: "0.11.11",
    license: "Apache-2.0",
    exports: {
      ".": "./dist/index.js",
      "./transport": "./dist/transport.js"
    }
  }), "utf8");
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "yuumira-cleanroom" }), "utf8");
  await writeFile(path.join(workspace, "src", "memory.js"), "export {}\n", "utf8");
  await writeFile(path.join(workspace, "src", "terminal.js"), "export {}\n", "utf8");
  await writeFile(path.join(workspace, "src", "server.js"), "export {}\n", "utf8");

  const result = auditYuuMiraBundle({ appPath, workspace, resourceDir: cloneResources });
  const shared = result.clone.exportCoverage.packages.find((pkg) => pkg.name === "@craft-agent/shared");
  const serverCore = result.clone.exportCoverage.packages.find((pkg) => pkg.name === "@craft-agent/server-core");

  assert.equal(result.clone.exportCoverage.totalExports, 6);
  assert.equal(shared.totalExports, 4);
  assert.equal(shared.exports.find((item) => item.exportPath === "./memory").matched, true);
  assert.equal(shared.exports.find((item) => item.exportPath === "./terminal/db").matched, true);
  assert.equal(shared.missingExports.includes("./desktop/native-bridge"), true);
  assert.equal(serverCore.exports.find((item) => item.exportPath === "./transport").matched, true);
});

test("flags same-count resource content drift", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-bundle-fingerprint-"));
  const appPath = path.join(workspace, "YuuMira.app");
  const appResources = path.join(appPath, "Contents", "Resources");
  const appServer = path.join(appResources, "server");
  const appShared = path.join(appResources, "resources");
  const cloneResources = path.join(workspace, "resources");
  await mkdir(path.join(appPath, "Contents"), { recursive: true });
  await mkdir(path.join(appServer, "bin"), { recursive: true });
  await mkdir(path.join(appServer, "resources", "webui"), { recursive: true });
  await mkdir(path.join(appShared, "bin"), { recursive: true });
  await mkdir(path.join(appShared, "scripts"), { recursive: true });
  await mkdir(path.join(appShared, "tool-icons"), { recursive: true });
  await mkdir(path.join(appShared, "themes"), { recursive: true });
  await mkdir(path.join(appShared, "docs"), { recursive: true });
  await mkdir(path.join(appShared, "permissions"), { recursive: true });
  await mkdir(path.join(appShared, "release-notes"), { recursive: true });
  await mkdir(path.join(appShared, "craft-logos"), { recursive: true });
  await mkdir(path.join(cloneResources, "webui"), { recursive: true });
  await mkdir(path.join(cloneResources, "bin"), { recursive: true });
  await mkdir(path.join(cloneResources, "scripts"), { recursive: true });
  await mkdir(path.join(cloneResources, "tool-icons"), { recursive: true });
  await mkdir(path.join(cloneResources, "themes"), { recursive: true });
  await mkdir(path.join(cloneResources, "docs"), { recursive: true });
  await mkdir(path.join(cloneResources, "permissions"), { recursive: true });
  await mkdir(path.join(cloneResources, "release-notes"), { recursive: true });
  await mkdir(path.join(cloneResources, "craft-logos"), { recursive: true });
  await writeFile(path.join(appPath, "Contents", "Info.plist"), `<?xml version="1.0"?>
<plist><dict>
<key>CFBundleIdentifier</key><string>app.yuuone.yuumira</string>
<key>CFBundleExecutable</key><string>craft-agents-tauri</string>
<key>CFBundleURLSchemes</key><array><string>yuumira</string><string>craftagents</string></array>
</dict></plist>
`, "utf8");
  await writeFile(path.join(appServer, "bin", "craft-server"), "server\n", "utf8");
  await writeFile(path.join(appServer, "resources", "webui", "index.html"), "<title>YuuMira</title>", "utf8");
  await writeFile(path.join(cloneResources, "webui", "index.html"), "<title>Changed</title>", "utf8");
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "yuumira-cleanroom" }), "utf8");
  for (const directory of ["bin", "scripts", "tool-icons", "themes", "docs", "permissions", "release-notes", "craft-logos"]) {
    await writeFile(path.join(appShared, directory, directory === "bin" ? "docx-tool" : "same.txt"), "same\n", "utf8");
    await writeFile(path.join(cloneResources, directory, directory === "bin" ? "docx-tool" : "same.txt"), "same\n", "utf8");
  }
  await writeFile(path.join(appShared, "config-defaults.json"), "{}", "utf8");
  await writeFile(path.join(cloneResources, "config-defaults.json"), "{}", "utf8");
  await writeFile(path.join(appShared, "source.png"), "source", "utf8");
  await writeFile(path.join(cloneResources, "source.png"), "source", "utf8");

  const result = auditYuuMiraBundle({ appPath, workspace, resourceDir: cloneResources });
  const webuiCheck = result.comparisons.checks.find((item) => item.id === "resources.webui.fingerprint");
  const packagesCheck = result.comparisons.checks.find((item) => item.id === "server.packages");

  assert.equal(result.app.components.webui.fileCount, result.clone.components.webui.fileCount);
  assert.notEqual(result.app.components.webui.sha256, result.clone.components.webui.sha256);
  assert.equal(webuiCheck.ok, false);
  assert.equal(packagesCheck.ok, false);
});

test("flags Finder-style duplicate resource variants", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-bundle-duplicates-"));
  const cloneResources = path.join(workspace, "resources");
  await mkdir(path.join(cloneResources, "tool-icons"), { recursive: true });
  await mkdir(path.join(cloneResources, "bin"), { recursive: true });
  await mkdir(path.join(cloneResources, "scripts"), { recursive: true });
  await mkdir(path.join(cloneResources, "webui"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "yuumira-cleanroom" }), "utf8");
  await writeFile(path.join(cloneResources, "config-defaults.json"), "{}", "utf8");
  await writeFile(path.join(cloneResources, "config-defaults 2.json"), "{}", "utf8");
  await writeFile(path.join(cloneResources, "bin", "docx-tool"), "#!/bin/sh\n", "utf8");
  await writeFile(path.join(cloneResources, "bin", "docx-tool 2"), "#!/bin/sh\n", "utf8");
  await writeFile(path.join(cloneResources, "tool-icons", "terminal.svg"), "<svg />", "utf8");
  await writeFile(path.join(cloneResources, "tool-icons", "terminal 2.svg"), "<svg />", "utf8");
  await writeFile(path.join(cloneResources, "scripts", "docx_tool.py"), "print('ok')\n", "utf8");
  await writeFile(path.join(cloneResources, "scripts", "docx_tool 3.py"), "print('ok')\n", "utf8");
  await writeFile(path.join(cloneResources, "webui", "index.html"), "<title>YuuMira</title>", "utf8");
  await writeFile(path.join(cloneResources, "webui", "index 2.html"), "<title>YuuMira</title>", "utf8");

  const result = auditYuuMiraBundle({ appPath: path.join(workspace, "Missing.app"), workspace, resourceDir: cloneResources });
  const duplicatesCheck = result.comparisons.checks.find((item) => item.id === "resources.duplicates");

  assert.equal(result.clone.duplicateVariants.total, 5);
  assert.deepEqual(result.clone.duplicateVariants.byDirectory["."][0], {
    canonical: "config-defaults.json",
    files: ["config-defaults 2.json", "config-defaults.json"]
  });
  assert.deepEqual(result.clone.duplicateVariants.byDirectory.bin[0], {
    canonical: "docx-tool",
    files: ["docx-tool", "docx-tool 2"]
  });
  assert.deepEqual(result.clone.duplicateVariants.byDirectory["tool-icons"][0], {
    canonical: "terminal.svg",
    files: ["terminal 2.svg", "terminal.svg"]
  });
  assert.deepEqual(result.clone.duplicateVariants.byDirectory.webui[0], {
    canonical: "index.html",
    files: ["index 2.html", "index.html"]
  });
  assert.equal(duplicatesCheck.ok, false);
});

test("flags missing webui entrypoint assets", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-webui-entrypoints-"));
  const cloneResources = path.join(workspace, "resources");
  await mkdir(path.join(cloneResources, "webui", "assets"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "yuumira-cleanroom" }), "utf8");
  await writeFile(path.join(cloneResources, "webui", "index.html"), `
    <div id="root"></div>
    <script type="module" src="./assets/main-present.js"></script>
    <link rel="stylesheet" href="./assets/main-missing.css">
  `, "utf8");
  await writeFile(path.join(cloneResources, "webui", "login.html"), `
    <script type="module" src="./assets/login-missing.js"></script>
  `, "utf8");
  await writeFile(path.join(cloneResources, "webui", "assets", "main-present.js"), "console.log('ok')\n", "utf8");

  const result = auditYuuMiraBundle({ appPath: path.join(workspace, "Missing.app"), workspace, resourceDir: cloneResources });
  const entrypointCheck = result.comparisons.checks.find((item) => item.id === "resources.webui.entrypoints");

  assert.equal(result.clone.webuiEntrypoints.ok, false);
  assert.deepEqual(result.clone.webuiEntrypoints.missing.map((item) => `${item.entrypoint}:${item.relativePath}`).sort(), [
    "index.html:assets/main-missing.css",
    "login.html:assets/login-missing.js"
  ]);
  assert.equal(entrypointCheck.ok, false);
});
