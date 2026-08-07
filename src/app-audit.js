import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { listHelperBehaviorProfiles, listHelperSmokeProfiles } from "./helpers.js";
import { webuiEntrypointIntegrity } from "./resources.js";

export const DEFAULT_PENG_APP = path.join(process.cwd(), "dist", "Peng.app");
export const WEBUI_RPC_NAMESPACES = [
  "remote",
  "server",
  "sessions",
  "tasks",
  "projects",
  "workspaces",
  "window",
  "file",
  "fs",
  "debug",
  "theme",
  "system",
  "update",
  "shell",
  "menu",
  "deeplink",
  "auth",
  "credentials",
  "onboarding",
  "LLM_Connection",
  "chatgpt",
  "copilot",
  "xai",
  "settings",
  "pi",
  "dialog",
  "preferences",
  "drafts",
  "sources",
  "oauth",
  "workspace",
  "permissions",
  "skills",
  "statuses",
  "labels",
  "views",
  "toolIcons",
  "logo",
  "notification",
  "input",
  "power",
  "appearance",
  "tools",
  "computerUse",
  "caching",
  "rtk",
  "memory",
  "observability",
  "usageQuota",
  "loop",
  "goal",
  "knowledge",
  "terminal",
  "pilot",
  "badge",
  "releaseNotes",
  "git",
  "gitbash",
  "browser-pane",
  "browser-empty-state",
  "automations",
  "resources",
  "messaging"
];

export function auditPengBundle({
  appPath = DEFAULT_PENG_APP,
  workspace = process.cwd(),
  resourceDir = path.join(workspace, "resources")
} = {}) {
  const app = inspectInstalledBundle(appPath);
  const clone = inspectWorkspaceClone({ workspace, resourceDir });
  clone.exportCoverage = inspectExportCoverage({ app, workspace });
  return {
    version: 1,
    appPath,
    workspace,
    generatedAt: new Date().toISOString(),
    app,
    clone,
    comparisons: compareBundleToClone(app, clone)
  };
}

export function inspectInstalledBundle(appPath = DEFAULT_PENG_APP) {
  const contents = path.join(appPath, "Contents");
  const resources = path.join(contents, "Resources");
  const server = path.join(resources, "server");
  const sharedResources = path.join(resources, "resources");
  const serverResources = path.join(server, "resources");
  const webui = path.join(serverResources, "webui");
  const info = readInfoPlist(path.join(contents, "Info.plist"));
  const packageManifests = listPackageManifests(server);
  const serverPackage = readPackageJson(path.join(server, "package.json"));
  const bundleManifest = readPackageJson(path.join(server, "bundle-manifest.json"));
  return {
    exists: existsSync(appPath),
    bundleIdentifier: info.CFBundleIdentifier ?? null,
    version: info.CFBundleShortVersionString ?? info.CFBundleVersion ?? null,
    executable: info.CFBundleExecutable ?? null,
    urlSchemes: info.CFBundleURLSchemes ?? [],
    paths: {
      contents,
      resources,
      server,
      sharedResources,
      serverResources,
      webui
    },
    components: {
      serverBinary: fileSummary(existsSync(path.join(server, "craft-server")) ? path.join(server, "craft-server") : path.join(server, "bin", "craft-server")),
      bunBinary: fileSummary(existsSync(path.join(server, "bun")) ? path.join(server, "bun") : path.join(server, "vendor", "bun", "bun")),
      nodeBinary: fileSummary(path.join(server, "node")),
      serverEntrypoint: fileSummary(path.join(server, "bin", "craft-server.mjs")),
      serverSource: directorySummary(path.join(server, "src")),
      webui: directorySummary(webui),
      sharedResources: directorySummary(sharedResources),
      serverResources: directorySummary(serverResources),
      helperBins: directorySummary(path.join(sharedResources, "bin")),
      helperScripts: directorySummary(path.join(sharedResources, "scripts")),
      toolIcons: directorySummary(path.join(sharedResources, "tool-icons")),
      themes: directorySummary(path.join(sharedResources, "themes")),
      docs: directorySummary(path.join(sharedResources, "docs")),
      permissions: directorySummary(path.join(sharedResources, "permissions")),
      releaseNotes: directorySummary(path.join(sharedResources, "release-notes")),
      craftLogos: directorySummary(path.join(sharedResources, "craft-logos")),
      configDefaults: fileSummary(path.join(sharedResources, "config-defaults.json")),
      sourceImage: fileSummary(path.join(sharedResources, "source.png"))
    },
    packages: {
      root: serverPackage ? {
        name: serverPackage.name,
        version: serverPackage.version,
        private: serverPackage.private === true,
        workspaces: serverPackage.workspaces ?? null,
        sha256: hashFile(path.join(server, "package.json"))
      } : null,
      names: packageManifests.map((manifest) => manifest.name).filter(Boolean).sort(),
      manifests: packageManifests,
      fingerprint: hashManifestList(packageManifests)
    },
    bundleManifest
  };
}

export function inspectWorkspaceClone({ workspace = process.cwd(), resourceDir = path.join(workspace, "resources") } = {}) {
  const webuiSummary = directorySummary(path.join(resourceDir, "webui"));
  const sharedSummary = directorySummary(resourceDir);
  const helperBins = directorySummary(path.join(resourceDir, "bin"));
  const helperScripts = directorySummary(path.join(resourceDir, "scripts"));
  const toolIcons = directorySummary(path.join(resourceDir, "tool-icons"));
  const themes = directorySummary(path.join(resourceDir, "themes"));
  const docs = directorySummary(path.join(resourceDir, "docs"));
  const permissions = directorySummary(path.join(resourceDir, "permissions"));
  const releaseNotes = directorySummary(path.join(resourceDir, "release-notes"));
  const craftLogos = directorySummary(path.join(resourceDir, "craft-logos"));
  const duplicateVariants = resourceDuplicateVariants(resourceDir);
  const webuiEntrypoints = webuiEntrypointIntegrity({ resourceDir });
  const webuiRpcCoverage = inspectWebuiRpcCoverage({ workspace, resourceDir });
  return {
    exists: existsSync(workspace),
    package: readPackageJson(path.join(workspace, "package.json")),
    resourceDir,
    resources: {
      toolIcons: countFiles(path.join(resourceDir, "tool-icons"), [".png", ".jpg", ".jpeg", ".svg", ".ico", ".json"]),
      themes: countFiles(path.join(resourceDir, "themes"), [".json"]),
      docs: countFiles(path.join(resourceDir, "docs"), [".md"]),
      permissions: countFiles(path.join(resourceDir, "permissions"), [".json"]),
      releaseNotes: countFiles(path.join(resourceDir, "release-notes"), [".md"]),
      logos: countFiles(path.join(resourceDir, "craft-logos"), [".png", ".jpg", ".jpeg", ".svg", ".ico"]),
      bins: helperBins.fileCount,
      scripts: countFiles(path.join(resourceDir, "scripts"), [".py", ".mjs", ".ps1"]),
      scriptTests: countFiles(path.join(resourceDir, "scripts", "tests"), [".py", ".md"]),
      webui: webuiSummary.fileCount,
      files: ["config-defaults.json", "source.png"].filter((file) => existsSync(path.join(resourceDir, file))).length
    },
    components: {
      webui: webuiSummary,
      sharedResources: sharedSummary,
      helperBins,
      helperScripts,
      toolIcons,
      themes,
      docs,
      permissions,
      releaseNotes,
      craftLogos,
      configDefaults: fileSummary(path.join(resourceDir, "config-defaults.json")),
      sourceImage: fileSummary(path.join(resourceDir, "source.png"))
    },
    duplicateVariants,
    webuiEntrypoints,
    webuiRpcCoverage,
    smokeProfiles: listHelperSmokeProfiles().map((profile) => profile.id),
    behaviorProfiles: listHelperBehaviorProfiles().map((profile) => profile.id)
  };
}

function countFiles(directory, extensions = null) {
  if (!existsSync(directory)) return 0;
  let count = 0;
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (shouldIgnore(entry.name)) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && (!extensions || extensions.some((extension) => entry.name.endsWith(extension)))) count += 1;
    }
  }
  visit(directory);
  return count;
}

export function compareBundleToClone(app, clone) {
  const requiredBehaviorProfiles = [
    "ical-basic",
    "xlsx-basic",
    "docx-basic",
    "img-basic",
    "markitdown-basic",
    "pdf-basic",
    "pptx-basic",
    "doc-diff-basic"
  ];
  const checks = [
    check("bundle.exists", app.exists === true, "Installed Peng.app is readable"),
    check("bundle.identity", app.bundleIdentifier === "com.yaserxuanfrankfaraz.peng", "Bundle identifier matches Peng"),
    check("bundle.executable", app.executable === "Peng", "Bundle executable matches Peng"),
    check("bundle.urlSchemes", ["peng", "craftagents"].every((scheme) => app.urlSchemes.includes(scheme)), "URL schemes include peng and craftagents"),
    check("server.binary", app.components.serverBinary.exists || app.components.bunBinary.exists || app.components.nodeBinary.exists || app.components.serverEntrypoint.exists, "Peng bundle contains a runnable server runtime"),
    check("server.packages", independentBundleManifest(app) || installedPackagesMatchObserved(app), "Peng bundle contains a valid self-contained server manifest"),
    check("server.exports.observed", independentBundleManifest(app)
      ? app.components.serverSource.exists && clone.exportCoverage.modules.length > 0
      : clone.exportCoverage.totalExports > 0 && clone.exportCoverage.packages.some((pkg) => pkg.name === "@craft-agent/shared" && pkg.totalExports > 0), "Peng server source is bundled and represented in the local module map"),
    check("server.webui", app.components.webui.fileCount > 0 && clone.components.webui.fileCount > 0, "Server web UI assets exist in both bundle and clone resources"),
    check("resources.webui.fingerprint", sameDirectoryFingerprint(app.components.webui, clone.components.webui), "Clone webui file manifest and content fingerprint match installed Peng"),
    check("resources.webui.entrypoints", clone.webuiEntrypoints.ok === true, "Clone web UI entrypoint HTML references resolve to imported assets"),
    check("resources.webui.rpc", clone.webuiRpcCoverage.total > 0 && clone.webuiRpcCoverage.missing.length === 0, "Clone server handles all recognized RPC channel constants extracted from imported Web UI assets"),
    check("resources.shared.fingerprints", sharedResourceFingerprintsMatch(app.components, clone.components), "Clone shared resource manifests and content fingerprints match installed Peng"),
    check("resources.rootFiles", rootResourceFilesMatch(app.components, clone.components), "Clone root resource files match installed Peng"),
    check("resources.duplicates", clone.duplicateVariants.total === 0, "Clone resources do not contain Finder-style duplicate file variants"),
    check("resources.helpers", clone.resources.bins >= 8 && clone.resources.scripts >= 8, "Clone has helper bin wrappers and scripts"),
    check("helpers.behavior", requiredBehaviorProfiles.every((id) => clone.behaviorProfiles.includes(id)), "Clone exposes behavior smoke profiles for all document/media helpers")
  ];
  return {
    ok: checks.every((item) => item.ok),
    checks,
    gaps: checks.filter((item) => !item.ok)
  };
}

export function inspectWebuiRpcCoverage({
  workspace = process.cwd(),
  resourceDir = path.join(workspace, "resources"),
  serverSourcePath = path.join(workspace, "src", "server.js")
} = {}) {
  const channels = extractWebuiRpcChannels(path.join(resourceDir, "webui"));
  const serverSource = existsSync(serverSourcePath) ? readFileSync(serverSourcePath, "utf8") : "";
  const missing = channels.filter((channel) => !serverHandlesRpcChannel(serverSource, channel));
  return {
    total: channels.length,
    implemented: channels.length - missing.length,
    missing,
    channels
  };
}

export function extractWebuiRpcChannels(webuiDirectory, namespaces = WEBUI_RPC_NAMESPACES) {
  if (!existsSync(webuiDirectory)) return [];
  const namespaceSet = new Set(namespaces);
  const channels = new Set();
  for (const relativePath of listRelativeFiles(webuiDirectory)) {
    if (![".html", ".js", ".mjs"].some((extension) => relativePath.endsWith(extension))) continue;
    const content = readFileSync(path.join(webuiDirectory, relativePath), "utf8");
    for (const match of content.matchAll(/["']([A-Za-z_][A-Za-z0-9_-]*(?::[A-Za-z0-9_-][A-Za-z0-9_./-]*)+)["']/g)) {
      const namespace = match[1].split(":")[0];
      if (namespaceSet.has(namespace)) channels.add(match[1]);
    }
  }
  return [...channels].sort();
}

function serverHandlesRpcChannel(serverSource, channel) {
  const namespace = channel.split(":")[0];
  return serverSource.includes(`"${channel}"`)
    || serverSource.includes(`'${channel}'`)
    || serverSource.includes(`channel.startsWith("${namespace}:")`)
    || serverSource.includes(`channel.startsWith('${namespace}:')`);
}

function inspectExportCoverage({ app, workspace }) {
  const modules = listCloneModules(workspace);
  const packages = (app.packages.manifests ?? [])
    .filter((manifest) => manifest.exports.length > 0)
    .map((manifest) => {
      const exports = manifest.exports.map((exportPath) => {
        const candidates = candidateModulesForExport(manifest.name, exportPath);
        const matches = candidates.filter((candidate) => modules.includes(candidate));
        return {
          exportPath,
          candidates,
          matched: matches.length > 0,
          matches
        };
      });
      return {
        name: manifest.name,
        totalExports: exports.length,
        matchedExports: exports.filter((item) => item.matched).length,
        missingExports: exports.filter((item) => !item.matched).map((item) => item.exportPath),
        exports
      };
    });
  const totalExports = packages.reduce((sum, pkg) => sum + pkg.totalExports, 0);
  const matchedExports = packages.reduce((sum, pkg) => sum + pkg.matchedExports, 0);
  return {
    modules,
    totalExports,
    matchedExports,
    missingExports: totalExports - matchedExports,
    coverage: totalExports > 0 ? matchedExports / totalExports : 0,
    packages
  };
}

function listCloneModules(workspace) {
  const src = path.join(workspace, "src");
  if (!existsSync(src)) return [];
  return readdirSync(src)
    .filter((file) => file.endsWith(".js"))
    .map((file) => file.replace(/\.js$/, ""))
    .sort();
}

function candidateModulesForExport(packageName, exportPath) {
  const normalized = String(exportPath).replace(/^\.\//, "").replace(/^\.$/, "");
  const first = normalized.split("/").filter(Boolean)[0] ?? "";
  const exact = {
    "": ["runtime", "server-entry"],
    agent: ["runtime", "provider", "run-control"],
    auth: ["oauth", "credentials"],
    automations: ["automations"],
    config: ["config"],
    credentials: ["credentials", "secure-credentials"],
    docs: ["resources"],
    "feature-flags": ["config"],
    git: ["git"],
    goals: ["runtime", "protocol"],
    knowledge: ["knowledge"],
    labels: ["labels"],
    loop: ["runtime", "streaming", "queue", "run-control"],
    mcp: ["mcp", "sources"],
    memory: ["memory"],
    projects: ["domain"],
    protocol: ["protocol"],
    resources: ["resources"],
    scheduler: ["automations"],
    search: ["search"],
    sessions: ["domain"],
    skills: ["skills"],
    sources: ["sources"],
    tasks: ["tasks"],
    terminal: ["terminal"],
    tools: ["tools"],
    validation: ["permissions", "sources", "statuses", "labels"],
    views: ["views"],
    workspaces: ["store", "domain"]
  };
  if (packageName === "@craft-agent/server-core") {
    return {
      "": ["server", "server-entry"],
      bootstrap: ["server-entry"],
      domain: ["domain"],
      handlers: ["server"],
      loop: ["runtime", "streaming"],
      runtime: ["runtime"],
      services: ["server", "tools"],
      sessions: ["domain"],
      transport: ["server"],
      webui: ["server"]
    }[first] ?? [first].filter(Boolean);
  }
  if (packageName === "@craft-agent/core") {
    return ["runtime", "tools", "id"];
  }
  if (packageName === "@craft-agent/session-tools-core") {
    return ["tools", "helpers"];
  }
  return exact[first] ?? [first].filter(Boolean);
}

function installedPackagesMatchObserved(app) {
  const expectedNames = [
    "@craft-agent/core",
    "@craft-agent/messaging-gateway",
    "@craft-agent/messaging-whatsapp-worker",
    "@craft-agent/pi-agent-server",
    "@craft-agent/server",
    "@craft-agent/server-core",
    "@craft-agent/session-tools-core",
    "@craft-agent/shared"
  ];
  const manifests = app.packages.manifests ?? [];
  return app.packages.root?.name === "craft-server-dist"
    && app.packages.root?.version === app.version
    && expectedNames.every((name) => app.packages.names.includes(name))
    && manifests.length === expectedNames.length
    && manifests.every((manifest) => manifest.version === app.version)
    && manifests.every((manifest) => manifest.license === "Apache-2.0")
    && typeof app.packages.fingerprint === "string"
    && app.packages.fingerprint.length === 64;
}

function independentBundleManifest(app) {
  return app.bundleManifest?.name === "Peng"
    && app.bundleManifest.version === app.version
    && app.bundleManifest.bundleIdentifier === "com.yaserxuanfrankfaraz.peng"
    && app.bundleManifest.server?.entrypoint
    && (app.bundleManifest.server?.binary || app.bundleManifest.server?.bun || app.bundleManifest.server?.node);
}

function sameDirectoryFingerprint(left, right) {
  return left.exists === true
    && right.exists === true
    && left.fileCount === right.fileCount
    && left.byteCount === right.byteCount
    && left.sha256 === right.sha256;
}

function sharedResourceFingerprintsMatch(appComponents, cloneComponents) {
  return ["helperBins", "helperScripts", "toolIcons", "themes", "docs", "permissions", "releaseNotes", "craftLogos"]
    .every((key) => sameDirectoryFingerprint(appComponents[key], cloneComponents[key]));
}

function rootResourceFilesMatch(appComponents, cloneComponents) {
  return ["configDefaults", "sourceImage"]
    .every((key) => appComponents[key].exists === true
      && cloneComponents[key].exists === true
      && appComponents[key].byteCount === cloneComponents[key].byteCount
      && appComponents[key].sha256 === cloneComponents[key].sha256);
}

function check(id, ok, description) {
  return { id, ok: Boolean(ok), description };
}

function readInfoPlist(file) {
  if (!existsSync(file)) return {};
  const content = readFileSync(file, "utf8");
  const result = {};
  for (const key of ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion", "CFBundleExecutable"]) {
    const match = content.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`));
    if (match) result[key] = decodeXml(match[1]);
  }
  const schemeBlock = content.match(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/);
  result.CFBundleURLSchemes = schemeBlock
    ? [...schemeBlock[1].matchAll(/<string>([^<]+)<\/string>/g)].map((match) => decodeXml(match[1]))
    : [];
  return result;
}

function readPackageJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listPackageManifests(serverDirectory) {
  const directory = path.join(serverDirectory, "packages");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map((entry) => packageManifestSummary(path.join(directory, entry, "package.json"), serverDirectory))
    .filter(Boolean)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function packageManifestSummary(file, serverDirectory) {
  const pkg = readPackageJson(file);
  if (!pkg) return null;
  return {
    relativePath: path.relative(serverDirectory, file),
    name: pkg.name ?? null,
    version: pkg.version ?? null,
    license: pkg.license ?? null,
    private: pkg.private === true,
    type: pkg.type ?? null,
    main: pkg.main ?? null,
    bin: pkg.bin ? Object.keys(pkg.bin).sort() : [],
    exports: pkg.exports ? Object.keys(pkg.exports).sort() : [],
    dependencies: Object.keys(pkg.dependencies ?? {}).sort(),
    devDependencies: Object.keys(pkg.devDependencies ?? {}).sort(),
    peerDependencies: Object.keys(pkg.peerDependencies ?? {}).sort(),
    sha256: hashFile(file)
  };
}

function hashManifestList(manifests) {
  const hash = createHash("sha256");
  for (const manifest of manifests) {
    hash.update(manifest.relativePath);
    hash.update("\0");
    hash.update(manifest.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function resourceDuplicateVariants(resourceDir) {
  const directories = ["tool-icons", "themes", "docs", "permissions", "release-notes", "craft-logos", "bin", "scripts", "webui"];
  const byDirectory = {};
  let total = 0;
  const rootVariants = duplicateVariants(resourceDir, { recursive: false });
  if (rootVariants.length > 0) {
    byDirectory["."] = rootVariants;
    total += rootVariants.reduce((sum, item) => sum + item.files.length - 1, 0);
  }
  for (const directory of directories) {
    const variants = duplicateVariants(path.join(resourceDir, directory));
    if (variants.length > 0) {
      byDirectory[directory] = variants;
      total += variants.reduce((sum, item) => sum + item.files.length - 1, 0);
    }
  }
  return { total, byDirectory };
}

function duplicateVariants(directory, { recursive = true } = {}) {
  if (!existsSync(directory)) return [];
  const groups = new Map();
  for (const file of listRelativeFiles(directory, { recursive })) {
    const canonical = file.replace(/(^|\/)([^/]+?) \d+(\.[^/.]+)?$/u, "$1$2$3");
    if (canonical === file) continue;
    const files = groups.get(canonical) ?? new Set([canonical]);
    files.add(file);
    groups.set(canonical, files);
  }
  return [...groups.entries()]
    .map(([canonical, files]) => ({ canonical, files: [...files].sort() }))
    .sort((left, right) => left.canonical.localeCompare(right.canonical));
}

function listRelativeFiles(directory, { recursive = true } = {}) {
  const files = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (shouldIgnore(entry.name)) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory() && recursive) visit(file);
      else if (entry.isFile()) files.push(path.relative(directory, file));
    }
  }
  visit(directory);
  return files;
}

function fileSummary(file) {
  try {
    const fileStat = statSync(file);
    return {
      exists: fileStat.isFile(),
      byteCount: fileStat.isFile() ? fileStat.size : 0,
      sha256: fileStat.isFile() ? hashFile(file) : null
    };
  } catch {
    return { exists: false, byteCount: 0, sha256: null };
  }
}

function directorySummary(directory) {
  let fileCount = 0;
  let byteCount = 0;
  let directoryCount = 0;
  const files = [];
  if (!existsSync(directory)) return { exists: false, fileCount, directoryCount, byteCount, sha256: null };
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (shouldIgnore(entry.name)) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        directoryCount += 1;
        visit(file);
      } else if (entry.isFile()) {
        let fileStat;
        let sha256;
        try {
          fileStat = statSync(file);
          sha256 = hashFile(file);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        fileCount += 1;
        byteCount += fileStat.size;
        files.push({
          relativePath: path.relative(directory, file),
          byteCount: fileStat.size,
          sha256
        });
      }
    }
  }
  visit(directory);
  return { exists: true, fileCount, directoryCount, byteCount, sha256: hashFileList(files) };
}

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function hashFileList(files) {
  const hash = createHash("sha256");
  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(file.byteCount));
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function shouldIgnore(name) {
  return name.startsWith(".") || name === "__pycache__" || name.endsWith(".pyc") || name.endsWith(".pyo");
}

function decodeXml(value) {
  return String(value)
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}
