import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export function parseBuildOptions(args = [], cwd = process.cwd(), env = process.env) {
  const outFile = readFlag(args, "--outfile") ?? env.YUUMIRA_CRAFT_SERVER_OUTFILE ?? path.join(cwd, "dist", "craft-server");
  return {
    entrypoint: readFlag(args, "--entrypoint") ?? path.join(cwd, "bin", "craft-server.mjs"),
    outfile: path.isAbsolute(outFile) ? outFile : path.join(cwd, outFile),
    bun: readFlag(args, "--bun") ?? env.BUN_BINARY ?? "bun",
    target: readFlag(args, "--target") ?? env.YUUMIRA_CRAFT_SERVER_TARGET ?? null,
    verify: hasFlag(args, "--verify"),
    dryRun: hasFlag(args, "--dry-run"),
    printCommand: hasFlag(args, "--print-command") || hasFlag(args, "--dry-run")
  };
}

export function craftServerBuildCommand(options) {
  const command = [options.bun, "build", "--compile", options.entrypoint, "--outfile", options.outfile];
  if (options.target) command.splice(3, 0, "--target", options.target);
  return command;
}

export async function buildCraftServer({ args = [], cwd = process.cwd(), env = process.env, stdout = console.log, stderr = console.error } = {}) {
  const options = parseBuildOptions(args, cwd, env);
  const command = craftServerBuildCommand(options);
  if (options.printCommand) stdout(command.map(shellQuote).join(" "));
  if (options.dryRun) return { options, command, skipped: true };

  await mkdir(path.dirname(options.outfile), { recursive: true });
  await runCommand(command, { cwd, env, stdout, stderr });
  const result = {
    options,
    command,
    outfile: options.outfile,
    skipped: false,
    verification: options.verify ? await verifyCraftServerExecutable(options.outfile) : null
  };
  stdout(JSON.stringify({
    outfile: result.outfile,
    command: command[0],
    status: result.verification && !result.verification.ok ? "built_unverified" : "built",
    verification: result.verification ?? undefined
  }));
  if (result.verification && !result.verification.ok) {
    const error = new Error(`Built executable failed verification: ${result.verification.signal ?? result.verification.code}`);
    error.code = "verification_failed";
    throw error;
  }
  return result;
}

export async function verifyCraftServerExecutable(outfile) {
  const result = await captureCommand([outfile, "--manifest"], { cwd: path.dirname(outfile), env: process.env });
  let manifest = null;
  if (result.code === 0) {
    try {
      manifest = JSON.parse(result.stdout);
    } catch {
      manifest = null;
    }
  }
  return {
    ok: result.code === 0 && manifest?.name === "craft-server",
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    manifest
  };
}

export function buildHelp() {
  return `craft-server build

Usage:
  build-craft-server [--outfile dist/craft-server] [--target <bun-target>] [--verify] [--dry-run] [--print-command]

Environment:
  BUN_BINARY                       Bun executable override
  YUUMIRA_CRAFT_SERVER_OUTFILE     Output executable path
  YUUMIRA_CRAFT_SERVER_TARGET      Optional Bun compile target
`;
}

function runCommand(command, { cwd, env, stdout, stderr }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => stdout(String(chunk).trimEnd()));
    child.stderr.on("data", (chunk) => stderr(String(chunk).trimEnd()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(`${command[0]} exited with code ${code}`);
      error.code = "build_failed";
      reject(error);
    });
  });
}

function captureCommand(command, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
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

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=+-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}
