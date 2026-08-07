import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanFinderDuplicateVariants, importYuuMiraResources, parseImportOptions } from "../src/resource-import.js";

test("imports authorized YuuMira resource directories", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-resource-import-"));
  const source = path.join(workspace, "source");
  const webuiSource = path.join(workspace, "webui-source");
  const output = path.join(workspace, "resources");
  await mkdir(path.join(source, "tool-icons"), { recursive: true });
  await mkdir(path.join(source, "themes"), { recursive: true });
  await mkdir(path.join(source, "docs"), { recursive: true });
  await mkdir(path.join(source, "permissions"), { recursive: true });
  await mkdir(path.join(source, "release-notes"), { recursive: true });
  await mkdir(path.join(source, "craft-logos"), { recursive: true });
  await mkdir(path.join(source, "bin"), { recursive: true });
  await mkdir(path.join(source, "scripts", "tests"), { recursive: true });
  await mkdir(path.join(source, "scripts", "tests", "__pycache__"), { recursive: true });
  await mkdir(path.join(webuiSource, "assets"), { recursive: true });
  await writeFile(path.join(source, "tool-icons", "tool-icons.json"), JSON.stringify({
    version: 1,
    tools: [{ id: "npm", displayName: "npm", icon: "npm.png", commands: ["npm"] }]
  }), "utf8");
  await writeFile(path.join(source, "tool-icons", "npm.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(source, "themes", "default.json"), JSON.stringify({ name: "Default" }), "utf8");
  await writeFile(path.join(source, "themes", ".DS_Store"), "ignored", "utf8");
  await writeFile(path.join(source, "docs", "permissions.md"), "# Permissions\n", "utf8");
  await writeFile(path.join(source, "permissions", "default.json"), JSON.stringify({ version: 1 }), "utf8");
  await writeFile(path.join(source, "release-notes", "0.11.11.md"), "# 0.11.11\n", "utf8");
  await writeFile(path.join(source, "craft-logos", "craft_app_icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(source, "bin", "docx-tool"), "#!/bin/sh\nexec \"$CRAFT_UV\" run \"$CRAFT_SCRIPTS/docx_tool.py\" \"$@\"\n", "utf8");
  await writeFile(path.join(source, "scripts", "docx_tool.py"), "print('docx')\n", "utf8");
  await writeFile(path.join(source, "scripts", "tests", "test_docx_tool_smoke.py"), "def test_smoke():\n    assert True\n", "utf8");
  await writeFile(path.join(source, "scripts", "tests", "__pycache__", "test_docx_tool_smoke.cpython-314.pyc"), "cache", "utf8");
  await writeFile(path.join(source, "scripts", "tests", "tool_cache.pyc"), "cache", "utf8");
  await writeFile(path.join(source, "config-defaults.json"), JSON.stringify({ defaults: true }), "utf8");
  await writeFile(path.join(source, "source.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await mkdir(output, { recursive: true });
  await mkdir(path.join(output, "bin"), { recursive: true });
  await mkdir(path.join(output, "webui", "assets 2"), { recursive: true });
  await mkdir(path.join(output, "release-notes"), { recursive: true });
  await writeFile(path.join(output, "bin", "docx-tool 2"), "stale", "utf8");
  await writeFile(path.join(output, "config-defaults 2.json"), "stale", "utf8");
  await writeFile(path.join(output, "source 3.png"), "stale", "utf8");
  await writeFile(path.join(output, "release-notes", "0.11.11 3.md"), "stale", "utf8");
  await writeFile(path.join(webuiSource, "index.html"), "<div id=\"root\"></div>\n", "utf8");
  await writeFile(path.join(webuiSource, "manifest.json"), JSON.stringify({ name: "YuuMira" }), "utf8");
  await writeFile(path.join(webuiSource, "assets", "App-test.css"), "body{}\n", "utf8");
  await writeFile(path.join(webuiSource, "assets", ".DS_Store"), "ignored", "utf8");

  const manifest = await importYuuMiraResources({
    args: ["--from", source, "--out", output, "--include-webui", "--webui-from", webuiSource],
    now: new Date("2026-08-07T00:00:00.000Z")
  });

  assert.equal(manifest.directories.length, 9);
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.directories.find((item) => item.directory === "tool-icons").fileCount, 2);
  assert.equal(manifest.directories.find((item) => item.directory === "webui").fileCount, 3);
  assert.deepEqual([...await readFile(path.join(output, "tool-icons", "npm.png"))], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(JSON.parse(await readFile(path.join(output, "themes", "default.json"), "utf8")).name, "Default");
  assert.match(await readFile(path.join(output, "docs", "permissions.md"), "utf8"), /Permissions/);
  assert.match(await readFile(path.join(output, "bin", "docx-tool"), "utf8"), /CRAFT_UV/);
  await assert.rejects(readFile(path.join(output, "bin", "docx-tool 2")));
  assert.match(await readFile(path.join(output, "scripts", "docx_tool.py"), "utf8"), /docx/);
  assert.match(await readFile(path.join(output, "scripts", "tests", "test_docx_tool_smoke.py"), "utf8"), /test_smoke/);
  await assert.rejects(readFile(path.join(output, "scripts", "tests", "__pycache__", "test_docx_tool_smoke.cpython-314.pyc")));
  await assert.rejects(readFile(path.join(output, "scripts", "tests", "tool_cache.pyc")));
  assert.equal(JSON.parse(await readFile(path.join(output, "config-defaults.json"), "utf8")).defaults, true);
  await assert.rejects(readFile(path.join(output, "config-defaults 2.json")));
  await assert.rejects(readFile(path.join(output, "source 3.png")));
  assert.match(await readFile(path.join(output, "webui", "index.html"), "utf8"), /root/);
  assert.equal(JSON.parse(await readFile(path.join(output, "webui", "manifest.json"), "utf8")).name, "YuuMira");
  assert.match(await readFile(path.join(output, "webui", "assets", "App-test.css"), "utf8"), /body/);
  await assert.rejects(readFile(path.join(output, "webui", "assets 2", "App-test.css")));
  await assert.rejects(readFile(path.join(output, "webui", "assets", ".DS_Store")));
  await assert.rejects(readFile(path.join(output, "release-notes", "0.11.11 3.md")));
  assert.match(await readFile(path.join(output, "import-manifest.json"), "utf8"), /2026-08-07T00:00:00.000Z/);
});

test("imports only authorized server webui assets", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-webui-import-"));
  const webuiSource = path.join(workspace, "webui-source");
  const output = path.join(workspace, "resources");
  await mkdir(path.join(webuiSource, "assets"), { recursive: true });
  await writeFile(path.join(webuiSource, "index.html"), "<script src=\"/assets/app.js\"></script>\n", "utf8");
  await writeFile(path.join(webuiSource, "assets", "app.js"), "console.log('webui')\n", "utf8");

  const manifest = await importYuuMiraResources({
    args: ["--webui-only", "--webui-from", webuiSource, "--out", output],
    now: new Date("2026-08-07T00:00:00.000Z")
  });

  assert.deepEqual(manifest.directories.map((item) => item.directory), ["webui"]);
  assert.equal(manifest.files.length, 0);
  assert.match(await readFile(path.join(output, "webui", "assets", "app.js"), "utf8"), /webui/);
  await assert.rejects(readFile(path.join(output, "config-defaults.json")));
});

test("parses resource import option combinations", () => {
  assert.equal(parseImportOptions(["--tool-icons-only"]).toolIconsOnly, true);
  assert.equal(parseImportOptions(["--docs-only"]).docsOnly, true);
  assert.equal(parseImportOptions(["--helpers-only"]).helpersOnly, true);
  assert.equal(parseImportOptions(["--include-webui"]).includeWebui, true);
  assert.equal(parseImportOptions(["--webui-only"]).webuiOnly, true);
  assert.equal(parseImportOptions(["--webui-from", "/tmp/webui"]).webuiFrom, "/tmp/webui");
  assert.throws(() => parseImportOptions(["--tool-icons-only", "--themes-only"]), /Choose only one/);
  assert.throws(() => parseImportOptions(["--webui-only", "--helpers-only"]), /Choose only one/);
  assert.throws(() => parseImportOptions(["--from"]), /requires a value/);
  assert.throws(() => parseImportOptions(["--webui-from"]), /requires a value/);
});

test("cleans Finder-style resource variants directly", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yuumira-resource-clean-"));
  const output = path.join(workspace, "resources");
  await mkdir(path.join(output, "docs"), { recursive: true });
  await writeFile(path.join(output, "config-defaults.json"), "{}", "utf8");
  await writeFile(path.join(output, "config-defaults 7.json"), "{}", "utf8");
  await writeFile(path.join(output, "docs", "skills.md"), "# Skills\n", "utf8");
  await writeFile(path.join(output, "docs", "skills 8.md"), "# Skills\n", "utf8");

  await cleanFinderDuplicateVariants(output);

  assert.equal(await readFile(path.join(output, "config-defaults.json"), "utf8"), "{}");
  await assert.rejects(readFile(path.join(output, "config-defaults 7.json")));
  await assert.rejects(readFile(path.join(output, "docs", "skills 8.md")));
});
