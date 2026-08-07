import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SOURCE = "/Applications/YuuMira.app/Contents/Resources/resources";
const DEFAULT_WEBUI_SOURCE = "/Applications/YuuMira.app/Contents/Resources/server/resources/webui";
const DEFAULT_DIRECTORIES = ["tool-icons", "themes", "docs", "permissions", "release-notes", "craft-logos", "bin", "scripts"];
const DEFAULT_FILES = ["config-defaults.json", "source.png"];
const IGNORED_RESOURCE_NAMES = new Set(["__pycache__"]);
const IGNORED_RESOURCE_EXTENSIONS = new Set([".pyc", ".pyo"]);

export async function importYuuMiraResources({ args = process.argv.slice(2), cwd = process.cwd(), now = new Date() } = {}) {
  const options = parseImportOptions(args, cwd);
  const selectedDirectories = selectedResourceDirectories(options);
  const selectedFiles = selectedResourceFiles(options);
  const sourceRoot = path.resolve(options.from);
  const outputRoot = path.resolve(options.out);
  const directories = [];
  const files = [];

  for (const directory of selectedDirectories) {
    const source = path.join(sourceRoot, directory);
    const destination = path.join(outputRoot, directory);
    const report = await describeDirectory(source);
    directories.push({ directory, source, destination, ...report });
  }
  if (options.includeWebui || options.webuiOnly) {
    const source = path.resolve(options.webuiFrom);
    const destination = path.join(outputRoot, "webui");
    const report = await describeDirectory(source);
    directories.push({ directory: "webui", source, destination, ...report });
  }
  for (const fileName of selectedFiles) {
    const source = path.join(sourceRoot, fileName);
    const destination = path.join(outputRoot, fileName);
    const fileStat = await stat(source);
    if (!fileStat.isFile()) throw new Error(`Not a file: ${source}`);
    files.push({ file: fileName, source, destination, byteCount: fileStat.size });
  }

  if (options.dryRun) {
    return {
      dryRun: true,
      sourceRoot,
      outputRoot,
      directories,
      files
    };
  }

  await mkdir(outputRoot, { recursive: true });
  for (const item of directories) {
    if (!options.noClean) await removeDirectoryVariants(outputRoot, item.directory);
    await copyDirectoryContents(item.source, item.destination);
  }
  for (const item of files) {
    if (!options.noClean) await removeFileVariants(outputRoot, item.file);
    await cp(item.source, item.destination);
  }
  if (!options.noClean) await cleanFinderDuplicateVariants(outputRoot);

  const manifest = {
    version: 1,
    importedAt: now.toISOString(),
    sourceRoot,
    outputRoot,
    directories: directories.map(({ directory, fileCount, byteCount }) => ({ directory, fileCount, byteCount })),
    files: files.map(({ file, byteCount }) => ({ file, byteCount }))
  };
  await writeFile(path.join(outputRoot, "import-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function parseImportOptions(args, cwd = process.cwd()) {
  const options = {
    from: DEFAULT_SOURCE,
    out: path.join(cwd, "resources"),
    toolIconsOnly: false,
    themesOnly: false,
    docsOnly: false,
    helpersOnly: false,
    includeWebui: false,
    webuiOnly: false,
    webuiFrom: DEFAULT_WEBUI_SOURCE,
    dryRun: false,
    noClean: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--from") options.from = requireValue(args, ++index, arg);
    else if (arg === "--out") options.out = requireValue(args, ++index, arg);
    else if (arg === "--tool-icons-only") options.toolIconsOnly = true;
    else if (arg === "--themes-only") options.themesOnly = true;
    else if (arg === "--docs-only") options.docsOnly = true;
    else if (arg === "--helpers-only") options.helpersOnly = true;
    else if (arg === "--include-webui") options.includeWebui = true;
    else if (arg === "--webui-only") options.webuiOnly = true;
    else if (arg === "--webui-from") options.webuiFrom = requireValue(args, ++index, arg);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-clean") options.noClean = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if ([options.toolIconsOnly, options.themesOnly, options.docsOnly, options.helpersOnly, options.webuiOnly].filter(Boolean).length > 1) {
    throw new Error("Choose only one of --tool-icons-only, --themes-only, --docs-only, --helpers-only, or --webui-only.");
  }
  return options;
}

export function resourceImportHelp() {
  return `import-yuumira-resources [--from /Applications/YuuMira.app/Contents/Resources/resources] [--out resources] [--tool-icons-only] [--themes-only] [--docs-only] [--helpers-only] [--include-webui] [--webui-only] [--webui-from /Applications/YuuMira.app/Contents/Resources/server/resources/webui] [--dry-run] [--no-clean]

Import authorized YuuMira static resources into this clean-room workspace.
`;
}

function selectedResourceDirectories(options) {
  if (options.webuiOnly) return [];
  if (options.toolIconsOnly) return ["tool-icons"];
  if (options.themesOnly) return ["themes"];
  if (options.docsOnly) return ["docs", "release-notes"];
  if (options.helpersOnly) return ["bin", "scripts"];
  return DEFAULT_DIRECTORIES;
}

function selectedResourceFiles(options) {
  if (options.toolIconsOnly || options.themesOnly || options.docsOnly || options.helpersOnly || options.webuiOnly) return [];
  return DEFAULT_FILES;
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

async function describeDirectory(directory) {
  let fileCount = 0;
  let byteCount = 0;
  const rootStat = await stat(directory);
  if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${directory}`);

  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (shouldIgnoreResourceEntry(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        const fileStat = await stat(fullPath);
        fileCount += 1;
        byteCount += fileStat.size;
      }
    }
  }

  await visit(directory);
  return { fileCount, byteCount };
}

async function copyDirectoryContents(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (shouldIgnoreResourceEntry(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await cp(sourcePath, destinationPath, { force: true });
    }
  }
}

async function removeFileVariants(directory, fileName) {
  const parsed = path.parse(fileName);
  const pattern = new RegExp(`^${escapeRegExp(parsed.name)}(?: \\d+)?${escapeRegExp(parsed.ext)}$`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && pattern.test(entry.name)) {
      await rm(path.join(directory, entry.name), { force: true });
    }
  }
}

async function removeDirectoryVariants(directory, directoryName) {
  const pattern = new RegExp(`^${escapeRegExp(directoryName)}(?: \\d+)?$`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && pattern.test(entry.name)) {
      await rm(path.join(directory, entry.name), { recursive: true, force: true });
    }
  }
}

export async function cleanFinderDuplicateVariants(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (isFinderDuplicateVariant(entry.name)) {
      await rm(fullPath, { recursive: entry.isDirectory(), force: true });
    } else if (entry.isDirectory()) {
      await cleanFinderDuplicateVariants(fullPath);
    }
  }
}

function isFinderDuplicateVariant(name) {
  const parsed = path.parse(name);
  return / \d+$/.test(parsed.name);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldIgnoreResourceEntry(name) {
  return name.startsWith(".") || IGNORED_RESOURCE_NAMES.has(name) || IGNORED_RESOURCE_EXTENSIONS.has(path.extname(name));
}
