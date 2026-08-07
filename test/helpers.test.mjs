import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { diagnoseHelperResult, listHelpers, listHelperBehaviorProfiles, listHelperSmokeProfiles, planHelperCommand, runHelperCommand, runHelperBehaviorProfile, smokeHelpers } from "../src/helpers.js";

test("lists, plans, and runs imported helper wrappers", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-helper-test-"));
  const resourceDir = path.join(workspace, "resources");
  await mkdir(path.join(resourceDir, "bin"), { recursive: true });
  await mkdir(path.join(resourceDir, "scripts"), { recursive: true });
  const helperPath = path.join(resourceDir, "bin", "echo-helper");
  await writeFile(helperPath, "#!/bin/sh\nexec \"$CRAFT_UV\" run \"$CRAFT_SCRIPTS/echo_helper.py\" \"$@\"\n", "utf8");
  await chmod(helperPath, 0o755);
  await writeFile(path.join(resourceDir, "scripts", "echo_helper.py"), "# /// script\n# dependencies = [\"click>=8,<9\"]\n# ///\nprint('helper')\n", "utf8");

  const helpers = listHelpers({ resourceDir });
  const plan = planHelperCommand({ name: "echo-helper", args: ["ok"], cwd: workspace, resourceDir, uv: process.execPath });
  const runnerPath = path.join(resourceDir, "bin", "node-helper");
  await writeFile(runnerPath, "#!/bin/sh\necho helper:$1\necho scripts:$CRAFT_SCRIPTS\n", "utf8");
  await chmod(runnerPath, 0o755);
  const result = await runHelperCommand({ name: "node-helper", args: ["ok"], cwd: workspace, resourceDir });

  assert.deepEqual(helpers.bins.map((helper) => helper.name), ["echo-helper"]);
  assert.equal(helpers.scripts[0].name, "echo_helper.py");
  assert.equal(helpers.bins[0].script.name, "echo_helper.py");
  assert.deepEqual(helpers.bins[0].script.dependencies, ["click>=8,<9"]);
  assert.equal(plan.env.CRAFT_UV, process.execPath);
  assert.equal(plan.args[0], "ok");
  assert.equal(result.exitCode, 0);
  assert.equal(result.diagnosis.status, "ok");
  assert.match(result.stdout, /helper:ok/);
  assert.match(result.stdout, /scripts:/);
  assert.throws(() => planHelperCommand({ name: "../escape", resourceDir }), /single bin file name/);
  assert.throws(() => planHelperCommand({ name: "missing", resourceDir }), /Unknown helper/);
});

test("smokes imported helper wrappers and reports failures", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-helper-smoke-"));
  const resourceDir = path.join(workspace, "resources");
  await mkdir(path.join(resourceDir, "bin"), { recursive: true });
  await mkdir(path.join(resourceDir, "scripts"), { recursive: true });
  const okPath = path.join(resourceDir, "bin", "ok-helper");
  const failPath = path.join(resourceDir, "bin", "fail-helper");
  await writeFile(okPath, "#!/bin/sh\necho ok:$1\n", "utf8");
  await writeFile(failPath, "#!/bin/sh\necho failed >&2\nexit 3\n", "utf8");
  await chmod(okPath, 0o755);
  await chmod(failPath, 0o755);

  const passing = await smokeHelpers({ names: ["ok-helper"], args: ["probe"], cwd: workspace, resourceDir });
  const mixed = await smokeHelpers({ names: ["ok-helper", "fail-helper"], args: ["probe"], cwd: workspace, resourceDir });
  const profiles = listHelperSmokeProfiles();

  assert.equal(passing.ok, true);
  assert.equal(passing.results[0].stdout.trim(), "ok:probe");
  assert.equal(mixed.ok, false);
  assert.equal(mixed.failed, 1);
  assert.equal(mixed.results.find((result) => result.name === "fail-helper").exitCode, 3);
  assert.equal(mixed.results.find((result) => result.name === "fail-helper").diagnosis.status, "failed");
  assert.equal(profiles.some((profile) => profile.id === "help" && profile.names.includes("docx-tool")), true);
  await assert.rejects(() => smokeHelpers({ profile: "missing", resourceDir }), /Unknown helper smoke profile/);
  assert.equal(diagnoseHelperResult({ exitCode: 2, timedOut: false, stderr: "Failed to initialize cache at `/Users/neoy/.cache/uv`: Operation not permitted" }).status, "uv-cache-permission");
  assert.equal(diagnoseHelperResult({ exitCode: 124, timedOut: true, stderr: "" }).status, "timeout");
});

test("runs ical basic behavior smoke profile", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-helper-behavior-"));
  const resourceDir = path.join(workspace, "resources");
  await mkdir(path.join(resourceDir, "bin"), { recursive: true });
  await mkdir(path.join(resourceDir, "scripts"), { recursive: true });
  const helperPath = path.join(resourceDir, "bin", "ical-tool");
  await writeFile(helperPath, `#!/bin/sh
cmd="$1"
if [ "$cmd" = "create" ]; then
  out=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then shift; out="$1"; fi
    shift
  done
  printf 'BEGIN:VCALENDAR\\nSUMMARY:Planning\\nEND:VCALENDAR\\n' > "$out"
  exit 0
fi
if [ "$cmd" = "read" ] || [ "$cmd" = "filter" ]; then
  printf '{"event_count":1,"events":[{"summary":"Planning"}]}\\n'
  exit 0
fi
exit 2
`, "utf8");
  await chmod(helperPath, 0o755);

  const profiles = listHelperBehaviorProfiles();
  const result = await runHelperBehaviorProfile({ profile: "ical-basic", cwd: workspace, resourceDir });

  assert.equal(profiles.some((profile) => profile.id === "ical-basic"), true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.name), ["create", "read", "filter"]);
  assert.equal(result.steps.every((step) => step.diagnosis.status === "ok"), true);
});

test("runs xlsx basic behavior smoke profile", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-helper-xlsx-behavior-"));
  const resourceDir = path.join(workspace, "resources");
  await mkdir(path.join(resourceDir, "bin"), { recursive: true });
  await mkdir(path.join(resourceDir, "scripts"), { recursive: true });
  const helperPath = path.join(resourceDir, "bin", "xlsx-tool");
  await writeFile(helperPath, `#!/bin/sh
cmd="$1"
if [ "$cmd" = "write" ]; then
  touch "$2"
  exit 0
fi
if [ "$cmd" = "info" ]; then
  printf '{"sheet_count":1,"sheets":["Sheet1"]}\\n'
  exit 0
fi
if [ "$cmd" = "read" ]; then
  printf '[{"name":"alice","score":42}]\\n'
  exit 0
fi
if [ "$cmd" = "export" ]; then
  out=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then shift; out="$1"; fi
    shift
  done
  printf 'name,score\\nalice,42\\n' > "$out"
  exit 0
fi
if [ "$cmd" = "add-sheet" ]; then
  exit 0
fi
exit 2
`, "utf8");
  await chmod(helperPath, 0o755);

  const profiles = listHelperBehaviorProfiles();
  const result = await runHelperBehaviorProfile({ profile: "xlsx-basic", cwd: workspace, resourceDir });

  assert.equal(profiles.some((profile) => profile.id === "xlsx-basic" && profile.helper === "xlsx-tool"), true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.name), [
    "write-header-name",
    "write-header-score",
    "write-row-name",
    "write-row-score",
    "info",
    "read-json",
    "export-csv",
    "add-sheet"
  ]);
  assert.equal(result.steps.every((step) => step.diagnosis.status === "ok"), true);
});

test("runs docx basic behavior smoke profile", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-helper-docx-behavior-"));
  const resourceDir = path.join(workspace, "resources");
  await mkdir(path.join(resourceDir, "bin"), { recursive: true });
  await mkdir(path.join(resourceDir, "scripts"), { recursive: true });
  const helperPath = path.join(resourceDir, "bin", "docx-tool");
  await writeFile(helperPath, `#!/bin/sh
cmd="$1"
if [ "$cmd" = "create" ]; then
  out=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then shift; out="$1"; fi
    shift
  done
  touch "$out"
  exit 0
fi
if [ "$cmd" = "extract" ]; then
  file="$2"
  case "$file" in
    *created.docx) printf 'Report\\nHello world\\n' ;;
    *filled.docx) printf 'Hello Balint\\n' ;;
    *replaced.docx) printf 'Hello Craft Agent\\n' ;;
    *) printf 'Hello\\n' ;;
  esac
  exit 0
fi
if [ "$cmd" = "template" ]; then
  out=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then shift; out="$1"; fi
    shift
  done
  touch "$out"
  exit 0
fi
if [ "$cmd" = "replace" ]; then
  out=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then shift; out="$1"; fi
    shift
  done
  touch "$out"
  exit 0
fi
exit 2
`, "utf8");
  await chmod(helperPath, 0o755);

  const profiles = listHelperBehaviorProfiles();
  const result = await runHelperBehaviorProfile({ profile: "docx-basic", cwd: workspace, resourceDir });

  assert.equal(profiles.some((profile) => profile.id === "docx-basic" && profile.helper === "docx-tool"), true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.name), [
    "create-report",
    "extract-report",
    "create-template",
    "fill-template",
    "extract-filled",
    "replace-text",
    "extract-replaced"
  ]);
  assert.equal(result.steps.every((step) => step.diagnosis.status === "ok"), true);
});

test("runs img basic behavior smoke profile", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-helper-img-behavior-"));
  const resourceDir = path.join(workspace, "resources");
  await mkdir(path.join(resourceDir, "bin"), { recursive: true });
  await mkdir(path.join(resourceDir, "scripts"), { recursive: true });
  const helperPath = path.join(resourceDir, "bin", "img-tool");
  await writeFile(helperPath, `#!/bin/sh
cmd="$1"
if [ "$cmd" = "info" ]; then
  printf '{"format":"PNG","width":1,"height":1}\\n'
  exit 0
fi
if [ "$cmd" = "resize" ] || [ "$cmd" = "convert" ]; then
  out=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then shift; out="$1"; fi
    shift
  done
  touch "$out"
  exit 0
fi
exit 2
`, "utf8");
  await chmod(helperPath, 0o755);

  const profiles = listHelperBehaviorProfiles();
  const result = await runHelperBehaviorProfile({ profile: "img-basic", cwd: workspace, resourceDir });

  assert.equal(profiles.some((profile) => profile.id === "img-basic" && profile.helper === "img-tool"), true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.name), ["info", "resize", "convert"]);
  assert.equal(result.steps.every((step) => step.diagnosis.status === "ok"), true);
});

test("runs markitdown basic behavior smoke profile", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-helper-markitdown-behavior-"));
  const resourceDir = path.join(workspace, "resources");
  await mkdir(path.join(resourceDir, "bin"), { recursive: true });
  await mkdir(path.join(resourceDir, "scripts"), { recursive: true });
  const markitdownPath = path.join(resourceDir, "bin", "markitdown");
  const docxPath = path.join(resourceDir, "bin", "docx-tool");
  await writeFile(markitdownPath, `#!/bin/sh
file="$1"
case "$file" in
  *.txt) cat "$file" ;;
  *.docx) printf 'Hello from docx\\n' ;;
  *) exit 2 ;;
esac
`, "utf8");
  await writeFile(docxPath, `#!/bin/sh
cmd="$1"
if [ "$cmd" = "create" ]; then
  out=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then shift; out="$1"; fi
    shift
  done
  touch "$out"
  exit 0
fi
exit 2
`, "utf8");
  await chmod(markitdownPath, 0o755);
  await chmod(docxPath, 0o755);

  const profiles = listHelperBehaviorProfiles();
  const result = await runHelperBehaviorProfile({ profile: "markitdown-basic", cwd: workspace, resourceDir });

  assert.equal(profiles.some((profile) => profile.id === "markitdown-basic" && profile.helper === "markitdown"), true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.name), ["plain-text", "create-docx-fixture", "docx-fallback"]);
  assert.equal(result.steps.every((step) => step.diagnosis.status === "ok"), true);
});

test("runs pdf basic behavior smoke profile", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-helper-pdf-behavior-"));
  const resourceDir = path.join(workspace, "resources");
  await mkdir(path.join(resourceDir, "bin"), { recursive: true });
  await mkdir(path.join(resourceDir, "scripts"), { recursive: true });
  const imgPath = path.join(resourceDir, "bin", "img-tool");
  const pdfPath = path.join(resourceDir, "bin", "pdf-tool");
  await writeFile(imgPath, `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
  shift
done
touch "$out"
`, "utf8");
  await writeFile(pdfPath, `#!/bin/sh
cmd="$1"
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; out="$1"; fi
  shift
done
if [ "$cmd" = "from-image" ] || [ "$cmd" = "sanitize" ]; then
  touch "$out"
  exit 0
fi
exit 2
`, "utf8");
  await chmod(imgPath, 0o755);
  await chmod(pdfPath, 0o755);

  const profiles = listHelperBehaviorProfiles();
  const result = await runHelperBehaviorProfile({ profile: "pdf-basic", cwd: workspace, resourceDir });

  assert.equal(profiles.some((profile) => profile.id === "pdf-basic" && profile.helper === "pdf-tool"), true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.name), ["resize-fixture", "from-image", "sanitize"]);
  assert.equal(result.steps.every((step) => step.diagnosis.status === "ok"), true);
});

test("runs pptx basic behavior smoke profile", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-helper-pptx-behavior-"));
  const resourceDir = path.join(workspace, "resources");
  await mkdir(path.join(resourceDir, "bin"), { recursive: true });
  await mkdir(path.join(resourceDir, "scripts"), { recursive: true });
  const helperPath = path.join(resourceDir, "bin", "pptx-tool");
  await writeFile(helperPath, `#!/bin/sh
cmd="$1"
if [ "$cmd" = "create" ]; then
  out=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then shift; out="$1"; fi
    shift
  done
  touch "$out"
  exit 0
fi
if [ "$cmd" = "info" ]; then
  printf '{"slide_count":2}\\n'
  exit 0
fi
if [ "$cmd" = "extract" ]; then
  printf 'Hello slide\\nWorld\\n'
  exit 0
fi
exit 2
`, "utf8");
  await chmod(helperPath, 0o755);

  const profiles = listHelperBehaviorProfiles();
  const result = await runHelperBehaviorProfile({ profile: "pptx-basic", cwd: workspace, resourceDir });

  assert.equal(profiles.some((profile) => profile.id === "pptx-basic" && profile.helper === "pptx-tool"), true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.name), ["create", "info", "extract"]);
  assert.equal(result.steps.every((step) => step.diagnosis.status === "ok"), true);
});

test("runs doc-diff basic behavior smoke profile", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "peng-helper-doc-diff-behavior-"));
  const resourceDir = path.join(workspace, "resources");
  await mkdir(path.join(resourceDir, "bin"), { recursive: true });
  await mkdir(path.join(resourceDir, "scripts"), { recursive: true });
  const helperPath = path.join(resourceDir, "bin", "doc-diff");
  await writeFile(helperPath, `#!/bin/sh
printf 'Comparison:\\nSimilarity: 50%%\\n'
`, "utf8");
  await chmod(helperPath, 0o755);

  const profiles = listHelperBehaviorProfiles();
  const result = await runHelperBehaviorProfile({ profile: "doc-diff-basic", cwd: workspace, resourceDir });

  assert.equal(profiles.some((profile) => profile.id === "doc-diff-basic" && profile.helper === "doc-diff"), true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.name), ["summary"]);
  assert.equal(result.steps.every((step) => step.diagnosis.status === "ok"), true);
});
