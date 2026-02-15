import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from "electron";

const execFileAsync = promisify(execFile);
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { runAgent } from "./agent";
import { clearAllCredentials, getProviderCredential, setProviderCredential } from "./credentials";
import { exchangeAnthropicCode, pollCodexDeviceAuth, startAnthropicOAuth, startCodexDeviceFlow, isOAuthCredential, parseOAuthCredential, refreshAnthropicToken, refreshCodexToken } from "./oauth";
import { discoverSkills, loadSkillContent, installSkill, deleteSkill } from "./skills";
import { Store } from "./store";
import {
  agentSettingsSchema,
  newProjectInputSchema,
  newThreadInputSchema,
  providerCredentialInputSchema,
  providerUpdateInputSchema,
  sendMessageInputSchema
} from "../shared/schema";
import { AgentEventMap, ProviderConfig, SubAgentTrailEntry } from "../shared/types";
import { smallestAvailableModelId, providerForModelId } from "../shared/models";

const isDev = !app.isPackaged;
const store = new Store();
const runControllers = new Map<string, AbortController>();

let mainWindow: BrowserWindow | null = null;

function emit<T extends keyof AgentEventMap>(channel: T, payload: AgentEventMap[T]) {
  mainWindow?.webContents.send(channel, payload);
}

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1120,
    minHeight: 720,
    title: "SnCode",
    backgroundColor: "#141414",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Allow DevTools windows to open
    if (url === "about:blank" || url.startsWith("devtools://")) {
      return { action: "allow" };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  // DevTools shortcuts: F12, Ctrl+Shift+I, Cmd+Option+I
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") return;
    const wantsDevTools =
      input.key === "F12" ||
      (input.key === "I" && input.shift && (input.control || input.meta));
    if (wantsDevTools) {
      if (mainWindow?.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow?.webContents.openDevTools({ mode: "detach" });
      }
    }
  });

  if (isDev) {
    void mainWindow.loadURL("http://127.0.0.1:5188");
  } else {
    void mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }
}

/** Fallback: truncate first message to generate a title */
function truncateTitle(content: string): string {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 45) return cleaned;
  return cleaned.slice(0, 42) + "...";
}

/** Generate a thread title using the smallest available model */
async function generateTitle(content: string, providers: ProviderConfig[]): Promise<string> {
  try {
    const authedProviders = new Set(providers.filter((p) => p.credentialSet).map((p) => p.id));
    const modelId = smallestAvailableModelId(authedProviders);
    if (!modelId) return truncateTitle(content);

    const providerId = providerForModelId(modelId);
    if (!providerId) return truncateTitle(content);

    const credential = await getProviderCredential(providerId);
    if (!credential) return truncateTitle(content);

    const titlePrompt = "Generate a short, concise title (max 6 words) for a coding conversation that starts with the following message. Return ONLY the title, no quotes, no explanation.\n\nMessage: " + content.slice(0, 500);

    if (providerId === "anthropic") {
      const isOAuth = isOAuthCredential(credential);
      let client: Anthropic;
      if (isOAuth) {
        const oauth = parseOAuthCredential(credential);
        if (!oauth) return truncateTitle(content);
        let accessToken = oauth.access;
        if (oauth.expires < Date.now() + 30_000) {
          const refreshed = await refreshAnthropicToken(oauth);
          accessToken = refreshed.access;
        }
        client = new Anthropic({
          apiKey: "placeholder",
          fetch: async (reqInput: string | URL | Request, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            headers.delete("x-api-key");
            headers.set("authorization", `Bearer ${accessToken}`);
            return globalThis.fetch(reqInput, { ...init, headers });
          },
        });
      } else {
        client = new Anthropic({ apiKey: credential });
      }
      const response = await client.messages.create({
        model: modelId,
        max_tokens: 30,
        messages: [{ role: "user", content: titlePrompt }],
      });
      const text = response.content.find((b) => b.type === "text");
      if (text && text.type === "text") return text.text.trim().slice(0, 60);
    } else {
      const isOAuth = isOAuthCredential(credential);
      let client: OpenAI;
      if (isOAuth) {
        const oauth = parseOAuthCredential(credential);
        if (!oauth) return truncateTitle(content);
        let accessToken = oauth.access;
        if (oauth.expires < Date.now() + 30_000) {
          const refreshed = await refreshCodexToken(oauth);
          accessToken = refreshed.access;
        }
        client = new OpenAI({ apiKey: accessToken, baseURL: "https://api.openai.com/v1" });
      } else {
        client = new OpenAI({ apiKey: credential });
      }
      const response = await client.chat.completions.create({
        model: modelId,
        max_completion_tokens: 30,
        messages: [
          { role: "system", content: "You generate short conversation titles. Return ONLY the title, max 6 words, no quotes." },
          { role: "user", content: content.slice(0, 500) },
        ],
      });
      const text = response.choices[0]?.message?.content;
      if (text) return text.trim().slice(0, 60);
    }
  } catch {
    // Fall back to truncation on any error
  }
  return truncateTitle(content);
}

function registerIpc() {
  ipcMain.handle("state:get", () => store.getState());

  ipcMain.handle("folder:pick", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = await dialog.showOpenDialog(win!, {
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("project:create", (_event, payload: unknown) => {
    const parsed = newProjectInputSchema.parse(payload);
    const folderStat = fs.statSync(parsed.folderPath);
    if (!folderStat.isDirectory()) {
      throw new Error("Selected path is not a folder");
    }
    return store.createProject(parsed);
  });

  ipcMain.handle("thread:create", (_event, payload: unknown) => {
    const parsed = newThreadInputSchema.parse(payload);
    if (!store.getState().projects.some((project) => project.id === parsed.projectId)) {
      throw new Error("Project not found");
    }
    return store.createThread(parsed);
  });

  ipcMain.handle("thread:delete", (_event, threadId: unknown) => {
    const id = String(threadId || "");
    if (!id) throw new Error("Thread ID is required");
    // Cancel any running agent for this thread
    const controller = runControllers.get(id);
    if (controller) {
      controller.abort();
      runControllers.delete(id);
    }
    store.deleteThread(id);
    return store.getState();
  });

  ipcMain.handle("provider:update", (_event, payload: unknown) => {
    const parsed = providerUpdateInputSchema.parse(payload);
    return store.updateProvider(parsed.id, {
      enabled: parsed.enabled,
      authMode: parsed.authMode,
      model: parsed.model
    });
  });

  ipcMain.handle("provider:credential:set", async (_event, payload: unknown) => {
    const parsed = providerCredentialInputSchema.parse(payload);
    await setProviderCredential(parsed.id, parsed.credential);
    return store.updateProvider(parsed.id, { credentialSet: true });
  });

  ipcMain.handle("run:cancel", async (_event, threadId: unknown) => {
    const thread = String(threadId || "");
    const controller = runControllers.get(thread);
    controller?.abort();
    runControllers.delete(thread);
  });

  ipcMain.handle("open-external", async (_event, url: unknown) => {
    const urlStr = String(url || "");
    if (!urlStr.startsWith("https://")) {
      throw new Error("Only https URLs are allowed");
    }
    await shell.openExternal(urlStr);
  });

  ipcMain.handle("app:clear-all-data", async () => {
    // Wipe keychain credentials
    await clearAllCredentials();
    // Cancel all running agents
    for (const [id, controller] of runControllers) {
      controller.abort();
      runControllers.delete(id);
    }
    return store.resetAll();
  });

  ipcMain.handle("app:open-devtools", () => {
    mainWindow?.webContents.openDevTools({ mode: "detach" });
  });

  ipcMain.handle("git:branches", async (_event, projectPath: unknown) => {
    const dir = String(projectPath || "");
    if (!dir || !fs.existsSync(dir)) {
      return { current: "", branches: [] };
    }
    try {
      const { stdout } = await execFileAsync("git", ["branch", "--no-color"], { cwd: dir });
      const lines = stdout.split("\n").filter((l) => l.trim());
      let current = "";
      const branches: string[] = [];
      for (const line of lines) {
        const name = line.replace(/^\*?\s+/, "").trim();
        if (!name) continue;
        branches.push(name);
        if (line.startsWith("*")) current = name;
      }
      return { current, branches };
    } catch {
      return { current: "", branches: [] };
    }
  });

  ipcMain.handle("git:status", async (_event, projectPath: unknown) => {
    const dir = String(projectPath || "");
    if (!dir || !fs.existsSync(dir)) {
      return { changes: 0, staged: 0, isRepo: false };
    }
    const gitDir = path.join(dir, ".git");
    const isRepo = fs.existsSync(gitDir);
    if (!isRepo) return { changes: 0, staged: 0, isRepo: false };
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: dir });
      const lines = stdout.split("\n").filter((l) => l.trim());
      let changes = 0;
      let staged = 0;
      for (const line of lines) {
        const indexStatus = line[0];
        const workTreeStatus = line[1];
        if (indexStatus && indexStatus !== " " && indexStatus !== "?") staged++;
        if (workTreeStatus && workTreeStatus !== " ") changes++;
        if (indexStatus === "?") changes++; // untracked
      }
      return { changes, staged, isRepo: true };
    } catch {
      // .git exists but git command failed — still a repo, just can't read status
      return { changes: 0, staged: 0, isRepo: true };
    }
  });

  ipcMain.handle("filetree:get", async (_event, projectPath: unknown, depth: unknown) => {
    const dir = String(projectPath || "");
    const maxDepth = typeof depth === "number" ? depth : 3;
    if (!dir || !fs.existsSync(dir)) return [];

    const SKIP = new Set(["node_modules", ".git", ".next", ".nuxt", "dist", "build", ".output", "__pycache__", ".venv", "venv", ".tox", "vendor", ".bundle", "coverage", ".cache", ".turbo", ".parcel-cache", "dist-electron", "release"]);

    interface Entry { name: string; type: "file" | "dir"; children?: Entry[] }

    function walk(dir: string, currentDepth: number): Entry[] {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

      const result: Entry[] = [];
      // Sort: dirs first, then files, both alphabetical
      const sorted = entries
        .filter((e) => !SKIP.has(e.name) && !e.name.startsWith("."))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

      for (const entry of sorted) {
        if (entry.isDirectory()) {
          const children = currentDepth < maxDepth ? walk(path.join(dir, entry.name), currentDepth + 1) : [];
          result.push({ name: entry.name, type: "dir", children });
        } else if (entry.isFile()) {
          result.push({ name: entry.name, type: "file" });
        }
      }
      return result;
    }

    return walk(dir, 1);
  });

  ipcMain.handle("file:read", async (_event, projectPath: unknown, relativePath: unknown) => {
    const dir = String(projectPath || "");
    const rel = String(relativePath || "");
    if (!dir || !rel) return "";
    try {
      const fullPath = path.resolve(dir, rel);
      // Security: ensure it's within the project
      if (!fullPath.startsWith(path.resolve(dir))) return "Error: path escapes project root";
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) return "Error: path is a directory";
      if (stat.size > 500_000) return "Error: file too large (max 500KB)";
      return fs.readFileSync(fullPath, "utf-8");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  ipcMain.handle("git:diff", async (_event, projectPath: unknown) => {
    const dir = String(projectPath || "");
    if (!dir || !fs.existsSync(dir)) return [];
    try {
      // Check if it's a git repo
      const gitDir = path.join(dir, ".git");
      if (!fs.existsSync(gitDir)) return [];

      // Get status to know which files changed
      const { stdout: statusOut } = await execFileAsync("git", ["status", "--porcelain"], { cwd: dir });
      const statusLines = statusOut.split("\n").filter((l) => l.trim());
      const entries: Array<{ file: string; status: string; diff: string }> = [];

      for (const line of statusLines) {
        const indexStatus = line[0];
        const workStatus = line[1];
        const fileName = line.slice(3).trim();
        let status = "modified";
        if (indexStatus === "?" || workStatus === "?") status = "untracked";
        else if (indexStatus === "A" || workStatus === "A") status = "added";
        else if (indexStatus === "D" || workStatus === "D") status = "deleted";
        else if (indexStatus === "R") status = "renamed";

        let diff = "";
        try {
          if (status === "untracked") {
            // Show file content for untracked files (limited)
            const filePath = path.join(dir, fileName);
            if (fs.existsSync(filePath)) {
              const stat = fs.statSync(filePath);
              if (stat.size < 50_000) {
                diff = fs.readFileSync(filePath, "utf-8");
              } else {
                diff = `[File too large: ${Math.round(stat.size / 1024)}KB]`;
              }
            }
          } else {
            const { stdout: diffOut } = await execFileAsync("git", ["diff", "--", fileName], { cwd: dir, maxBuffer: 1024 * 1024 });
            diff = diffOut;
            if (!diff) {
              // Try staged diff
              const { stdout: stagedDiff } = await execFileAsync("git", ["diff", "--cached", "--", fileName], { cwd: dir, maxBuffer: 1024 * 1024 });
              diff = stagedDiff;
            }
          }
        } catch { /* ignore diff errors */ }

        entries.push({ file: fileName, status, diff });
      }
      return entries;
    } catch {
      return [];
    }
  });

  ipcMain.handle("git:action", async (_event, projectPath: unknown, action: unknown, args: unknown) => {
    const dir = String(projectPath || "");
    const act = String(action || "");
    const params = (args as Record<string, string>) || {};
    if (!dir || !fs.existsSync(dir)) return { success: false, message: "Invalid project path" };

    try {
      switch (act) {
        case "init": {
          await execFileAsync("git", ["init"], { cwd: dir });
          return { success: true, message: "Git repository initialized" };
        }
        case "commit": {
          const msg = params.message || "Update";
          await execFileAsync("git", ["add", "."], { cwd: dir });
          await execFileAsync("git", ["commit", "-m", msg], { cwd: dir });
          return { success: true, message: `Committed: ${msg}` };
        }
        case "pull": {
          const { stdout } = await execFileAsync("git", ["pull"], { cwd: dir });
          return { success: true, message: stdout.trim() || "Pulled successfully" };
        }
        case "push": {
          const { stdout } = await execFileAsync("git", ["push"], { cwd: dir });
          return { success: true, message: stdout.trim() || "Pushed successfully" };
        }
        case "stash": {
          await execFileAsync("git", ["stash"], { cwd: dir });
          return { success: true, message: "Changes stashed" };
        }
        case "stash-pop": {
          await execFileAsync("git", ["stash", "pop"], { cwd: dir });
          return { success: true, message: "Stash applied" };
        }
        case "checkout": {
          const branch = params.branch || "";
          if (!branch) return { success: false, message: "Branch name required" };
          await execFileAsync("git", ["checkout", branch], { cwd: dir });
          return { success: true, message: `Switched to ${branch}` };
        }
        default:
          return { success: false, message: `Unknown git action: ${act}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: msg };
    }
  });

  ipcMain.handle("settings:update", (_event, payload: unknown) => {
    const parsed = agentSettingsSchema.parse(payload);
    return store.updateSettings(parsed);
  });

  ipcMain.handle("oauth:anthropic:start", async () => {
    return startAnthropicOAuth();
  });

  ipcMain.handle("oauth:anthropic:exchange", async (_event, code: unknown) => {
    const codeStr = String(code || "");
    if (!codeStr) throw new Error("Authorization code is required");
    const data = await exchangeAnthropicCode(codeStr);
    store.updateProvider("anthropic", { credentialSet: true });
    return { success: true, expires: data.expires };
  });

  ipcMain.handle("oauth:codex:start", async () => {
    return startCodexDeviceFlow();
  });

  ipcMain.handle("oauth:codex:poll", async (_event, payload: unknown) => {
    const { deviceAuthId, userCode } = payload as { deviceAuthId: string; userCode: string };
    const data = await pollCodexDeviceAuth(deviceAuthId, userCode);
    store.updateProvider("codex", { credentialSet: true });
    return { success: true, expires: data.expires };
  });

  /* ── Skills ── */

  ipcMain.handle("skills:discover", (_event, projectPath: unknown) => {
    const dir = projectPath ? String(projectPath) : undefined;
    return discoverSkills(dir);
  });

  ipcMain.handle("skills:load-content", (_event, skillId: unknown, projectPath: unknown) => {
    const id = String(skillId || "");
    const dir = projectPath ? String(projectPath) : undefined;
    return loadSkillContent(id, dir);
  });

  ipcMain.handle("skills:enable", (_event, projectId: unknown, skillId: unknown) => {
    return store.enableSkill(String(projectId || ""), String(skillId || ""));
  });

  ipcMain.handle("skills:disable", (_event, projectId: unknown, skillId: unknown) => {
    return store.disableSkill(String(projectId || ""), String(skillId || ""));
  });

  ipcMain.handle("skills:project-config", (_event, projectId: unknown) => {
    return store.getProjectSkills(String(projectId || ""));
  });

  ipcMain.handle("skills:install", async (_event, sourcePath: unknown) => {
    const dir = String(sourcePath || "");
    if (!dir) return null;
    return installSkill(dir);
  });

  ipcMain.handle("skills:delete", (_event, skillId: unknown) => {
    return deleteSkill(String(skillId || ""));
  });

  ipcMain.handle("message:send", async (_event, payload: unknown) => {
    const parsed = sendMessageInputSchema.parse(payload);
    const thread = store.getThread(parsed.threadId);
    if (!thread) {
      throw new Error("Thread not found");
    }
    const project = store.getState().projects.find((item) => item.id === thread.projectId);
    if (!project) {
      throw new Error("Project not found");
    }

    const previousController = runControllers.get(parsed.threadId);
    if (previousController) {
      throw new Error("A run is already active for this thread");
    }

    store.appendMessage(parsed.threadId, "user", parsed.content, undefined, parsed.images);

    // Auto-generate thread title from first user message
    const threadMsgs = store.getMessages(parsed.threadId);
    const userMsgs = threadMsgs.filter((m) => m.role === "user");
    if (userMsgs.length === 1) {
      // Set a quick truncated title immediately so the UI updates fast
      store.updateThread(parsed.threadId, { title: truncateTitle(parsed.content) });
      // Fire-and-forget AI title generation — update when ready
      void generateTitle(parsed.content, store.getState().providers).then((aiTitle) => {
        store.updateThread(parsed.threadId, { title: aiTitle });
      });
    }

    // Return state immediately so the user message appears in the UI right away.
    // The agent runs in the background — the renderer listens to agent events for streaming.
    const immediateState = store.getState();

    const controller = new AbortController();
    runControllers.set(parsed.threadId, controller);
    emit("agent:status", {
      threadId: parsed.threadId,
      status: "running",
      detail: "Running agent"
    });

    /** Store a message and emit it to the renderer in real-time */
    function storeAndEmit(
      role: "assistant" | "tool",
      content: string,
      metadata?: Record<string, unknown>
    ) {
      store.appendMessage(parsed.threadId, role, content, metadata);
      const msgs = store.getMessages(parsed.threadId);
      const last = msgs[msgs.length - 1];
      emit("agent:message", { threadId: parsed.threadId, message: last });
      return last.id;
    }

    // Gather enabled skill contents for the agent
    const projectSkillConfig = store.getProjectSkills(project.id);
    const enabledSkillContents: Array<{ name: string; content: string }> = [];
    for (const skillId of projectSkillConfig.enabledSkillIds) {
      const sc = loadSkillContent(skillId, project.folderPath);
      if (sc) enabledSkillContents.push({ name: sc.skill.name, content: sc.content });
    }

    // Gather all available skills for the load_skill tool
    const availableSkills = discoverSkills(project.folderPath);

    // Fire-and-forget: run the agent in the background
    void (async () => {
      try {
        const result = await runAgent({
          providers: store.getState().providers,
          history: store.getMessages(parsed.threadId),
          projectRoot: project.folderPath,
          settings: store.getSettings(),
          abortSignal: controller.signal,
          getCredential: getProviderCredential,
          enabledSkills: enabledSkillContents,
          availableSkills: availableSkills.map((s) => ({ id: s.id, name: s.name, description: s.description })),
          callbacks: {
            onChunk: (chunk) => {
              emit("agent:chunk", { threadId: parsed.threadId, chunk });
            },
            onToolStart: (name, detail, args) => {
              // Store a pending tool message so the card appears in the UI immediately
              const meta: Record<string, unknown> = { toolName: name, toolDetail: detail, pending: true };
              // Attach task-specific metadata for spawn_task
              if (name === "spawn_task" && args) {
                meta.isTask = true;
                meta.taskType = String(args.type || "general");
                meta.taskDescription = String(args.description || detail);
              }
              return storeAndEmit("tool", "", meta);
            },
            onToolEnd: (pendingId, name, _detail, result, durationMs) => {
              // Update the pending message with the actual result
              const meta: Record<string, unknown> = { pending: false };
              if (name === "spawn_task" && durationMs !== undefined) {
                meta.taskDurationMs = durationMs;
              }
              const updated = store.updateMessage(pendingId, { content: result, metadata: meta });
              if (updated) {
                emit("agent:message", { threadId: parsed.threadId, message: updated });
              }
            },
            onText: (text, metadata) => {
              storeAndEmit("assistant", text, metadata);
            },
            onTaskProgress: (pendingId, trailEntry) => {
              // Update the pending task message with trail entry
              const msgs = store.getMessages(parsed.threadId);
              const msg = msgs.find((m) => m.id === pendingId);
              if (msg) {
                const existingTrail: SubAgentTrailEntry[] = msg.metadata?.taskTrail ?? [];
                const newTrail: SubAgentTrailEntry[] = [...existingTrail, trailEntry];
                const updated = store.updateMessage(pendingId, { metadata: { taskTrail: newTrail } });
                if (updated) {
                  emit("agent:message", { threadId: parsed.threadId, message: updated });
                }
              }
            }
          }
        });

        storeAndEmit("assistant", result.text, {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
        emit("agent:status", {
          threadId: parsed.threadId,
          status: "idle",
          detail: "Done"
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown error";
        const status = detail === "Run cancelled" ? "cancelled" : "error";
        storeAndEmit("assistant", `Agent failed: ${detail}`, { isError: true });
        emit("agent:status", {
          threadId: parsed.threadId,
          status,
          detail
        });
      } finally {
        runControllers.delete(parsed.threadId);
      }
    })();

    return immediateState;
  });
}

app.whenReady().then(() => {
  store.load();
  registerIpc();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
