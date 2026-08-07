import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_HELPER_OUTPUT = 64_000;
export const HELPER_SMOKE_PROFILES = {
  help: {
    args: ["--help"],
    names: ["doc-diff", "docx-tool", "ical-tool", "img-tool", "markitdown", "pdf-tool", "pptx-tool", "xlsx-tool"],
    skip: ["craft-agent"],
    description: "Run --help against every imported document/media helper wrapper."
  }
};
export const HELPER_BEHAVIOR_PROFILES = {
  "ical-basic": {
    helper: "ical-tool",
    description: "Create, read, and filter a small .ics calendar file.",
    timeoutMs: 60_000
  },
  "xlsx-basic": {
    helper: "xlsx-tool",
    description: "Write, inspect, read, export, and add a sheet in a small workbook.",
    timeoutMs: 60_000
  },
  "docx-basic": {
    helper: "docx-tool",
    description: "Create, extract, fill a template, and replace text in small .docx files.",
    timeoutMs: 60_000
  },
  "img-basic": {
    helper: "img-tool",
    description: "Inspect, resize, and convert a small PNG image.",
    timeoutMs: 60_000
  },
  "markitdown-basic": {
    helper: "markitdown",
    description: "Convert plain text and a generated .docx document to Markdown text.",
    timeoutMs: 60_000
  },
  "pdf-basic": {
    helper: "pdf-tool",
    description: "Create a PDF from an image fixture and sanitize it.",
    timeoutMs: 60_000
  },
  "pptx-basic": {
    helper: "pptx-tool",
    description: "Create, inspect, and extract text from a small slide deck.",
    timeoutMs: 60_000
  },
  "doc-diff-basic": {
    helper: "doc-diff",
    description: "Compare two small text documents and validate summary output.",
    timeoutMs: 60_000
  }
};

export function listHelpers({ resourceDir = defaultResourceDir() } = {}) {
  const binDir = path.join(resourceDir, "bin");
  const scriptDir = path.join(resourceDir, "scripts");
  const bins = listFiles(binDir).map((fileName) => enrichHelperBin({
    fileName,
    binDir,
    scriptDir
  }));
  const scripts = listFiles(scriptDir)
    .filter((fileName) => [".py", ".mjs", ".ps1"].includes(path.extname(fileName)))
    .map((fileName) => ({
      name: fileName,
      path: path.join(scriptDir, fileName),
      resourcePath: `/resources/scripts/${encodeURIComponent(fileName)}`
    }));
  return {
    resourceDir,
    binDir,
    scriptDir,
    count: bins.length,
    bins,
    scripts
  };
}

export function planHelperCommand({
  name,
  args = [],
  cwd = process.cwd(),
  resourceDir = defaultResourceDir(),
  uv = process.env.CRAFT_UV ?? "uv",
  bun = process.env.CRAFT_BUN ?? "bun",
  extraEnv = {}
} = {}) {
  const helper = resolveHelper(name, { resourceDir });
  const normalizedArgs = normalizeArgs(args);
  const script = helperScriptForBin(helper.path, path.join(resourceDir, "scripts"));
  const env = {
    CRAFT_UV: uv,
    CRAFT_SCRIPTS: path.join(resourceDir, "scripts"),
    CRAFT_BUN: bun,
    CRAFT_CLI_ENTRY: process.env.CRAFT_CLI_ENTRY ?? "",
    CRAFT_COMMANDS_ENTRY: process.env.CRAFT_COMMANDS_ENTRY ?? "",
    ...stringEnv(extraEnv)
  };
  return {
    name: helper.name,
    executable: helper.path,
    script,
    args: normalizedArgs,
    cwd,
    env,
    command: [helper.path, ...normalizedArgs].map(shellQuote).join(" ")
  };
}

export async function runHelperCommand({
  name,
  args = [],
  cwd = process.cwd(),
  resourceDir = defaultResourceDir(),
  timeoutMs = 30_000,
  env = {}
} = {}) {
  const plan = planHelperCommand({ name, args, cwd, resourceDir, extraEnv: env });
  const startedAt = new Date();
  const result = await spawnAndCapture(plan.executable, plan.args, {
    cwd: plan.cwd,
    env: { ...process.env, ...plan.env },
    timeoutMs
  });
  const endedAt = new Date();
  return {
    ...plan,
    ...result,
    diagnosis: diagnoseHelperResult(result),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime())
  };
}

export async function smokeHelpers({
  names,
  args,
  profile,
  cwd = process.cwd(),
  resourceDir = defaultResourceDir(),
  timeoutMs = 30_000,
  skip,
  env = {}
} = {}) {
  const resolvedProfile = resolveSmokeProfile(profile);
  const smokeArgs = args ?? resolvedProfile?.args ?? ["--help"];
  const smokeNames = names ?? resolvedProfile?.names;
  const smokeSkip = skip ?? resolvedProfile?.skip ?? ["craft-agent"];
  const available = listHelpers({ resourceDir }).bins.map((helper) => helper.name);
  const selected = (Array.isArray(smokeNames) && smokeNames.length ? smokeNames.map(String) : available)
    .filter((name) => !smokeSkip.includes(name));
  const results = [];
  for (const name of selected) {
    try {
      const result = await runHelperCommand({ name, args: smokeArgs, cwd, resourceDir, timeoutMs, env });
      results.push(summarizeSmokeResult(result));
    } catch (error) {
      results.push({
        name,
        ok: false,
        exitCode: null,
        timedOut: false,
        diagnosis: { status: "failed", message: error.message },
        error: error.message,
        stdout: "",
        stderr: ""
      });
    }
  }
  return {
    ok: results.every((result) => result.ok),
    profile: resolvedProfile?.id ?? null,
    args: normalizeArgs(smokeArgs),
    count: results.length,
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    skipped: available.filter((name) => smokeSkip.includes(name)),
    results
  };
}

export function listHelperSmokeProfiles() {
  return Object.entries(HELPER_SMOKE_PROFILES).map(([id, profile]) => ({
    id,
    description: profile.description,
    args: profile.args,
    names: profile.names,
    skip: profile.skip
  }));
}

export function listHelperBehaviorProfiles() {
  return Object.entries(HELPER_BEHAVIOR_PROFILES).map(([id, profile]) => ({
    id,
    description: profile.description,
    helper: profile.helper,
    timeoutMs: profile.timeoutMs
  }));
}

export async function runHelperBehaviorProfile({
  profile = "ical-basic",
  cwd = process.cwd(),
  resourceDir = defaultResourceDir(),
  timeoutMs,
  env = {},
  keepTemp = false
} = {}) {
  const resolved = resolveBehaviorProfile(profile);
  if (resolved.id === "ical-basic") {
    return runIcalBasicBehavior({ profile: resolved, cwd, resourceDir, timeoutMs: timeoutMs ?? resolved.timeoutMs, env, keepTemp });
  }
  if (resolved.id === "xlsx-basic") {
    return runXlsxBasicBehavior({ profile: resolved, cwd, resourceDir, timeoutMs: timeoutMs ?? resolved.timeoutMs, env, keepTemp });
  }
  if (resolved.id === "docx-basic") {
    return runDocxBasicBehavior({ profile: resolved, cwd, resourceDir, timeoutMs: timeoutMs ?? resolved.timeoutMs, env, keepTemp });
  }
  if (resolved.id === "img-basic") {
    return runImgBasicBehavior({ profile: resolved, cwd, resourceDir, timeoutMs: timeoutMs ?? resolved.timeoutMs, env, keepTemp });
  }
  if (resolved.id === "markitdown-basic") {
    return runMarkitdownBasicBehavior({ profile: resolved, cwd, resourceDir, timeoutMs: timeoutMs ?? resolved.timeoutMs, env, keepTemp });
  }
  if (resolved.id === "pdf-basic") {
    return runPdfBasicBehavior({ profile: resolved, cwd, resourceDir, timeoutMs: timeoutMs ?? resolved.timeoutMs, env, keepTemp });
  }
  if (resolved.id === "pptx-basic") {
    return runPptxBasicBehavior({ profile: resolved, cwd, resourceDir, timeoutMs: timeoutMs ?? resolved.timeoutMs, env, keepTemp });
  }
  if (resolved.id === "doc-diff-basic") {
    return runDocDiffBasicBehavior({ profile: resolved, cwd, resourceDir, timeoutMs: timeoutMs ?? resolved.timeoutMs, env, keepTemp });
  }
  throw new Error(`Unsupported helper behavior profile: ${resolved.id}`);
}

export function resolveHelper(name, { resourceDir = defaultResourceDir() } = {}) {
  const helperName = normalizeHelperName(name);
  const file = path.resolve(resourceDir, "bin", helperName);
  const binRoot = path.resolve(resourceDir, "bin");
  if (file !== binRoot && !file.startsWith(`${binRoot}${path.sep}`)) {
    throw new Error(`Helper escapes resource bin directory: ${name}`);
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`Unknown helper: ${helperName}`);
  }
  return {
    name: helperName,
    path: file,
    resourcePath: `/resources/bin/${encodeURIComponent(helperName)}`
  };
}

function spawnAndCapture(executable, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = Number(timeoutMs) > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, Number(timeoutMs))
      : null;

    child.stdout?.on("data", (chunk) => {
      stdout = truncateHelperOutput(stdout + chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk) => {
      stderr = truncateHelperOutput(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      resolve({
        exitCode: timedOut ? 124 : code ?? (signal ? 128 : 1),
        signal: timedOut ? "SIGTERM" : signal,
        timedOut,
        stdout,
        stderr,
        stdoutTruncated: stdout.length >= MAX_HELPER_OUTPUT,
        stderrTruncated: stderr.length >= MAX_HELPER_OUTPUT
      });
    });
  });
}

export function diagnoseHelperResult(result) {
  const stderr = String(result?.stderr ?? "");
  if (result?.timedOut) {
    return { status: "timeout", message: `helper exceeded timeout${result.timeoutMs ? ` ${result.timeoutMs}ms` : ""}` };
  }
  if (result?.exitCode === 0) return { status: "ok", message: "helper completed successfully" };
  if (/Failed to initialize cache at .*\.cache\/uv|Operation not permitted/.test(stderr)) {
    return {
      status: "uv-cache-permission",
      message: "uv could not access its user cache; rerun outside the filesystem sandbox or set UV_CACHE_DIR to a writable path"
    };
  }
  if (/command not found|No such file or directory|ENOENT/.test(stderr)) {
    return { status: "missing-command", message: "helper executable or one of its runtime commands was not found" };
  }
  if (/Failed to download|No solution found|Because .* depends on|resolution failed|failed to fetch/i.test(stderr)) {
    return { status: "dependency-resolution", message: "uv could not resolve or fetch helper dependencies" };
  }
  return { status: "failed", message: `helper exited with code ${result?.exitCode ?? "unknown"}` };
}

function defaultResourceDir() {
  return process.env.PENG_RESOURCE_DIR ?? path.join(process.cwd(), "resources");
}

function resolveSmokeProfile(profile) {
  if (!profile) return null;
  const id = String(profile);
  const value = HELPER_SMOKE_PROFILES[id];
  if (!value) throw new Error(`Unknown helper smoke profile: ${id}`);
  return { id, ...value };
}

function resolveBehaviorProfile(profile) {
  const id = String(profile || "ical-basic");
  const value = HELPER_BEHAVIOR_PROFILES[id];
  if (!value) throw new Error(`Unknown helper behavior profile: ${id}`);
  return { id, ...value };
}

async function runIcalBasicBehavior({ profile, cwd, resourceDir, timeoutMs, env, keepTemp }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "peng-ical-behavior-"));
  const calendar = path.join(tempDir, "calendar.ics");
  const eventData = JSON.stringify([
    {
      summary: "Planning",
      start: "2026-03-10T10:00:00",
      end: "2026-03-10T11:00:00",
      location: "Budapest"
    }
  ]);
  const steps = [];
  try {
    steps.push(await runBehaviorStep({
      name: "create",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["create", "--data", eventData, "--cal-name", "Smoke", "-o", calendar],
      cwd,
      resourceDir,
      timeoutMs,
      env
    }));
    steps.push(await runBehaviorStep({
      name: "read",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["read", calendar, "--format", "json"],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: (result) => {
        const parsed = JSON.parse(result.stdout);
        if (parsed.event_count !== 1) throw new Error(`expected event_count=1, got ${parsed.event_count}`);
        if (parsed.events?.[0]?.summary !== "Planning") throw new Error("expected first event summary to be Planning");
      }
    }));
    steps.push(await runBehaviorStep({
      name: "filter",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["filter", calendar, "--start", "2026-03-01", "--end", "2026-03-31", "--format", "json"],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: (result) => {
        const parsed = JSON.parse(result.stdout);
        if (parsed.event_count !== 1) throw new Error(`expected filtered event_count=1, got ${parsed.event_count}`);
      }
    }));
  } finally {
    if (!keepTemp) await rm(tempDir, { recursive: true, force: true });
  }
  return {
    ok: steps.every((step) => step.ok),
    profile: profile.id,
    helper: profile.helper,
    tempDir: keepTemp ? tempDir : null,
    steps
  };
}

async function runXlsxBasicBehavior({ profile, cwd, resourceDir, timeoutMs, env, keepTemp }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "peng-xlsx-behavior-"));
  const workbook = path.join(tempDir, "workbook.xlsx");
  const csv = path.join(tempDir, "workbook.csv");
  const steps = [];
  try {
    steps.push(await runBehaviorStep({
      name: "write-header-name",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["write", workbook, "--cell", "A1", "--value", "name"],
      cwd,
      resourceDir,
      timeoutMs,
      env
    }));
    steps.push(await runBehaviorStep({
      name: "write-header-score",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["write", workbook, "--cell", "B1", "--value", "score"],
      cwd,
      resourceDir,
      timeoutMs,
      env
    }));
    steps.push(await runBehaviorStep({
      name: "write-row-name",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["write", workbook, "--cell", "A2", "--value", "alice"],
      cwd,
      resourceDir,
      timeoutMs,
      env
    }));
    steps.push(await runBehaviorStep({
      name: "write-row-score",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["write", workbook, "--cell", "B2", "--value", "42", "--type", "number"],
      cwd,
      resourceDir,
      timeoutMs,
      env
    }));
    steps.push(await runBehaviorStep({
      name: "info",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["info", workbook],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: (result) => {
        const parsed = JSON.parse(result.stdout);
        if (parsed.sheet_count < 1) throw new Error(`expected sheet_count>=1, got ${parsed.sheet_count}`);
      }
    }));
    steps.push(await runBehaviorStep({
      name: "read-json",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["read", workbook, "--format", "json"],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: (result) => {
        const rows = JSON.parse(result.stdout);
        if (rows?.[0]?.name !== "alice") throw new Error("expected first row name to be alice");
        if (rows?.[0]?.score !== 42) throw new Error(`expected first row score to be 42, got ${rows?.[0]?.score}`);
      }
    }));
    steps.push(await runBehaviorStep({
      name: "export-csv",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["export", workbook, "--format", "csv", "-o", csv],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: () => {
        if (!existsSync(csv)) throw new Error("expected CSV export to exist");
      }
    }));
    steps.push(await runBehaviorStep({
      name: "add-sheet",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["add-sheet", workbook, "--name", "Data"],
      cwd,
      resourceDir,
      timeoutMs,
      env
    }));
  } finally {
    if (!keepTemp) await rm(tempDir, { recursive: true, force: true });
  }
  return {
    ok: steps.every((step) => step.ok),
    profile: profile.id,
    helper: profile.helper,
    tempDir: keepTemp ? tempDir : null,
    steps
  };
}

async function runDocxBasicBehavior({ profile, cwd, resourceDir, timeoutMs, env, keepTemp }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "peng-docx-behavior-"));
  const created = path.join(tempDir, "created.docx");
  const template = path.join(tempDir, "template.docx");
  const filled = path.join(tempDir, "filled.docx");
  const replaced = path.join(tempDir, "replaced.docx");
  const steps = [];
  try {
    steps.push(await runBehaviorStep({
      name: "create-report",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["create", "--text", "# Report\n\nHello **world**", "--title", "Q1", "-o", created],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: () => {
        if (!existsSync(created)) throw new Error("expected created.docx to exist");
      }
    }));
    steps.push(await runBehaviorStep({
      name: "extract-report",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["extract", created],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: (result) => {
        if (!result.stdout.includes("Report")) throw new Error("expected extracted report title");
        if (!result.stdout.includes("Hello")) throw new Error("expected extracted report body");
      }
    }));
    steps.push(await runBehaviorStep({
      name: "create-template",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["create", "--text", "Hello {{name}}", "-o", template],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: () => {
        if (!existsSync(template)) throw new Error("expected template.docx to exist");
      }
    }));
    steps.push(await runBehaviorStep({
      name: "fill-template",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["template", template, "--data", "{\"name\":\"Balint\"}", "-o", filled],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: () => {
        if (!existsSync(filled)) throw new Error("expected filled.docx to exist");
      }
    }));
    steps.push(await runBehaviorStep({
      name: "extract-filled",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["extract", filled],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: (result) => {
        if (!result.stdout.includes("Balint")) throw new Error("expected filled template text");
      }
    }));
    steps.push(await runBehaviorStep({
      name: "replace-text",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["replace", filled, "--find", "Balint", "--replace-with", "Craft Agent", "-o", replaced],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: () => {
        if (!existsSync(replaced)) throw new Error("expected replaced.docx to exist");
      }
    }));
    steps.push(await runBehaviorStep({
      name: "extract-replaced",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["extract", replaced],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: (result) => {
        if (!result.stdout.includes("Craft Agent")) throw new Error("expected replaced text");
      }
    }));
  } finally {
    if (!keepTemp) await rm(tempDir, { recursive: true, force: true });
  }
  return {
    ok: steps.every((step) => step.ok),
    profile: profile.id,
    helper: profile.helper,
    tempDir: keepTemp ? tempDir : null,
    steps
  };
}

async function runImgBasicBehavior({ profile, cwd, resourceDir, timeoutMs, env, keepTemp }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "peng-img-behavior-"));
  const input = path.join(tempDir, "input.png");
  const resized = path.join(tempDir, "resized.png");
  const converted = path.join(tempDir, "converted.jpg");
  const transparentPixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5n2WQAAAAASUVORK5CYII=", "base64");
  const steps = [];
  try {
    await writeFile(input, transparentPixel);
    steps.push(await runBehaviorStep({
      name: "info",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["info", input],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: (result) => {
        const parsed = JSON.parse(result.stdout);
        if (parsed.format !== "PNG") throw new Error(`expected PNG format, got ${parsed.format}`);
      }
    }));
    steps.push(await runBehaviorStep({
      name: "resize",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["resize", input, "--scale", "2", "-o", resized],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: () => {
        if (!existsSync(resized)) throw new Error("expected resized.png to exist");
      }
    }));
    steps.push(await runBehaviorStep({
      name: "convert",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["convert", resized, "--format", "jpg", "-o", converted],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: () => {
        if (!existsSync(converted)) throw new Error("expected converted.jpg to exist");
      }
    }));
  } finally {
    if (!keepTemp) await rm(tempDir, { recursive: true, force: true });
  }
  return {
    ok: steps.every((step) => step.ok),
    profile: profile.id,
    helper: profile.helper,
    tempDir: keepTemp ? tempDir : null,
    steps
  };
}

async function runMarkitdownBasicBehavior({ profile, cwd, resourceDir, timeoutMs, env, keepTemp }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "peng-markitdown-behavior-"));
  const txt = path.join(tempDir, "plain.txt");
  const docx = path.join(tempDir, "sample.docx");
  const steps = [];
  try {
    await writeFile(txt, "hello craft\n", "utf8");
    steps.push(await runBehaviorStep({
      name: "plain-text",
      expectedExitCode: 0,
      helper: profile.helper,
      args: [txt],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: (result) => {
        if (!result.stdout.includes("hello craft")) throw new Error("expected plain text passthrough");
      }
    }));
    steps.push(await runBehaviorStep({
      name: "create-docx-fixture",
      expectedExitCode: 0,
      helper: "docx-tool",
      args: ["create", "--text", "Hello from docx", "-o", docx],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: () => {
        if (!existsSync(docx)) throw new Error("expected sample.docx to exist");
      }
    }));
    steps.push(await runBehaviorStep({
      name: "docx-fallback",
      expectedExitCode: 0,
      helper: profile.helper,
      args: [docx],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: (result) => {
        if (!result.stdout.includes("Hello from docx")) throw new Error("expected docx fallback text");
      }
    }));
  } finally {
    if (!keepTemp) await rm(tempDir, { recursive: true, force: true });
  }
  return {
    ok: steps.every((step) => step.ok),
    profile: profile.id,
    helper: profile.helper,
    tempDir: keepTemp ? tempDir : null,
    steps
  };
}

async function runPdfBasicBehavior({ profile, cwd, resourceDir, timeoutMs, env, keepTemp }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "peng-pdf-behavior-"));
  const tiny = path.join(tempDir, "tiny.png");
  const image = path.join(tempDir, "image.png");
  const pdf = path.join(tempDir, "input.pdf");
  const sanitized = path.join(tempDir, "sanitized.pdf");
  const transparentPixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5n2WQAAAAASUVORK5CYII=", "base64");
  const steps = [];
  try {
    await writeFile(tiny, transparentPixel);
    steps.push(await runBehaviorStep({
      name: "resize-fixture",
      expectedExitCode: 0,
      helper: "img-tool",
      args: ["resize", tiny, "--width", "200", "--height", "200", "-o", image],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: () => {
        if (!existsSync(image)) throw new Error("expected resized image fixture to exist");
      }
    }));
    steps.push(await runBehaviorStep({
      name: "from-image",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["from-image", image, "-o", pdf],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: () => {
        if (!existsSync(pdf)) throw new Error("expected input.pdf to exist");
      }
    }));
    steps.push(await runBehaviorStep({
      name: "sanitize",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["sanitize", pdf, "-o", sanitized],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: () => {
        if (!existsSync(sanitized)) throw new Error("expected sanitized.pdf to exist");
      }
    }));
  } finally {
    if (!keepTemp) await rm(tempDir, { recursive: true, force: true });
  }
  return {
    ok: steps.every((step) => step.ok),
    profile: profile.id,
    helper: profile.helper,
    tempDir: keepTemp ? tempDir : null,
    steps
  };
}

async function runPptxBasicBehavior({ profile, cwd, resourceDir, timeoutMs, env, keepTemp }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "peng-pptx-behavior-"));
  const deck = path.join(tempDir, "deck.pptx");
  const steps = [];
  try {
    steps.push(await runBehaviorStep({
      name: "create",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["create", "--title", "Smoke Deck", "--text", "# Slide One\nHello slide\n---\n# Slide Two\nWorld", "-o", deck],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: () => {
        if (!existsSync(deck)) throw new Error("expected deck.pptx to exist");
      }
    }));
    steps.push(await runBehaviorStep({
      name: "info",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["info", deck],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: (result) => {
        const parsed = JSON.parse(result.stdout);
        if (parsed.slide_count < 2) throw new Error(`expected slide_count>=2, got ${parsed.slide_count}`);
      }
    }));
    steps.push(await runBehaviorStep({
      name: "extract",
      expectedExitCode: 0,
      helper: profile.helper,
      args: ["extract", deck],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: (result) => {
        if (!result.stdout.includes("Hello slide")) throw new Error("expected first slide text");
        if (!result.stdout.includes("World")) throw new Error("expected second slide text");
      }
    }));
  } finally {
    if (!keepTemp) await rm(tempDir, { recursive: true, force: true });
  }
  return {
    ok: steps.every((step) => step.ok),
    profile: profile.id,
    helper: profile.helper,
    tempDir: keepTemp ? tempDir : null,
    steps
  };
}

async function runDocDiffBasicBehavior({ profile, cwd, resourceDir, timeoutMs, env, keepTemp }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "peng-doc-diff-behavior-"));
  const left = path.join(tempDir, "a.txt");
  const right = path.join(tempDir, "b.txt");
  const steps = [];
  try {
    await writeFile(left, "hello\nworld\n", "utf8");
    await writeFile(right, "hello\ncraft\n", "utf8");
    steps.push(await runBehaviorStep({
      name: "summary",
      expectedExitCode: 0,
      helper: profile.helper,
      args: [left, right, "--format", "summary"],
      cwd,
      resourceDir,
      timeoutMs,
      env,
      validate: (result) => {
        if (!result.stdout.includes("Comparison:")) throw new Error("expected comparison summary");
        if (!result.stdout.includes("Similarity:")) throw new Error("expected similarity summary");
      }
    }));
  } finally {
    if (!keepTemp) await rm(tempDir, { recursive: true, force: true });
  }
  return {
    ok: steps.every((step) => step.ok),
    profile: profile.id,
    helper: profile.helper,
    tempDir: keepTemp ? tempDir : null,
    steps
  };
}

async function runBehaviorStep({ name, expectedExitCode, helper, args, cwd, resourceDir, timeoutMs, env, validate }) {
  const result = await runHelperCommand({ name: helper, args, cwd, resourceDir, timeoutMs, env });
  const step = {
    name,
    ok: result.exitCode === expectedExitCode,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    diagnosis: result.diagnosis,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr
  };
  if (!step.ok) return step;
  try {
    if (validate) validate(result);
  } catch (error) {
    return { ...step, ok: false, diagnosis: { status: "validation-failed", message: error.message } };
  }
  return step;
}

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((fileName) => {
      try {
        return statSync(path.join(directory, fileName)).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
}

function enrichHelperBin({ fileName, binDir, scriptDir }) {
  const file = path.join(binDir, fileName);
  const script = helperScriptForBin(file, scriptDir);
  return {
    name: fileName,
    path: file,
    resourcePath: `/resources/bin/${encodeURIComponent(fileName)}`,
    script
  };
}

function helperScriptForBin(binPath, scriptDir) {
  try {
    const content = readFileSync(binPath, "utf8");
    const match = content.match(/\$CRAFT_SCRIPTS\/([A-Za-z0-9_.-]+)/);
    if (!match) return null;
    const fileName = match[1];
    const file = path.join(scriptDir, fileName);
    return {
      name: fileName,
      path: file,
      resourcePath: `/resources/scripts/${encodeURIComponent(fileName)}`,
      dependencies: readPep723Dependencies(file)
    };
  } catch {
    return null;
  }
}

function readPep723Dependencies(file) {
  try {
    const content = readFileSync(file, "utf8");
    const dependencies = [];
    let inDependencies = false;
    for (const line of content.split(/\r?\n/)) {
      const singleLine = line.match(/^# dependencies = \[(.*)\]/);
      if (singleLine) {
        return [...singleLine[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      }
      if (/^# dependencies = \[$/.test(line)) {
        inDependencies = true;
        continue;
      }
      if (inDependencies && /^# \]/.test(line)) break;
      if (inDependencies) {
        const match = line.match(/^#\s+"([^"]+)"/);
        if (match) dependencies.push(match[1]);
      }
    }
    return dependencies;
  } catch {
    return [];
  }
}

function normalizeHelperName(name) {
  const value = String(name ?? "").trim();
  if (!value || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error("Helper name must be a single bin file name.");
  }
  return value;
}

function normalizeArgs(args) {
  if (!Array.isArray(args)) return [];
  return args.map((arg) => String(arg));
}

function stringEnv(env) {
  return Object.fromEntries(Object.entries(env ?? {}).map(([key, value]) => [key, String(value)]));
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function truncateHelperOutput(value) {
  return value.length > MAX_HELPER_OUTPUT ? value.slice(0, MAX_HELPER_OUTPUT) : value;
}

function summarizeSmokeResult(result) {
  return {
    name: result.name,
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    diagnosis: result.diagnosis,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated
  };
}
