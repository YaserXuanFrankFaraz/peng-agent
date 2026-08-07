import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const TOOL_ICON_RESOURCE = {
  version: 1,
  tools: [
    { id: "craft-agent", displayName: "Peng CLI", icon: "craft-agent.svg", commands: ["craft-agent", "peng", "yuumira"] },
    { id: "git", displayName: "Git", icon: "git.ico", commands: ["git"] },
    { id: "github", displayName: "GitHub", icon: "github.png", commands: ["gh"] },
    { id: "npm", displayName: "npm", icon: "npm.png", commands: ["npm", "npx"] },
    { id: "yarn", displayName: "Yarn", icon: "yarn.svg", commands: ["yarn"] },
    { id: "pnpm", displayName: "pnpm", icon: "pnpm.png", commands: ["pnpm"] },
    { id: "bun", displayName: "Bun", icon: "bun.png", commands: ["bun", "bunx"] },
    { id: "pypi", displayName: "PyPI", icon: "pypi.png", commands: ["pip", "pip3"] },
    { id: "rust", displayName: "Rust", icon: "rust.png", commands: ["cargo", "rustc", "rustup"] },
    { id: "homebrew", displayName: "Homebrew", icon: "homebrew.png", commands: ["brew"] },
    { id: "node", displayName: "Node.js", icon: "nodedotjs.png", commands: ["node"] },
    { id: "python", displayName: "Python", icon: "python.ico", commands: ["python", "python3"] },
    { id: "docker", displayName: "Docker", icon: "docker.png", commands: ["docker", "docker-compose"] },
    { id: "kubernetes", displayName: "Kubernetes", icon: "kubernetes.png", commands: ["kubectl", "k9s"] },
    { id: "terraform", displayName: "Terraform", icon: "terraform.png", commands: ["terraform"] },
    { id: "aws", displayName: "AWS", icon: "amazonaws.png", commands: ["aws"] },
    { id: "gcloud", displayName: "Google Cloud", icon: "googlecloud.png", commands: ["gcloud"] },
    { id: "azure", displayName: "Azure", icon: "microsoftazure.ico", commands: ["az"] },
    { id: "vercel", displayName: "Vercel", icon: "vercel.png", commands: ["vercel"] },
    { id: "netlify", displayName: "Netlify", icon: "netlify.png", commands: ["netlify"] },
    { id: "cloudflare", displayName: "Cloudflare", icon: "cloudflare.png", commands: ["wrangler"] },
    { id: "stripe", displayName: "Stripe", icon: "stripe.png", commands: ["stripe"] },
    { id: "firebase", displayName: "Firebase", icon: "firebase.png", commands: ["firebase"] },
    { id: "supabase", displayName: "Supabase", icon: "supabase.png", commands: ["supabase"] },
    { id: "sentry", displayName: "Sentry", icon: "sentry.png", commands: ["sentry-cli"] },
    { id: "gnumake", displayName: "GNU Make", icon: "gnumake.png", commands: ["make"] },
    { id: "jest", displayName: "Jest", icon: "jest.png", commands: ["jest"] },
    { id: "vitest", displayName: "Vitest", icon: "vitest.png", commands: ["vitest"] },
    { id: "pytest", displayName: "pytest", icon: "pytest.png", commands: ["pytest"] },
    { id: "eslint", displayName: "ESLint", icon: "eslint.png", commands: ["eslint"] },
    { id: "prettier", displayName: "Prettier", icon: "prettier.png", commands: ["prettier"] },
    { id: "vite", displayName: "Vite", icon: "vite.svg", commands: ["vite"] },
    { id: "jq", displayName: "jq", icon: "jq.png", commands: ["jq"] },
    { id: "curl", displayName: "curl", icon: "curl.svg", commands: ["curl"] },
    { id: "openssh", displayName: "OpenSSH", icon: "openssh.png", commands: ["ssh", "scp"] },
    { id: "xcode", displayName: "Xcode", icon: "xcode.png", commands: ["xcodebuild", "xcrun"] }
  ]
};

const FALLBACK_RESOURCE_MANIFEST = {
  version: 1,
  roots: {
    toolIcons: "/resources/tool-icons/",
    themes: "/resources/themes/",
    docs: "/resources/docs/",
    releaseNotes: "/resources/release-notes/",
    permissions: "/resources/permissions/",
    logos: "/resources/craft-logos/",
    bins: "/resources/bin/",
    scripts: "/resources/scripts/",
    webui: "/resources/webui/",
    shared: "/resources/"
  },
  themes: [
    {
      id: "default",
      displayName: "Default",
      path: "/resources/themes/default.json",
      colors: {
        background: "#0f172a",
        surface: "#111827",
        accent: "#38bdf8",
        text: "#e5e7eb"
      }
    }
  ]
};

export function listToolIcons() {
  const resource = loadImportedToolIcons() ?? TOOL_ICON_RESOURCE;
  return {
    ...resource,
    tools: resource.tools.map(enrichToolIcon)
  };
}

export function resolveToolIcon(commandLine) {
  const command = extractCommand(commandLine);
  const tool = listToolIcons().tools.find((item) => item.commands.includes(command));
  return {
    command,
    matched: Boolean(tool),
    tool: tool ?? null
  };
}

export function resourceManifest() {
  const icons = listToolIcons().tools.map((tool) => ({
    id: tool.id,
    displayName: tool.displayName,
    path: tool.path,
    contentType: contentTypeForResource(tool.icon)
  }));
  const themes = listImportedThemes();
  const docs = listImportedResources("docs", [".md"]);
  const releaseNotes = listImportedResources("release-notes", [".md"]);
  const permissions = listImportedResources("permissions", [".json"]);
  const logos = listImportedResources("craft-logos", [".png", ".jpg", ".jpeg", ".svg", ".ico"]);
  const bins = listImportedResources("bin", null);
  const scripts = listImportedResources("scripts", [".py", ".mjs", ".ps1"]);
  const scriptTests = listImportedResources("scripts/tests", [".py", ".md"]);
  const webui = listImportedResourcesRecursive("webui");
  const webuiEntrypoints = webuiEntrypointIntegrity();
  const rootFiles = listImportedRootFiles(["config-defaults.json", "source.png"]);
  return {
    ...FALLBACK_RESOURCE_MANIFEST,
    themes: themes.length ? themes : FALLBACK_RESOURCE_MANIFEST.themes,
    docs,
    releaseNotes,
    permissions,
    logos,
    bins,
    scripts,
    scriptTests,
    webui,
    webuiEntrypoints,
    files: rootFiles,
    toolIcons: {
      version: listToolIcons().version,
      count: icons.length,
      icons
    }
  };
}

export function webuiEntrypointIntegrity({ resourceDir = resourceRoot(), entrypoints = ["index.html", "login.html"] } = {}) {
  const webuiRoot = path.join(resourceDir, "webui");
  const reports = entrypoints
    .map((entrypoint) => inspectWebuiEntrypoint({ webuiRoot, entrypoint }))
    .filter(Boolean);
  const missing = reports.flatMap((report) => report.missing.map((item) => ({ entrypoint: report.entrypoint, ...item })));
  return {
    ok: reports.length > 0 && missing.length === 0,
    entrypoints: reports,
    missing,
    checkedCount: reports.reduce((sum, report) => sum + report.references.length, 0)
  };
}

export function resolveResource(pathname) {
  const path = normalizeResourcePath(pathname);
  if (path === "/resources/manifest.json") {
    return jsonResource(resourceManifest());
  }
  if (path === "/resources/tool-icons/tool-icons.json") {
    return jsonResource(listToolIcons());
  }
  const realFile = resolveImportedResourceFile(path);
  if (realFile) {
    return {
      contentType: contentTypeForResource(realFile),
      body: readFileSync(realFile),
      etag: `resource-file-${path}`
    };
  }
  if (path === "/resources/themes/default.json") {
    return jsonResource(FALLBACK_RESOURCE_MANIFEST.themes[0]);
  }
  const iconMatch = path.match(/^\/resources\/tool-icons\/([^/]+)$/);
  if (iconMatch) {
    const fileName = decodeURIComponent(iconMatch[1]);
    const tool = listToolIcons().tools.find((item) => item.icon === fileName);
    if (tool) {
      return {
        contentType: "image/svg+xml; charset=utf-8",
        body: renderIconPlaceholder(tool),
        etag: `tool-icon-${tool.id}-${TOOL_ICON_RESOURCE.version}`
      };
    }
  }
  return null;
}

export function contentTypeForResource(fileName) {
  if (fileName.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (fileName.endsWith(".png")) return "image/png";
  if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) return "image/jpeg";
  if (fileName.endsWith(".ico")) return "image/x-icon";
  if (fileName.endsWith(".html")) return "text/html; charset=utf-8";
  if (fileName.endsWith(".css")) return "text/css; charset=utf-8";
  if (fileName.endsWith(".json")) return "application/json; charset=utf-8";
  if (fileName.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (fileName.endsWith(".py")) return "text/x-python; charset=utf-8";
  if (fileName.endsWith(".ps1")) return "text/x-powershell; charset=utf-8";
  if (fileName.endsWith(".mjs") || fileName.endsWith(".js") || fileName.endsWith(".cjs")) return "text/javascript; charset=utf-8";
  if (!fileName.includes(".")) return "text/x-shellscript; charset=utf-8";
  if (fileName.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (fileName.endsWith(".woff")) return "font/woff";
  if (fileName.endsWith(".woff2")) return "font/woff2";
  if (fileName.endsWith(".ttf")) return "font/ttf";
  return "application/octet-stream";
}

function enrichToolIcon(tool) {
  return {
    ...tool,
    path: `/resources/tool-icons/${encodeURIComponent(tool.icon)}`,
    contentType: contentTypeForResource(tool.icon)
  };
}

function jsonResource(value) {
  return {
    contentType: "application/json; charset=utf-8",
    body: `${JSON.stringify(value, null, 2)}\n`,
    etag: `resource-json-${FALLBACK_RESOURCE_MANIFEST.version}`
  };
}

function loadImportedToolIcons() {
  const file = path.join(resourceRoot(), "tool-icons", "tool-icons.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(parsed.tools)) return parsed;
  } catch {
    return null;
  }
  return null;
}

function listImportedThemes() {
  const dir = path.join(resourceRoot(), "themes");
  if (!existsSync(dir)) return [];
  const themes = [];
  const fileNames = readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort((left, right) => themeSortKey(left).localeCompare(themeSortKey(right)));
  for (const fileName of fileNames) {
    const file = path.join(dir, fileName);
    try {
      const theme = JSON.parse(readFileSync(file, "utf8"));
      themes.push({
        id: fileName.replace(/\.json$/, ""),
        displayName: theme.name ?? fileName,
        path: `/resources/themes/${fileName}`,
        colors: {
          background: theme.background,
          surface: theme.popoverSolid ?? theme.dark?.background ?? theme.background,
          accent: theme.accent,
          text: theme.foreground
        },
        metadata: theme
      });
    } catch {
      // Ignore malformed imported themes; the fallback manifest remains available.
    }
  }
  return themes;
}

function listImportedResources(directory, extensions) {
  const dir = path.join(resourceRoot(), directory);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((fileName) => !extensions || extensions.some((extension) => fileName.endsWith(extension)))
    .sort(naturalResourceSort)
    .filter((fileName) => {
      try {
        return statSync(path.join(dir, fileName)).isFile();
      } catch {
        return false;
      }
    })
    .map((fileName) => ({
      id: fileName.replace(/\.[^.]+$/, ""),
      fileName,
      path: `/resources/${directory}/${encodeURIComponent(fileName)}`,
      contentType: contentTypeForResource(fileName)
    }));
}

function listImportedResourcesRecursive(directory, extensions = null) {
  const root = path.join(resourceRoot(), directory);
  if (!existsSync(root)) return [];
  const files = [];
  function visit(current, prefix) {
    for (const fileName of readdirSync(current).sort(naturalResourceSort)) {
      const file = path.join(current, fileName);
      const relative = prefix ? `${prefix}/${fileName}` : fileName;
      let fileStat;
      try {
        fileStat = statSync(file);
      } catch {
        continue;
      }
      if (fileStat.isDirectory()) {
        visit(file, relative);
      } else if (fileStat.isFile() && (!extensions || extensions.some((extension) => fileName.endsWith(extension)))) {
        files.push({
          id: relative.replace(/\.[^.]+$/, ""),
          fileName,
          relativePath: relative,
          path: `/resources/${directory}/${relative.split("/").map(encodeURIComponent).join("/")}`,
          contentType: contentTypeForResource(fileName),
          byteCount: fileStat.size
        });
      }
    }
  }
  visit(root, "");
  return files;
}

function listImportedRootFiles(fileNames) {
  return fileNames
    .map((fileName) => {
      const file = path.join(resourceRoot(), fileName);
      try {
        if (!statSync(file).isFile()) return null;
      } catch {
        return null;
      }
      return {
        id: fileName.replace(/\.[^.]+$/, ""),
        fileName,
        path: `/resources/${encodeURIComponent(fileName)}`,
        contentType: contentTypeForResource(fileName)
      };
    })
    .filter(Boolean);
}

function inspectWebuiEntrypoint({ webuiRoot, entrypoint }) {
  const file = path.join(webuiRoot, entrypoint);
  if (!existsSync(file)) return null;
  const html = readFileSync(file, "utf8");
  const references = extractHtmlAssetReferences(html)
    .map((reference) => {
      const normalized = normalizeWebuiReference(reference);
      if (!normalized) return null;
      const filePath = path.resolve(path.dirname(file), normalized.filePath);
      const root = path.resolve(webuiRoot);
      const insideRoot = filePath === root || filePath.startsWith(`${root}${path.sep}`);
      return {
        attribute: reference.attribute,
        value: reference.value,
        relativePath: normalized.relativePath,
        rootPath: normalized.rootPath,
        exists: insideRoot && existsSync(filePath) && statSync(filePath).isFile()
      };
    })
    .filter(Boolean);
  return {
    entrypoint,
    exists: true,
    references,
    missing: references.filter((reference) => !reference.exists)
  };
}

function extractHtmlAssetReferences(html) {
  const references = [];
  const pattern = /\b(src|href)=["']([^"']+)["']/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    references.push({ attribute: match[1].toLowerCase(), value: match[2] });
  }
  return references;
}

function normalizeWebuiReference(reference) {
  const value = reference.value.trim();
  if (!value || value.startsWith("#") || value.startsWith("data:") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const withoutQuery = value.split(/[?#]/, 1)[0];
  if (!withoutQuery || withoutQuery.startsWith("/resources/")) return null;
  const relativePath = withoutQuery.replace(/^\.\//, "").replace(/^\//, "");
  if (!relativePath || relativePath.includes("..")) return null;
  return {
    filePath: relativePath,
    relativePath,
    rootPath: `/${relativePath.split("/").map(encodeURIComponent).join("/")}`
  };
}

function resolveImportedResourceFile(pathname) {
  const normalized = normalizeResourcePath(pathname);
  if (!normalized.startsWith("/resources/")) return null;
  const relative = normalized.slice("/resources/".length);
  if (!relative || relative.includes("..")) return null;
  const file = path.resolve(resourceRoot(), relative);
  const root = path.resolve(resourceRoot());
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

function themeSortKey(fileName) {
  if (fileName === "default.json") return "00-default";
  return `10-${fileName}`;
}

function naturalResourceSort(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function resourceRoot() {
  return process.env.YUUMIRA_RESOURCE_DIR ?? path.join(process.cwd(), "resources");
}

function renderIconPlaceholder(tool) {
  const initials = tool.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
  const hue = stableHue(tool.id);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${escapeXml(tool.displayName)}">
  <rect width="64" height="64" rx="14" fill="hsl(${hue} 62% 32%)"/>
  <circle cx="48" cy="16" r="10" fill="hsl(${(hue + 35) % 360} 75% 58%)" opacity="0.85"/>
  <text x="32" y="39" text-anchor="middle" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="${initials.length > 1 ? 20 : 24}" font-weight="700" fill="#fff">${escapeXml(initials || "?")}</text>
</svg>
`;
}

function stableHue(text) {
  let hash = 0;
  for (const char of String(text)) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

function normalizeResourcePath(pathname) {
  const path = String(pathname ?? "");
  return path.startsWith("/") ? path : `/${path}`;
}

function extractCommand(commandLine) {
  const text = String(commandLine ?? "").trim();
  if (!text) return "";
  const [first] = text.split(/\s+/);
  return first.split("/").pop();
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
