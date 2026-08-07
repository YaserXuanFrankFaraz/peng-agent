#!/usr/bin/env node
import { createRuntime } from "../src/runtime.js";
import { createDefaultTools } from "../src/tools.js";
import { JsonStore } from "../src/store.js";
import { createProviderFromEnv, describeProvider, listProviderProfiles } from "../src/provider.js";
import { fetchProviderModels, planModelFetchRequest } from "../src/model-fetchers.js";
import { lintAutomationConfig, runAutomations, runAutomationSchedulerTick, validateAutomationConfig } from "../src/automations.js";
import { createCredentialRecord, credentialFromPromptInput, credentialPromptSpec, sourceAuthState } from "../src/credentials.js";
import { mergeConfig } from "../src/config.js";
import { addSessionLabel, createProject, createSession, updateProject, updateSessionStatus } from "../src/domain.js";
import { createLabel, deleteLabel, filterLabels, flattenLabels, updateLabel, validateLabelConfig } from "../src/labels.js";
import { evaluatePermission, validatePermissionRules, DEFAULT_PERMISSION_RULES } from "../src/permissions.js";
import { startHeadlessServer } from "../src/server-entry.js";
import { discoverSkills } from "../src/skills.js";
import { createOAuthCallbackServer, generateOAuthPkcePair, generateOAuthState, openOAuthAuthorizationUrl } from "../src/oauth.js";
import { cacheSourceIcon, callMcpSourceTool, createSourceOAuthAuthorizationRequest, discoverSources, exchangeSourceOAuthCode, exchangeSourceOAuthDeviceCode, executeApiSourceRequest, getSourceRuntimeSignature, listMcpSourceTools, pollSourceOAuthDeviceCode, refreshSourceOAuthCredential, startSourceOAuthDeviceFlow, testSource } from "../src/sources.js";
import { createStatus, deleteStatus, setDefaultStatus, updateStatus, validateStatusConfig } from "../src/statuses.js";
import { createTask, updateTask, updateTaskStatus } from "../src/tasks.js";
import { executeTerminalCommand, finishTerminalRecord, createTerminalRecord, createTerminalSession, recordTerminalChunk, replayTerminalRecord } from "../src/terminal.js";
import { createView, updateView } from "../src/views.js";
import { searchWorkspace } from "../src/search.js";
import { discoverWorkflows } from "../src/workflows.js";
import { gitLogPrettyFormat, parseGitLog, parseGitStatusPorcelain, summarizeGitStatus } from "../src/git.js";
import { createKnowledgeCollection, indexKnowledgeCollection, updateKnowledgeCollection } from "../src/knowledge.js";
import { createMemoryRecord, extractMemoryCandidates, parseMemoryCitations, renderMemoryContext } from "../src/memory.js";
import { renderProtocolEvent } from "../src/protocol.js";
import { listToolIcons, resolveToolIcon, resourceManifest } from "../src/resources.js";
import { listHelpers, listHelperBehaviorProfiles, listHelperSmokeProfiles, planHelperCommand, runHelperCommand, runHelperBehaviorProfile, smokeHelpers } from "../src/helpers.js";
import { auditPengBundle } from "../src/app-audit.js";
import { cleanFinderDuplicateVariants } from "../src/resource-import.js";
import { allowSleep, powerState, preventSleep } from "../src/power.js";

const workspace = process.cwd();
const runtime = createRuntime({
  workspace,
  store: new JsonStore({ workspace }),
  provider: createProviderFromEnv(),
  tools: createDefaultTools({ workspace })
});

const [command, ...args] = process.argv.slice(2);

try {
  if (!command || command === "help" || command === "--help") {
    printHelp();
  } else if (command === "run") {
    const prompt = args.join(" ").trim();
    if (!prompt) throw new Error("Missing prompt. Usage: peng run <prompt>");
    const result = await runtime.runTask({ prompt });
    printRunResult(result);
  } else if (command === "threads") {
    const threads = await runtime.listThreads();
    if (threads.length === 0) {
      console.log("No threads yet.");
    } else {
      for (const thread of threads) {
        console.log(`${thread.id}\t${thread.status}\t${thread.title}`);
      }
    }
  } else if (command === "show") {
    const threadId = args[0];
    if (!threadId) throw new Error("Missing thread id. Usage: peng show <thread-id>");
    const thread = await runtime.getThread(threadId);
    for (const event of thread.events) {
      console.log(`[${event.role}] ${event.content}`);
    }
  } else if (command === "config") {
    console.log(JSON.stringify(mergeConfig(), null, 2));
  } else if (command === "power") {
    await handlePower(args);
  } else if (command === "provider") {
    if (args[0] === "list") {
      for (const profile of listProviderProfiles()) {
        console.log(`${profile.id}\t${profile.type}\t${profile.model || ""}\t${profile.baseUrl || ""}`);
      }
    } else if (args[0] === "model-request") {
      console.log(JSON.stringify(planModelFetchRequest({
        provider: providerProfileFromArgs(args.slice(1)),
        apiKey: readOptionalFlag(args, "--api-key"),
        useOllamaTags: hasFlag(args, "--ollama-tags")
      }), null, 2));
    } else if (args[0] === "models") {
      console.log(JSON.stringify(await fetchProviderModels({
        provider: providerProfileFromArgs(args.slice(1)),
        apiKey: readOptionalFlag(args, "--api-key"),
        useOllamaTags: hasFlag(args, "--ollama-tags"),
        timeoutMs: Number(readFlag(args, "--timeout-ms") ?? 30000)
      }), null, 2));
    } else {
      console.log(JSON.stringify(describeProvider(runtime.provider), null, 2));
    }
  } else if (command === "protocol") {
    const events = await runtime.store.listProtocolEvents({ threadId: readFlag(args, "--thread"), type: readFlag(args, "--type") });
    if (events.length === 0) {
      console.log("No protocol events found.");
    } else {
      for (const event of events) console.log(renderProtocolEvent(event));
    }
  } else if (command === "queue") {
    await handleQueue(args);
  } else if (command === "run-control") {
    await handleRunControl(args);
  } else if (command === "permissions") {
    const subcommand = args[0] || "validate";
    if (subcommand === "validate") {
      console.log(JSON.stringify(validatePermissionRules(DEFAULT_PERMISSION_RULES), null, 2));
    } else if (subcommand === "check") {
      const value = positionalBeforeFlags(args.slice(1)).join(" ").trim() || readFlag(args, "--value") || readFlag(args, "--path");
      if (!value) throw new Error("Missing command. Usage: peng permissions check <bash-command>");
      console.log(JSON.stringify(evaluatePermission({
        mode: readFlag(args, "--mode") ?? "safe",
        kind: readFlag(args, "--kind") ?? "bash",
        value,
        method: readFlag(args, "--method"),
        path: readFlag(args, "--path")
      }), null, 2));
    } else {
      throw new Error(`Unknown permissions subcommand: ${subcommand}`);
    }
  } else if (command === "skills") {
    const skills = await discoverSkills({ workspace });
    if (skills.length === 0) {
      console.log("No skills found.");
    } else {
      for (const skill of skills) {
        console.log(`${skill.slug}\t${skill.valid ? "valid" : "invalid"}\t${skill.metadata.name || "(unnamed)"}`);
      }
    }
  } else if (command === "workflows") {
    const workflows = await discoverWorkflows({ workspace });
    if (workflows.length === 0) {
      console.log("No workflows found.");
    } else {
      for (const workflow of workflows) {
        console.log(`${workflow.id}\t${workflow.runnable ? "runnable" : "document"}\t${workflow.title}`);
      }
    }
  } else if (command === "statuses") {
    const subcommand = args[0] || "list";
    const config = await runtime.store.getStatusConfig();
    if (subcommand === "list") {
      for (const status of [...config.statuses].sort((a, b) => a.order - b.order)) {
        console.log(`${status.id}\t${status.category}\t${status.label}`);
      }
    } else if (subcommand === "validate") {
      console.log(JSON.stringify(validateStatusConfig(config), null, 2));
    } else if (subcommand === "create") {
      const id = args[1];
      const label = positionalBeforeFlags(args.slice(2)).join(" ").trim() || id;
      const next = createStatus(config, {
        id,
        label,
        category: readFlag(args, "--category") ?? "open",
        color: readFlag(args, "--color"),
        isDefault: hasFlag(args, "--default")
      });
      await runtime.store.saveStatusConfig(next);
      console.log(`${id}\tcreated`);
    } else if (subcommand === "update") {
      const id = args[1];
      if (!id) throw new Error("Usage: peng statuses update <id> [--label <label>] [--category open|closed] [--color <color>] [--default]");
      const next = updateStatus(config, id, {
        id: readFlag(args, "--id"),
        label: readFlag(args, "--label"),
        category: readFlag(args, "--category"),
        color: readFlag(args, "--color"),
        isDefault: hasFlag(args, "--default")
      });
      await runtime.store.saveStatusConfig(next);
      console.log(`${id}\tupdated`);
    } else if (subcommand === "default") {
      const id = args[1];
      if (!id) throw new Error("Usage: peng statuses default <id>");
      const next = setDefaultStatus(config, id);
      await runtime.store.saveStatusConfig(next);
      console.log(`${id}\tdefault`);
    } else if (subcommand === "delete") {
      const id = args[1];
      if (!id) throw new Error("Usage: peng statuses delete <id> [--replacement <id>]");
      const deleted = deleteStatus(config, id, { replacementStatusId: readFlag(args, "--replacement") ?? config.defaultStatusId });
      await runtime.store.saveStatusConfig(deleted.config);
      const migrated = await migrateStatusReferences(runtime.store, id, deleted.replacementStatusId);
      console.log(`${id}\tdeleted\t${deleted.replacementStatusId}\t${migrated.sessions}/${migrated.tasks}`);
    } else {
      throw new Error(`Unknown statuses subcommand: ${subcommand}`);
    }
  } else if (command === "labels") {
    const subcommand = args[0] || "list";
    const config = await runtime.store.getLabelConfig();
    if (subcommand === "list") {
      const labels = filterLabels(config, {
        query: readFlag(args, "--query"),
        valueType: readFlag(args, "--value-type"),
        parentId: readFlag(args, "--parent")
      });
      if (labels.length === 0) {
        console.log("No labels found.");
      } else {
        for (const label of labels) {
          console.log(`${"  ".repeat(label.depth - 1)}${label.id}\t${label.name}`);
        }
      }
    } else if (subcommand === "validate") {
      console.log(JSON.stringify(validateLabelConfig(config), null, 2));
    } else if (subcommand === "create") {
      const id = args[1];
      const name = positionalBeforeFlags(args.slice(2)).join(" ").trim() || id;
      const next = createLabel(config, {
        id,
        name,
        color: readFlag(args, "--color"),
        valueType: readFlag(args, "--value-type"),
        parentId: readFlag(args, "--parent")
      });
      await runtime.store.saveLabelConfig(next);
      console.log(`${id}\tcreated`);
    } else if (subcommand === "update") {
      const id = args[1];
      if (!id) throw new Error("Usage: peng labels update <id> [--id <id>] [--name <name>] [--color <color>] [--value-type <type>] [--parent <id>]");
      const nextId = readFlag(args, "--id");
      const next = updateLabel(config, id, {
        id: nextId,
        name: readFlag(args, "--name"),
        color: readFlag(args, "--color"),
        valueType: readFlag(args, "--value-type"),
        parentId: readFlag(args, "--parent")
      });
      await runtime.store.saveLabelConfig(next);
      const migrated = nextId && nextId !== id ? await renameLabelReferences(runtime.store, id, nextId) : { sessions: 0, tasks: 0 };
      console.log(`${id}\tupdated\t${migrated.sessions}/${migrated.tasks}`);
    } else if (subcommand === "delete") {
      const id = args[1];
      if (!id) throw new Error("Usage: peng labels delete <id>");
      const deleted = deleteLabel(config, id);
      await runtime.store.saveLabelConfig(deleted.config);
      const migrated = await removeLabelReferences(runtime.store, deleted.removed);
      console.log(`${id}\tdeleted\t${migrated.sessions}/${migrated.tasks}`);
    } else {
      throw new Error(`Unknown labels subcommand: ${subcommand}`);
    }
  } else if (command === "sessions") {
    await handleSessions(args);
  } else if (command === "projects") {
    await handleProjects(args);
  } else if (command === "tasks") {
    await handleTasks(args);
  } else if (command === "views") {
    await handleViews(args);
  } else if (command === "search") {
    const query = args.join(" ").trim();
    if (!query) throw new Error("Usage: peng search <query>");
    const results = await searchWorkspace({ store: runtime.store, query });
    for (const result of results) {
      console.log(`${result.type}\t${result.id}\t${result.title}`);
    }
  } else if (command === "automations") {
    await handleAutomations(args);
  } else if (command === "memory") {
    await handleMemory(args);
  } else if (command === "knowledge") {
    await handleKnowledge(args);
  } else if (command === "credentials") {
    await handleCredentials(args);
  } else if (command === "terminal") {
    await handleTerminal(args);
  } else if (command === "git") {
    await handleGit(args);
  } else if (command === "tool-icons") {
    await handleToolIcons(args);
  } else if (command === "resources") {
    await handleResources(args);
  } else if (command === "audit") {
    await cleanFinderDuplicateVariants(readFlag(args, "--resources") ?? "resources");
    const result = auditPengBundle({
      appPath: readFlag(args, "--app") ?? undefined,
      workspace,
      resourceDir: readFlag(args, "--resources") ?? undefined
    });
    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Bundle: ${result.app.bundleIdentifier ?? "unknown"} ${result.app.version ?? ""}`);
      console.log(`Workspace: ${result.workspace}`);
      for (const item of result.comparisons.checks) {
        console.log(`${item.ok ? "ok" : "gap"}\t${item.id}\t${item.description}`);
      }
      process.exitCode = result.comparisons.ok ? 0 : 1;
    }
  } else if (command === "helpers") {
    await handleHelpers(args);
  } else if (command === "sources") {
    const subcommand = args[0] || "list";
    const workspaceRecord = await runtime.store.getWorkspace();
    const sources = await discoverSources({ workspace, workspaceId: workspaceRecord.id, store: runtime.store });
    if (subcommand === "validate") {
      const issues = sources.flatMap((source) =>
        source.validation.issues.map((issue) => `${source.slug}: ${issue}`)
      );
      console.log(JSON.stringify({ ok: issues.length === 0, issues }, null, 2));
    } else if (subcommand === "list" && sources.length === 0) {
      console.log("No sources found.");
    } else if (subcommand === "list") {
      for (const source of sources) {
        console.log(`${source.slug}\t${source.type}\t${source.connectionStatus ?? "untested"}\t${source.name}`);
      }
    } else if (subcommand === "auth-help") {
      const slug = args[1];
      const source = sources.find((item) => item.slug === slug);
      if (!source) throw new Error("Usage: peng sources auth-help <slug>");
      console.log(JSON.stringify(credentialPromptSpec(source), null, 2));
    } else if (subcommand === "auth-state") {
      const slug = args[1];
      const source = sources.find((item) => item.slug === slug);
      if (!source) throw new Error("Usage: peng sources auth-state <slug>");
      console.log(JSON.stringify(sourceAuthState(source, await runtime.store.getCredential(source.slug)), null, 2));
    } else if (subcommand === "auth-save") {
      const [slug, json = "{}"] = args.slice(1);
      const source = sources.find((item) => item.slug === slug);
      if (!source) throw new Error("Usage: peng sources auth-save <slug> <fields-json>");
      const record = await runtime.store.saveCredential(credentialFromPromptInput(source, {
        fields: JSON.parse(json),
        refreshToken: readFlag(args, "--refresh-token"),
        expiresAt: readFlag(args, "--expires-at")
      }));
      console.log(`${record.sourceSlug}\t${record.mode}\tsaved`);
    } else if (subcommand === "signature") {
      const slug = args[1];
      const source = sources.find((item) => item.slug === slug);
      if (!source) throw new Error("Usage: peng sources signature <slug>");
      console.log(JSON.stringify(await getSourceRuntimeSignature({ source, store: runtime.store }), null, 2));
    } else if (subcommand === "test") {
      const slug = args[1];
      const source = sources.find((item) => item.slug === slug);
      if (!source) throw new Error("Usage: peng sources test <slug>");
      console.log(JSON.stringify(await testSource({ source, store: runtime.store }), null, 2));
    } else if (subcommand === "icon") {
      const slug = args[1];
      const source = sources.find((item) => item.slug === slug);
      if (!source) throw new Error("Usage: peng sources icon <slug>");
      console.log(JSON.stringify(await cacheSourceIcon({ source }), null, 2));
    } else if (subcommand === "request") {
      const [slug, endpointPath] = args.slice(1);
      const source = sources.find((item) => item.slug === slug);
      if (!source || !endpointPath) throw new Error("Usage: peng sources request <slug> <path>");
      console.log(JSON.stringify(await executeApiSourceRequest({ source, endpointPath, store: runtime.store }), null, 2));
    } else if (subcommand === "mcp-tools") {
      const slug = args[1];
      const source = sources.find((item) => item.slug === slug);
      if (!source) throw new Error("Usage: peng sources mcp-tools <slug>");
      console.log(JSON.stringify(await listMcpSourceTools({ source, store: runtime.store }), null, 2));
    } else if (subcommand === "mcp-call") {
      const [slug, name, json = "{}"] = args.slice(1);
      const source = sources.find((item) => item.slug === slug);
      if (!source || !name) throw new Error("Usage: peng sources mcp-call <slug> <tool-name> [arguments-json]");
      console.log(JSON.stringify(await callMcpSourceTool({ source, name, arguments: JSON.parse(json), store: runtime.store }), null, 2));
    } else if (subcommand === "oauth-url") {
      const slug = args[1];
      const source = sources.find((item) => item.slug === slug);
      if (!source) throw new Error("Usage: peng sources oauth-url <slug>");
      const request = createSourceOAuthAuthorizationRequest({
        source,
        state: readFlag(args, "--state"),
        generateState: hasFlag(args, "--generate-state"),
        pkce: hasFlag(args, "--pkce"),
        codeChallenge: readFlag(args, "--challenge"),
        codeVerifier: readFlag(args, "--verifier"),
        redirectUri: readFlag(args, "--redirect-uri")
      });
      console.log(hasFlag(args, "--json") || hasFlag(args, "--pkce") ? JSON.stringify(request, null, 2) : request.url);
    } else if (subcommand === "oauth-device") {
      const slug = args[1];
      const source = sources.find((item) => item.slug === slug);
      if (!source) throw new Error("Usage: peng sources oauth-device <slug>");
      console.log(JSON.stringify(await startSourceOAuthDeviceFlow({ source }), null, 2));
    } else if (subcommand === "oauth-callback") {
      const slug = args[1];
      const source = sources.find((item) => item.slug === slug);
      if (!source) throw new Error("Usage: peng sources oauth-callback <slug> [--port <port>] [--state <state>] [--challenge <challenge>] [--verifier <verifier>] [--no-open] [--no-pkce]");
      const state = readFlag(args, "--state") ?? generateOAuthState();
      const generatedPkce = generateOAuthPkcePair();
      const pkce = hasFlag(args, "--no-pkce")
        ? { codeChallenge: readFlag(args, "--challenge"), codeVerifier: readFlag(args, "--verifier") }
        : {
            codeChallenge: readFlag(args, "--challenge") ?? generatedPkce.codeChallenge,
            codeVerifier: readFlag(args, "--verifier") ?? generatedPkce.codeVerifier
          };
      const callback = await createOAuthCallbackServer({
        port: Number(readFlag(args, "--port") ?? 0),
        expectedState: state,
        timeoutMs: Number(readFlag(args, "--timeout-ms") ?? 120000)
      });
      try {
        const authorizationUrl = getSourceOAuthAuthorizationUrl({
          source,
          state,
          codeChallenge: pkce.codeChallenge,
          redirectUri: callback.redirectUri
        });
        console.log(`Redirect URI: ${callback.redirectUri}`);
        console.log(`Open: ${authorizationUrl}`);
        if (!hasFlag(args, "--no-open")) {
          await openOAuthAuthorizationUrl(authorizationUrl);
          console.log("Browser opened.");
        }
        const result = await callback.waitForCallback;
        const credential = await exchangeSourceOAuthCode({
          source,
          code: result.code,
          codeVerifier: pkce.codeVerifier,
          redirectUri: callback.redirectUri,
          store: runtime.store
        });
        console.log(`${credential.sourceSlug}\t${credential.mode}\tsaved`);
      } finally {
        await callback.close();
      }
    } else if (subcommand === "oauth-exchange") {
      const slug = args[1];
      const source = sources.find((item) => item.slug === slug);
      if (!source) throw new Error("Usage: peng sources oauth-exchange <slug> (--code <code>|--device-code <code>)");
      const deviceCode = readFlag(args, "--device-code");
      const credential = deviceCode
        ? await exchangeSourceOAuthDeviceCode({ source, deviceCode, store: runtime.store })
        : await exchangeSourceOAuthCode({ source, code: readFlag(args, "--code"), codeVerifier: readFlag(args, "--verifier"), redirectUri: readFlag(args, "--redirect-uri"), store: runtime.store });
      console.log(`${credential.sourceSlug}\t${credential.mode}\tsaved`);
    } else if (subcommand === "oauth-poll-device") {
      const [slug, deviceCode] = args.slice(1);
      const source = sources.find((item) => item.slug === slug);
      if (!source || !deviceCode) throw new Error("Usage: peng sources oauth-poll-device <slug> <device-code>");
      const credential = await pollSourceOAuthDeviceCode({
        source,
        deviceCode,
        intervalSecs: Number(readFlag(args, "--interval-secs") ?? 5),
        expiresIn: Number(readFlag(args, "--expires-in") ?? 600),
        maxAttempts: readFlag(args, "--max-attempts") ? Number(readFlag(args, "--max-attempts")) : undefined,
        store: runtime.store
      });
      console.log(`${credential.sourceSlug}\t${credential.mode}\tsaved`);
    } else if (subcommand === "oauth-refresh") {
      const slug = args[1];
      const source = sources.find((item) => item.slug === slug);
      if (!source) throw new Error("Usage: peng sources oauth-refresh <slug>");
      const credential = await refreshSourceOAuthCredential({ source, store: runtime.store });
      console.log(`${credential.sourceSlug}\t${credential.mode}\trefreshed`);
    } else {
      throw new Error(`Unknown sources subcommand: ${subcommand}`);
    }
  } else if (command === "server") {
    await startHeadlessServer({ args });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function printHelp() {
  console.log(`peng

Usage:
  peng run <prompt>       Run a task in a new thread
  peng threads            List saved threads
  peng show <thread-id>   Show a thread transcript
  peng config             Print merged app defaults
  peng power [state|prevent-sleep|allow-sleep]
  peng provider           Print active model provider
  peng provider list      List built-in provider profiles
  peng provider model-request [profile] [--base-url <url>] [--api-key <key>] [--ollama-tags]
  peng provider models [profile] [--api-key <key>] [--ollama-tags] [--timeout-ms <ms>]
  peng protocol [--thread <id>] [--type <event-type>]
  peng queue list [--thread <id>] [--status <status>]
  peng queue add <thread-id> <message>
  peng queue replay <thread-id>
  peng run-control list [--status <status>]
  peng run-control stop <thread-id> [reason]
  peng run-control resume <thread-id> [prompt]
  peng run-control watchdog [stale-after-ms]
  peng permissions        Validate default permission rules
  peng permissions check <value> [--kind bash|api|mcp|tool|write]
  peng skills             List Craft-compatible skills
  peng workflows          List workflow markdown files
  peng statuses           List workspace statuses
  peng statuses create <id> <label>
  peng statuses update <id> [--label <label>]
  peng statuses default <id>
  peng statuses delete <id> [--replacement <id>]
  peng labels             List workspace labels
  peng labels create <id> <name>
  peng labels update <id> [--name <name>]
  peng labels delete <id>
  peng sessions           List workspace sessions
  peng sessions create <prompt>
  peng sessions status <session-id> <status-id>
  peng sessions label <session-id> <label>
  peng projects
  peng projects create <name>
  peng projects update <project-id> [--name <name>]
  peng projects delete <project-id>
  peng tasks
  peng tasks create <title>
  peng tasks update <task-id> [--title <title>]
  peng tasks status <task-id> <status-id>
  peng tasks delete <task-id>
  peng views
  peng views create <name> [sessions|tasks]
  peng views update <view-id> [--filters <json>]
  peng views delete <view-id>
  peng search <query>
  peng automations validate
  peng automations lint
  peng automations test '<event-json>'
  peng automations run '<event-json>' [--execute-webhooks]
  peng automations tick [--now <iso-date>] [--execute-webhooks]
  peng automations history
  peng memory
  peng memory remember <text>
  peng memory search <query>
  peng memory context <query>
  peng memory citations <text>
  peng memory extract <text> [--persist]
  peng memory maintain [--max <n>] [--max-removed <n>] [--max-removed-ratio <0-1>] [--scan-citations] [--user-compat] [--no-compat]
  peng knowledge
  peng knowledge create <name> <root>
  peng knowledge index <collection-id>
  peng knowledge search <query>
  peng knowledge inspect
  peng knowledge repair
  peng knowledge report
  peng knowledge semantic
  peng knowledge semantic-configure [--model <name>] [--cache-dir <path>] [--installed]
  peng knowledge semantic-job [--collection <id>] [--model <name>] [--cache-dir <path>]
  peng credentials
  peng credentials storage
  peng credentials save <source-slug> <mode> <value>
  peng terminal
  peng terminal run <command>
  peng terminal record <command> [exit-code]
  peng terminal append <record-id> <stdout|stderr> <text>
  peng terminal finish <record-id> [exit-code]
  peng terminal replay <record-id>
  peng terminal sessions
  peng terminal session-create [name]
  peng terminal session-attach <session-id> <record-id>
  peng terminal session-close <session-id>
  peng git parse-status '<status-output>'
  peng git parse-log '<pretty-log-output>'
  peng git log-format
  peng tool-icons [command]
  peng resources
  peng helpers
  peng audit [--app dist/Peng.app] [--resources resources] [--json]
  peng helpers smoke-profiles
  peng helpers behavior-profiles
  peng helpers plan <name> [args...]
  peng helpers run <name> [args...] [--json] [--timeout-ms <ms>]
  peng helpers smoke [name...] [--profile help] [--json] [--timeout-ms <ms>]
  peng helpers behavior-smoke [--profile ical-basic|xlsx-basic|docx-basic|img-basic|markitdown-basic|pdf-basic|pptx-basic|doc-diff-basic] [--json] [--timeout-ms <ms>]
  peng sources            List workspace sources
  peng sources validate
  peng sources auth-help <slug>
  peng sources auth-state <slug>
  peng sources auth-save <slug> <fields-json>
  peng sources signature <slug>
  peng sources test <slug>
  peng sources icon <slug>
  peng sources request <slug> <path>
  peng sources mcp-tools <slug>
  peng sources mcp-call <slug> <tool-name> [arguments-json]
  peng sources oauth-url <slug> [--state <state>] [--generate-state] [--challenge <challenge>] [--pkce] [--json]
  peng sources oauth-device <slug>
  peng sources oauth-callback <slug> [--port <port>] [--state <state>] [--no-open] [--no-pkce]
  peng sources oauth-exchange <slug> (--code <code>|--device-code <code>)
  peng sources oauth-poll-device <slug> <device-code>
  peng sources oauth-refresh <slug>
  peng server [--host 127.0.0.1] [--port 4721] [--workspace <path>] [--json]
`);
}

function printRunResult(result) {
  console.log(`Thread: ${result.thread.id}`);
  console.log(`Status: ${result.thread.status}`);
  console.log("");
  console.log(result.output);
}

async function handleQueue(args) {
  const subcommand = args[0] || "list";
  if (subcommand === "list") {
    const messages = await runtime.store.listQueuedMessages({
      threadId: readFlag(args, "--thread"),
      status: readFlag(args, "--status")
    });
    if (messages.length === 0) {
      console.log("No queued messages found.");
    } else {
      for (const message of messages) {
        console.log(`${message.id}\t${message.threadId}\t${message.status}\t${message.content}`);
      }
    }
    return;
  }

  if (subcommand === "add") {
    const [threadId, ...contentParts] = args.slice(1);
    const content = contentParts.join(" ").trim();
    if (!threadId || !content) throw new Error("Usage: peng queue add <thread-id> <message>");
    const message = await runtime.queueThreadMessage({ threadId, content, source: "cli" });
    console.log(`${message.id}\t${message.threadId}\t${message.status}\t${message.content}`);
    return;
  }

  if (subcommand === "replay") {
    const threadId = args[1];
    if (!threadId) throw new Error("Usage: peng queue replay <thread-id>");
    const replayed = await runtime.replayQueuedMessages({ threadId });
    if (replayed.length === 0) {
      console.log("No queued messages replayed.");
    } else {
      for (const message of replayed) console.log(`${message.id}\t${message.status}\t${message.content}`);
    }
    return;
  }

  throw new Error(`Unknown queue subcommand: ${subcommand}`);
}

async function handleRunControl(args) {
  const subcommand = args[0] || "list";
  if (subcommand === "list") {
    const controls = await runtime.listRunControls({ status: readFlag(args, "--status") });
    if (controls.length === 0) {
      console.log("No run-control records found.");
    } else {
      for (const control of controls) {
        console.log(`${control.threadId}\t${control.status}\t${control.heartbeatAt}\t${control.reason ?? ""}`);
      }
    }
    return;
  }

  if (subcommand === "stop") {
    const [threadId, ...reasonParts] = args.slice(1);
    if (!threadId) throw new Error("Usage: peng run-control stop <thread-id> [reason]");
    const control = await runtime.requestStop({ threadId, reason: reasonParts.join(" ").trim() || "cli_requested" });
    console.log(`${control.threadId}\t${control.status}\t${control.reason}`);
    return;
  }

  if (subcommand === "resume") {
    const [threadId, ...promptParts] = args.slice(1);
    if (!threadId) throw new Error("Usage: peng run-control resume <thread-id> [prompt]");
    const result = await runtime.resumeThread({ threadId, prompt: promptParts.join(" ").trim() || "Resume the stopped thread." });
    printRunResult(result);
    return;
  }

  if (subcommand === "watchdog") {
    const staleAfterMs = Number(args[1] ?? 30000);
    const result = await runtime.inspectWatchdog({ staleAfterMs });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown run-control subcommand: ${subcommand}`);
}

async function handlePower(args) {
  const subcommand = args[0] || "state";
  if (subcommand === "state") {
    console.log(JSON.stringify(powerState(), null, 2));
    return;
  }

  if (subcommand === "prevent-sleep") {
    const reason = positionalBeforeFlags(args.slice(1)).join(" ").trim() || readFlag(args, "--reason") || "manual";
    console.log(JSON.stringify({ token: preventSleep(reason), state: powerState() }, null, 2));
    return;
  }

  if (subcommand === "allow-sleep") {
    const id = args[1] || readFlag(args, "--id");
    console.log(JSON.stringify({ released: allowSleep(id), state: powerState() }, null, 2));
    return;
  }

  throw new Error(`Unknown power subcommand: ${subcommand}`);
}

async function handleSessions(args) {
  const subcommand = args[0] || "list";
  if (subcommand === "list") {
    const sessions = await runtime.store.listSessions();
    if (sessions.length === 0) {
      console.log("No sessions found.");
    } else {
      for (const session of sessions) {
        console.log(`${session.id}\t${session.statusId}\t${session.permissionMode}\t${session.name}`);
      }
    }
    return;
  }

  if (subcommand === "create") {
    const prompt = args.slice(1).join(" ").trim();
    if (!prompt) throw new Error("Missing prompt. Usage: peng sessions create <prompt>");
    const workspaceRecord = await runtime.store.getWorkspace();
    const session = createSession({
      workspaceId: workspaceRecord.id,
      prompt,
      labelConfig: await runtime.store.getLabelConfig(),
      statusConfig: await runtime.store.getStatusConfig()
    });
    await runtime.store.saveSession(session);
    console.log(`${session.id}\t${session.statusId}\t${session.name}`);
    return;
  }

  if (subcommand === "status") {
    const [sessionId, statusId] = args.slice(1);
    if (!sessionId || !statusId) {
      throw new Error("Usage: peng sessions status <session-id> <status-id>");
    }
    const current = await runtime.store.getSession(sessionId);
    const { session, event } = updateSessionStatus(current, statusId, await runtime.store.getStatusConfig());
    await runtime.store.saveSession(session);
    await runtime.store.appendDomainEvent(event);
    console.log(`${session.id}\t${event.oldState}->${event.newState}`);
    return;
  }

  if (subcommand === "label") {
    const [sessionId, label] = args.slice(1);
    if (!sessionId || !label) throw new Error("Usage: peng sessions label <session-id> <label>");
    const current = await runtime.store.getSession(sessionId);
    const { session, event } = addSessionLabel(current, label);
    await runtime.store.saveSession(session);
    if (event) await runtime.store.appendDomainEvent(event);
    console.log(`${session.id}\t${session.labels.join(",")}`);
    return;
  }

  throw new Error(`Unknown sessions subcommand: ${subcommand}`);
}

async function handleProjects(args) {
  const subcommand = args[0] || "list";
  if (subcommand === "list") {
    const projects = await runtime.store.listProjects();
    if (projects.length === 0) {
      console.log("No projects found.");
    } else {
      for (const project of projects) console.log(`${project.id}\t${project.name}\t${project.root}`);
    }
    return;
  }
  if (subcommand === "create") {
    const name = args.slice(1).join(" ").trim();
    if (!name) throw new Error("Usage: peng projects create <name>");
    const workspaceRecord = await runtime.store.getWorkspace();
    const project = createProject({ workspaceId: workspaceRecord.id, name, root: workspace });
    await runtime.store.saveProject(project);
    console.log(`${project.id}\t${project.name}`);
    return;
  }
  if (subcommand === "update") {
    const projectId = args[1];
    if (!projectId) throw new Error("Usage: peng projects update <project-id> [--name <name>] [--root <path>]");
    const project = updateProject(await runtime.store.getProject(projectId), {
      name: readOptionalFlag(args, "--name"),
      root: readOptionalFlag(args, "--root")
    });
    await runtime.store.saveProject(project);
    console.log(`${project.id}\t${project.name}\t${project.root}`);
    return;
  }
  if (subcommand === "delete") {
    const projectId = args[1];
    if (!projectId) throw new Error("Usage: peng projects delete <project-id>");
    const project = await runtime.store.getProject(projectId);
    await runtime.store.deleteProject(projectId);
    const detached = await detachProjectReferences(runtime.store, projectId);
    console.log(`${project.id}\tdeleted\t${detached.sessions}/${detached.tasks}`);
    return;
  }
  throw new Error(`Unknown projects subcommand: ${subcommand}`);
}

async function handleTasks(args) {
  const subcommand = args[0] || "list";
  if (subcommand === "list") {
    const tasks = await runtime.store.listTasks({
      projectId: readFlag(args, "--project"),
      sessionId: readFlag(args, "--session"),
      statusId: readFlag(args, "--status"),
      label: readFlag(args, "--label"),
      query: readFlag(args, "--query"),
      sort: readFlag(args, "--sort")
    });
    if (tasks.length === 0) {
      console.log("No tasks found.");
    } else {
      for (const task of tasks) console.log(`${task.id}\t${task.statusId}\t${task.title}`);
    }
    return;
  }
  if (subcommand === "create") {
    const title = positionalBeforeFlags(args.slice(1)).join(" ").trim();
    if (!title) throw new Error("Usage: peng tasks create <title>");
    const workspaceRecord = await runtime.store.getWorkspace();
    const task = createTask({
      workspaceId: workspaceRecord.id,
      title,
      description: readFlag(args, "--description"),
      projectId: readFlag(args, "--project"),
      sessionId: readFlag(args, "--session"),
      labels: readCsvFlag(args, "--labels"),
      dueDate: readFlag(args, "--due"),
      statusId: readFlag(args, "--status"),
      statusConfig: await runtime.store.getStatusConfig()
    });
    await runtime.store.saveTask(task);
    console.log(`${task.id}\t${task.statusId}\t${task.title}`);
    return;
  }
  if (subcommand === "status") {
    const [taskId, statusId] = args.slice(1);
    if (!taskId || !statusId) throw new Error("Usage: peng tasks status <task-id> <status-id>");
    const task = updateTaskStatus(await runtime.store.getTask(taskId), statusId, await runtime.store.getStatusConfig());
    await runtime.store.saveTask(task);
    console.log(`${task.id}\t${task.statusId}\t${task.title}`);
    return;
  }
  if (subcommand === "update") {
    const taskId = args[1];
    if (!taskId) throw new Error("Usage: peng tasks update <task-id> [--title <title>] [--status <id>] [--project <id>] [--labels <a,b>]");
    const task = updateTask(await runtime.store.getTask(taskId), {
      title: readOptionalFlag(args, "--title"),
      description: readOptionalFlag(args, "--description"),
      projectId: readOptionalFlag(args, "--project"),
      sessionId: readOptionalFlag(args, "--session"),
      labels: hasFlag(args, "--labels") ? readCsvFlag(args, "--labels") : undefined,
      assignee: readOptionalFlag(args, "--assignee"),
      dueDate: readOptionalFlag(args, "--due"),
      statusId: readOptionalFlag(args, "--status")
    }, await runtime.store.getStatusConfig());
    await runtime.store.saveTask(task);
    console.log(`${task.id}\t${task.statusId}\t${task.title}`);
    return;
  }
  if (subcommand === "delete") {
    const taskId = args[1];
    if (!taskId) throw new Error("Usage: peng tasks delete <task-id>");
    const task = await runtime.store.getTask(taskId);
    await runtime.store.deleteTask(taskId);
    console.log(`${task.id}\tdeleted`);
    return;
  }
  throw new Error(`Unknown tasks subcommand: ${subcommand}`);
}

async function handleViews(args) {
  const subcommand = args[0] || "list";
  if (subcommand === "list") {
    const views = await runtime.store.listViews({ entity: readFlag(args, "--entity") });
    if (views.length === 0) {
      console.log("No views found.");
    } else {
      for (const view of views) console.log(`${view.id}\t${view.entity}\t${view.name}`);
    }
    return;
  }
  if (subcommand === "create") {
    const name = args[1];
    const entity = args[2] || "sessions";
    if (!name) throw new Error("Usage: peng views create <name> [sessions|tasks]");
    const workspaceRecord = await runtime.store.getWorkspace();
    const view = createView({
      workspaceId: workspaceRecord.id,
      name,
      entity,
      filters: parseJsonFlag(args, "--filters") ?? {},
      sort: readFlag(args, "--sort") ?? "updatedAt:desc"
    });
    await runtime.store.saveView(view);
    console.log(`${view.id}\t${view.entity}\t${view.name}`);
    return;
  }
  if (subcommand === "update") {
    const viewId = args[1];
    if (!viewId) throw new Error("Usage: peng views update <view-id> [--name <name>] [--entity <entity>] [--filters <json>] [--sort <field:dir>]");
    const view = updateView(await runtime.store.getView(viewId), {
      name: readOptionalFlag(args, "--name"),
      entity: readOptionalFlag(args, "--entity"),
      filters: hasFlag(args, "--filters") ? parseJsonFlag(args, "--filters") : undefined,
      sort: readOptionalFlag(args, "--sort")
    });
    await runtime.store.saveView(view);
    console.log(`${view.id}\t${view.entity}\t${view.name}`);
    return;
  }
  if (subcommand === "delete") {
    const viewId = args[1];
    if (!viewId) throw new Error("Usage: peng views delete <view-id>");
    const view = await runtime.store.getView(viewId);
    await runtime.store.deleteView(viewId);
    console.log(`${view.id}\tdeleted`);
    return;
  }
  throw new Error(`Unknown views subcommand: ${subcommand}`);
}

async function handleAutomations(args) {
  const subcommand = args[0] || "validate";
  if (subcommand === "validate") {
    console.log(JSON.stringify(validateAutomationConfig(await runtime.store.getAutomationConfig()), null, 2));
    return;
  }

  if (subcommand === "lint") {
    console.log(JSON.stringify(lintAutomationConfig(await runtime.store.getAutomationConfig()), null, 2));
    return;
  }

  if (subcommand === "test" || subcommand === "run") {
    const json = positionalBeforeFlags(args.slice(1)).join(" ").trim();
    if (!json) throw new Error(`Usage: peng automations ${subcommand} '<event-json>'`);
    const event = JSON.parse(json);
    const result = await runAutomations({
      config: await runtime.store.getAutomationConfig(),
      event,
      store: runtime.store,
      executeWebhooks: subcommand === "run" && hasFlag(args, "--execute-webhooks")
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "tick") {
    const now = readFlag(args, "--now");
    const result = await runAutomationSchedulerTick({
      store: runtime.store,
      now: now ? new Date(now) : new Date(),
      executeWebhooks: hasFlag(args, "--execute-webhooks")
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "history") {
    const history = await runtime.store.listAutomationHistory();
    if (history.length === 0) {
      console.log("No automation history found.");
    } else {
      for (const item of history) {
        console.log(`${item.id}\t${item.eventType}\t${item.resultCount}\t${item.createdAt}`);
      }
    }
    return;
  }

  throw new Error(`Unknown automations subcommand: ${subcommand}`);
}

async function handleMemory(args) {
  const subcommand = args[0] || "list";
  if (subcommand === "list") {
    const records = await runtime.store.listMemoryRecords();
    if (records.length === 0) {
      console.log("No memories found.");
    } else {
      for (const record of records) console.log(`${record.id}\t${record.source}\t${record.text}`);
    }
    return;
  }
  if (subcommand === "remember") {
    const text = args.slice(1).join(" ").trim();
    if (!text) throw new Error("Usage: peng memory remember <text>");
    const workspaceRecord = await runtime.store.getWorkspace();
    const record = createMemoryRecord({ text, workspaceId: workspaceRecord.id });
    await runtime.store.appendMemoryRecord(record);
    console.log(`${record.id}\t${record.text}`);
    return;
  }
  if (subcommand === "search") {
    const query = args.slice(1).join(" ").trim();
    const records = await runtime.store.searchMemoryRecords({ query });
    for (const record of records) console.log(`${record.citation}\t${record.score}\t${record.text}`);
    return;
  }
  if (subcommand === "context") {
    const query = args.slice(1).join(" ").trim();
    console.log(renderMemoryContext(await runtime.store.listMemoryRecords(), { query }));
    return;
  }
  if (subcommand === "citations") {
    const text = args.slice(1).join(" ").trim();
    if (!text) throw new Error("Usage: peng memory citations <text>");
    const ids = parseMemoryCitations(text);
    const records = await runtime.store.recordMemoryCitations(ids);
    console.log(JSON.stringify({ ids, records }, null, 2));
    return;
  }
  if (subcommand === "extract") {
    const text = positionalBeforeFlags(args.slice(1)).join(" ").trim();
    if (!text) throw new Error("Usage: peng memory extract <text> [--persist]");
    const workspaceRecord = await runtime.store.getWorkspace();
    const candidates = extractMemoryCandidates({
      text,
      source: readFlag(args, "--source") ?? "RetrospectiveExtraction",
      workspaceId: workspaceRecord.id,
      tags: readCsvFlag(args, "--tags") ?? []
    });
    if (hasFlag(args, "--persist")) {
      for (const record of candidates) await runtime.store.appendMemoryRecord(record);
    }
    console.log(JSON.stringify({ candidates, persisted: hasFlag(args, "--persist") ? candidates.length : 0 }, null, 2));
    return;
  }
  if (subcommand === "maintain") {
    const result = await runtime.store.maintainMemory({
      maxRecords: Number(readFlag(args, "--max") ?? 500),
      maxAgeDays: readFlag(args, "--max-age-days") ? Number(readFlag(args, "--max-age-days")) : null,
      minUsageCount: readFlag(args, "--min-usage") ? Number(readFlag(args, "--min-usage")) : null,
      maxRemovedPerRun: readFlag(args, "--max-removed") ? Number(readFlag(args, "--max-removed")) : null,
      maxRemovedRatio: readFlag(args, "--max-removed-ratio") ? Number(readFlag(args, "--max-removed-ratio")) : null,
      scanCitations: hasFlag(args, "--scan-citations"),
      compatibility: !hasFlag(args, "--no-compat"),
      userCompatibility: hasFlag(args, "--user-compat")
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(`Unknown memory subcommand: ${subcommand}`);
}

async function handleKnowledge(args) {
  const subcommand = args[0] || "collections";
  if (subcommand === "collections" || subcommand === "list") {
    const collections = await runtime.store.listKnowledgeCollections();
    if (collections.length === 0) {
      console.log("No knowledge collections found.");
    } else {
      for (const collection of collections) {
        console.log(`${collection.id}\t${collection.enabled ? "enabled" : "disabled"}\t${collection.name}\t${collection.root}`);
      }
    }
    return;
  }
  if (subcommand === "create") {
    const [name, root] = args.slice(1);
    if (!name || !root) throw new Error("Usage: peng knowledge create <name> <root>");
    const workspaceRecord = await runtime.store.getWorkspace();
    const collection = createKnowledgeCollection({ workspaceId: workspaceRecord.id, name, root });
    await runtime.store.saveKnowledgeCollection(collection);
    console.log(`${collection.id}\t${collection.name}\t${collection.root}`);
    return;
  }
  if (subcommand === "update") {
    const collectionId = args[1];
    if (!collectionId) throw new Error("Usage: peng knowledge update <collection-id> [--name <name>] [--root <path>] [--disabled]");
    const collection = updateKnowledgeCollection(await runtime.store.getKnowledgeCollection(collectionId), {
      name: readOptionalFlag(args, "--name"),
      root: readOptionalFlag(args, "--root"),
      type: readOptionalFlag(args, "--type"),
      enabled: hasFlag(args, "--disabled") ? false : hasFlag(args, "--enabled") ? true : undefined,
      semanticEnabled: hasFlag(args, "--semantic") ? true : hasFlag(args, "--no-semantic") ? false : undefined
    });
    await runtime.store.saveKnowledgeCollection(collection);
    console.log(`${collection.id}\t${collection.enabled ? "enabled" : "disabled"}\t${collection.name}\t${collection.root}`);
    return;
  }
  if (subcommand === "delete") {
    const collectionId = args[1];
    if (!collectionId) throw new Error("Usage: peng knowledge delete <collection-id>");
    const collection = await runtime.store.getKnowledgeCollection(collectionId);
    await runtime.store.deleteKnowledgeCollection(collectionId);
    console.log(`${collection.id}\tdeleted`);
    return;
  }
  if (subcommand === "index") {
    const collectionId = args[1];
    if (!collectionId) throw new Error("Usage: peng knowledge index <collection-id>");
    const collection = (await runtime.store.listKnowledgeCollections()).find((item) => item.id === collectionId);
    if (!collection) throw new Error(`Unknown knowledge collection: ${collectionId}`);
    const workspaceRecord = await runtime.store.getWorkspace();
    const result = await indexKnowledgeCollection({ collection, workspaceId: workspaceRecord.id });
    await runtime.store.saveKnowledgeDocuments(collection.id, result.documents);
    console.log(JSON.stringify(result.report, null, 2));
    return;
  }
  if (subcommand === "search") {
    const query = args.slice(1).join(" ").trim();
    if (!query) throw new Error("Usage: peng knowledge search <query>");
    const results = await runtime.store.searchKnowledge({ query });
    for (const result of results) {
      console.log(`${result.rank}\t${result.score}\t${result.title}\t${result.path}`);
    }
    return;
  }
  if (subcommand === "report") {
    console.log(JSON.stringify(await runtime.store.getKnowledgeReport(), null, 2));
    return;
  }
  if (subcommand === "inspect") {
    console.log(JSON.stringify(await runtime.store.inspectKnowledge(), null, 2));
    return;
  }
  if (subcommand === "repair") {
    const workspaceRecord = await runtime.store.getWorkspace();
    console.log(JSON.stringify(await runtime.store.repairKnowledge({ workspaceId: workspaceRecord.id }), null, 2));
    return;
  }
  if (subcommand === "semantic") {
    console.log(JSON.stringify({
      state: await runtime.store.getKnowledgeSemanticState(),
      semanticEngine: (await runtime.store.getKnowledgeReport()).semanticEngine
    }, null, 2));
    return;
  }
  if (subcommand === "semantic-configure") {
    const state = await runtime.store.configureKnowledgeSemanticState({
      model: readOptionalFlag(args, "--model"),
      cacheDir: readOptionalFlag(args, "--cache-dir"),
      installed: hasFlag(args, "--installed") ? true : hasFlag(args, "--uninstalled") ? false : undefined,
      status: readOptionalFlag(args, "--status"),
      reason: readOptionalFlag(args, "--reason")
    });
    console.log(JSON.stringify({ state, semanticEngine: (await runtime.store.getKnowledgeReport()).semanticEngine }, null, 2));
    return;
  }
  if (subcommand === "semantic-job") {
    console.log(JSON.stringify(await runtime.store.createKnowledgeSemanticJob({
      collectionId: readFlag(args, "--collection"),
      model: readFlag(args, "--model"),
      cacheDir: readFlag(args, "--cache-dir")
    }), null, 2));
    return;
  }
  throw new Error(`Unknown knowledge subcommand: ${subcommand}`);
}

async function handleCredentials(args) {
  const subcommand = args[0] || "list";
  if (subcommand === "list") {
    const credentials = await runtime.store.listCredentialSummaries();
    if (credentials.length === 0) {
      console.log("No credentials found.");
    } else {
      for (const credential of credentials) {
        console.log(`${credential.sourceSlug}\t${credential.mode}\t${credential.hasSecret ? "saved" : "empty"}\t${credential.expired ? "expired" : "valid"}`);
      }
    }
    return;
  }
  if (subcommand === "storage") {
    console.log(JSON.stringify(runtime.store.credentialStorageInfo(), null, 2));
    return;
  }
  if (subcommand === "save") {
    const [sourceSlug, mode, ...valueParts] = args.slice(1);
    const value = valueParts.join(" ").trim();
    if (!sourceSlug || !mode || !value) throw new Error("Usage: peng credentials save <source-slug> <mode> <value>");
    const record = await runtime.store.saveCredential(createCredentialRecord({ sourceSlug, mode, value }));
    console.log(`${record.sourceSlug}\t${record.mode}\tsaved`);
    return;
  }
  throw new Error(`Unknown credentials subcommand: ${subcommand}`);
}

async function handleTerminal(args) {
  const subcommand = args[0] || "list";
  if (subcommand === "list") {
    const history = await runtime.store.listTerminalHistory();
    if (history.length === 0) {
      console.log("No terminal history found.");
    } else {
      for (const record of history) {
        console.log(`${record.id}\t${record.exitCode ?? ""}\t${record.command}`);
      }
    }
    return;
  }
  if (subcommand === "record") {
    const exitCodeArg = args.at(-1);
    const exitCode = /^\d+$/.test(exitCodeArg ?? "") ? Number(exitCodeArg) : null;
    const commandArgs = exitCode === null ? args.slice(1) : args.slice(1, -1);
    const commandLine = commandArgs.join(" ").trim();
    if (!commandLine) throw new Error("Usage: peng terminal record <command> [exit-code]");
    const workspaceRecord = await runtime.store.getWorkspace();
    const sessionId = readFlag(args, "--session");
    const record = createTerminalRecord({ workspaceId: workspaceRecord.id, sessionId, command: commandLine, cwd: workspace, exitCode });
    await runtime.store.saveTerminalRecord(record);
    if (sessionId) await runtime.store.attachTerminalRecordToSession(sessionId, record.id);
    console.log(`${record.id}\t${record.exitCode ?? ""}\t${record.command}`);
    return;
  }
  if (subcommand === "run") {
    const commandLine = args.slice(1).join(" ").trim();
    if (!commandLine) throw new Error("Usage: peng terminal run <command>");
    const workspaceRecord = await runtime.store.getWorkspace();
    const sessionId = readFlag(args, "--session");
    const record = await executeTerminalCommand({
      workspaceId: workspaceRecord.id,
      sessionId,
      command: commandLine,
      cwd: workspace,
      shell: process.env.SHELL || true,
      saveRecord: (recordToSave) => runtime.store.saveTerminalRecord(recordToSave)
    });
    if (sessionId) await runtime.store.attachTerminalRecordToSession(sessionId, record.id);
    console.log(`${record.id}\t${record.exitCode ?? ""}\t${record.command}`);
    return;
  }
  if (subcommand === "append") {
    const recordId = args[1];
    const stream = args[2] || "stdout";
    const data = args.slice(3).join(" ");
    if (!recordId || !data) throw new Error("Usage: peng terminal append <record-id> <stdout|stderr> <text>");
    const record = recordTerminalChunk(await runtime.store.getTerminalRecord(recordId), { stream, data });
    await runtime.store.saveTerminalRecord(record);
    console.log(`${record.id}\t${record.events.at(-1).sequence}\t${stream}`);
    return;
  }
  if (subcommand === "finish") {
    const recordId = args[1];
    if (!recordId) throw new Error("Usage: peng terminal finish <record-id> [exit-code]");
    const record = finishTerminalRecord(await runtime.store.getTerminalRecord(recordId), { exitCode: args[2] ?? 0 });
    await runtime.store.saveTerminalRecord(record);
    console.log(`${record.id}\t${record.exitCode}\t${record.status}`);
    return;
  }
  if (subcommand === "replay") {
    const recordId = args[1];
    if (!recordId) throw new Error("Usage: peng terminal replay <record-id>");
    const replay = replayTerminalRecord(await runtime.store.getTerminalRecord(recordId));
    for (const frame of replay.frames) {
      if (frame.type === "output") process.stdout.write(frame.data);
    }
    if (replay.frames.length > 0 && !replay.output.endsWith("\n")) process.stdout.write("\n");
    return;
  }
  if (subcommand === "sessions") {
    const sessions = await runtime.store.listTerminalSessions({ status: readFlag(args, "--status") });
    if (sessions.length === 0) {
      console.log("No terminal sessions found.");
    } else {
      for (const session of sessions) console.log(`${session.id}\t${session.status}\t${session.recordIds.length}\t${session.name}`);
    }
    return;
  }
  if (subcommand === "session-create") {
    const workspaceRecord = await runtime.store.getWorkspace();
    const session = createTerminalSession({
      workspaceId: workspaceRecord.id,
      name: positionalBeforeFlags(args.slice(1)).join(" ").trim() || "Terminal",
      cwd: readFlag(args, "--cwd") ?? workspace,
      shell: readFlag(args, "--shell") ?? process.env.SHELL ?? null
    });
    await runtime.store.saveTerminalSession(session);
    console.log(`${session.id}\t${session.status}\t${session.name}`);
    return;
  }
  if (subcommand === "session-attach") {
    const [sessionId, recordId] = args.slice(1);
    if (!sessionId || !recordId) throw new Error("Usage: peng terminal session-attach <session-id> <record-id>");
    const result = await runtime.store.attachTerminalRecordToSession(sessionId, recordId);
    console.log(`${result.session.id}\t${result.session.recordIds.length}\t${result.record.id}`);
    return;
  }
  if (subcommand === "session-close") {
    const sessionId = args[1];
    if (!sessionId) throw new Error("Usage: peng terminal session-close <session-id>");
    const session = await runtime.store.closeTerminalSession(sessionId);
    console.log(`${session.id}\t${session.status}`);
    return;
  }
  throw new Error(`Unknown terminal subcommand: ${subcommand}`);
}

async function handleGit(args) {
  const subcommand = args[0];
  if (subcommand === "parse-status") {
    const text = args.slice(1).join(" ");
    if (!text) throw new Error("Usage: peng git parse-status '<status-output>'");
    const entries = parseGitStatusPorcelain(text.replaceAll("\\n", "\n"));
    console.log(JSON.stringify({ entries, summary: summarizeGitStatus(entries) }, null, 2));
    return;
  }
  if (subcommand === "parse-log") {
    const text = args.slice(1).join(" ");
    if (!text) throw new Error("Usage: peng git parse-log '<pretty-log-output>'");
    console.log(JSON.stringify({ commits: parseGitLog(text), prettyFormat: gitLogPrettyFormat() }, null, 2));
    return;
  }
  if (subcommand === "log-format") {
    console.log(gitLogPrettyFormat());
    return;
  }
  throw new Error(`Unknown git subcommand: ${subcommand ?? "(missing)"}`);
}

async function handleToolIcons(args) {
  const commandLine = args.join(" ").trim();
  if (!commandLine) {
    for (const tool of listToolIcons().tools) {
      console.log(`${tool.id}\t${tool.displayName}\t${tool.commands.join(",")}`);
    }
    return;
  }
  console.log(JSON.stringify(resolveToolIcon(commandLine), null, 2));
}

async function handleResources(args) {
  if (args[0] === "tool-icons") {
    for (const tool of listToolIcons().tools) {
      console.log(`${tool.id}\t${tool.path}\t${tool.contentType}`);
    }
    return;
  }
  console.log(JSON.stringify(resourceManifest(), null, 2));
}

async function handleHelpers(args) {
  const subcommand = args[0] || "list";
  if (subcommand === "list") {
    for (const helper of listHelpers().bins) console.log(`${helper.name}\t${helper.resourcePath}`);
    return;
  }
  if (subcommand === "smoke-profiles") {
    console.log(JSON.stringify(listHelperSmokeProfiles(), null, 2));
    return;
  }
  if (subcommand === "behavior-profiles") {
    console.log(JSON.stringify(listHelperBehaviorProfiles(), null, 2));
    return;
  }
  if (subcommand === "plan") {
    const name = args[1];
    if (!name) throw new Error("Usage: peng helpers plan <name> [args...]");
    console.log(JSON.stringify(planHelperCommand({ name, args: args.slice(2), cwd: workspace }), null, 2));
    return;
  }
  if (subcommand === "behavior-smoke") {
    const result = await runHelperBehaviorProfile({
      profile: readFlag(args, "--profile") ?? "ical-basic",
      cwd: workspace,
      timeoutMs: Number(readFlag(args, "--timeout-ms") ?? 60000),
      keepTemp: hasFlag(args, "--keep-temp")
    });
    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const step of result.steps) {
        console.log(`${step.name}\t${step.ok ? "ok" : "fail"}\t${step.exitCode ?? ""}\t${step.diagnosis?.status ?? ""}`);
      }
      process.exitCode = result.ok ? 0 : 1;
    }
    return;
  }
  if (subcommand === "run") {
    const name = args[1];
    if (!name) throw new Error("Usage: peng helpers run <name> [args...]");
    const result = await runHelperCommand({
      name,
      args: helperForwardArgs(args.slice(2)),
      cwd: workspace,
      timeoutMs: Number(readFlag(args, "--timeout-ms") ?? 30000)
    });
    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (!result.stdout.endsWith("\n") && !result.stderr) process.stdout.write("\n");
      process.exitCode = result.exitCode;
    }
    return;
  }
  if (subcommand === "smoke") {
    const names = positionalBeforeFlags(args.slice(1));
    const result = await smokeHelpers({
      names,
      profile: readFlag(args, "--profile"),
      cwd: workspace,
      timeoutMs: Number(readFlag(args, "--timeout-ms") ?? 30000)
    });
    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const item of result.results) {
        console.log(`${item.name}\t${item.ok ? "ok" : "fail"}\t${item.exitCode ?? ""}\t${firstLine(item.stderr || item.stdout || item.error || "")}`);
      }
      process.exitCode = result.ok ? 0 : 1;
    }
    return;
  }
  throw new Error(`Unknown helpers subcommand: ${subcommand}`);
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/).find(Boolean) ?? "";
}

function helperForwardArgs(args) {
  const forwarded = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--json") continue;
    if (args[index] === "--profile") {
      index += 1;
      continue;
    }
    if (args[index] === "--timeout-ms") {
      index += 1;
      continue;
    }
    forwarded.push(args[index]);
  }
  return forwarded;
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function readOptionalFlag(args, name) {
  return hasFlag(args, name) ? readFlag(args, name) : undefined;
}

function readCsvFlag(args, name) {
  if (!hasFlag(args, name)) return undefined;
  return String(readFlag(args, name) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonFlag(args, name) {
  if (!hasFlag(args, name)) return undefined;
  return JSON.parse(readFlag(args, name) ?? "{}");
}

function hasFlag(args, name) {
  return args.includes(name);
}

function providerProfileFromArgs(args) {
  const id = readFlag(args, "--profile") ?? args.find((arg) => !arg.startsWith("--")) ?? "openai-compatible";
  return {
    ...(listProviderProfiles().find((profile) => profile.id === id) ?? { id, type: id }),
    ...(readOptionalFlag(args, "--base-url") ? { baseUrl: readOptionalFlag(args, "--base-url") } : {}),
    ...(readOptionalFlag(args, "--type") ? { type: readOptionalFlag(args, "--type") } : {})
  };
}

function positionalBeforeFlags(args) {
  const index = args.findIndex((arg) => arg.startsWith("--"));
  return index === -1 ? args : args.slice(0, index);
}

async function migrateStatusReferences(store, fromStatusId, toStatusId) {
  let sessions = 0;
  for (const session of await store.listSessions()) {
    if (session.statusId === fromStatusId) {
      await store.saveSession({ ...session, statusId: toStatusId, updatedAt: new Date().toISOString() });
      sessions += 1;
    }
  }
  let tasks = 0;
  for (const task of await store.listTasks()) {
    if (task.statusId === fromStatusId) {
      await store.saveTask({ ...task, statusId: toStatusId, updatedAt: new Date().toISOString() });
      tasks += 1;
    }
  }
  return { sessions, tasks };
}

async function detachProjectReferences(store, projectId) {
  let sessions = 0;
  for (const session of await store.listSessions()) {
    if (session.projectId === projectId) {
      await store.saveSession({ ...session, projectId: null, updatedAt: new Date().toISOString() });
      sessions += 1;
    }
  }
  let tasks = 0;
  for (const task of await store.listTasks()) {
    if (task.projectId === projectId) {
      await store.saveTask({ ...task, projectId: null, updatedAt: new Date().toISOString() });
      tasks += 1;
    }
  }
  return { sessions, tasks };
}

async function renameLabelReferences(store, fromLabelId, toLabelId) {
  let sessions = 0;
  for (const session of await store.listSessions()) {
    const labels = renameLabels(session.labels ?? [], fromLabelId, toLabelId);
    if (labels.changed) {
      await store.saveSession({ ...session, labels: labels.values, updatedAt: new Date().toISOString() });
      sessions += 1;
    }
  }
  let tasks = 0;
  for (const task of await store.listTasks()) {
    const labels = renameLabels(task.labels ?? [], fromLabelId, toLabelId);
    if (labels.changed) {
      await store.saveTask({ ...task, labels: labels.values, updatedAt: new Date().toISOString() });
      tasks += 1;
    }
  }
  return { sessions, tasks };
}

async function removeLabelReferences(store, removedLabelIds) {
  const removed = new Set(removedLabelIds);
  let sessions = 0;
  for (const session of await store.listSessions()) {
    const next = (session.labels ?? []).filter((label) => !removed.has(labelBaseId(label)));
    if (next.length !== (session.labels ?? []).length) {
      await store.saveSession({ ...session, labels: next, updatedAt: new Date().toISOString() });
      sessions += 1;
    }
  }
  let tasks = 0;
  for (const task of await store.listTasks()) {
    const next = (task.labels ?? []).filter((label) => !removed.has(labelBaseId(label)));
    if (next.length !== (task.labels ?? []).length) {
      await store.saveTask({ ...task, labels: next, updatedAt: new Date().toISOString() });
      tasks += 1;
    }
  }
  return { sessions, tasks };
}

function renameLabels(labels, fromLabelId, toLabelId) {
  let changed = false;
  const values = labels.map((label) => {
    const [id, value] = splitLabelValue(label);
    if (id !== fromLabelId) return label;
    changed = true;
    return value === null ? toLabelId : `${toLabelId}::${value}`;
  });
  return { values, changed };
}

function labelBaseId(label) {
  return splitLabelValue(label)[0];
}

function splitLabelValue(label) {
  const text = String(label);
  const index = text.indexOf("::");
  if (index === -1) return [text, null];
  return [text.slice(0, index), text.slice(index + 2)];
}
