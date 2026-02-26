import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { BrowserWindow, Menu, app, dialog, ipcMain, shell, type MessageBoxOptions } from "electron";

const execFileAsync = promisify(execFile);
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { runAgent } from "./agent";
import { clearAllCredentials, getProviderCredential, setProviderCredential } from "./credentials";
import { exchangeAnthropicCode, pollCodexDeviceAuth, startAnthropicOAuth, startCodexDeviceFlow, isOAuthCredential, parseOAuthCredential, refreshAnthropicToken, refreshCodexToken } from "./oauth";
import { discoverSkills, loadSkillContent, installSkill, deleteSkill } from "./skills";
import { Store } from "./store";
import { runCodexAppServerTurn } from "./codex-app-server";
import { mcpManager } from "./mcp";
import {
  agentSettingsSchema,
  newProjectInputSchema,
  newThreadInputSchema,
  providerCredentialInputSchema,
  providerUpdateBatchInputSchema,
  providerUpdateInputSchema,
  sendMessageInputSchema,
  threadUpdateInputSchema,
} from "../shared/schema";
import { AgentEventMap, AppState, InstalledEditor, ProviderConfig, SubAgentTrailEntry, ThreadMessage } from "../shared/types";
import { smallestAvailableModelId, providerForModelId } from "../shared/models";

const isDev = !app.isPackaged;
const store = new Store();
const runControllers = new Map<string, AbortController>();

let mainWindow: BrowserWindow | null = null;

function emit<T extends keyof AgentEventMap>(channel: T, payload: AgentEventMap[T]) {
  mainWindow?.webContents.send(channel, payload);
}

function toRendererState(state: AppState): AppState {
  return { ...state, messages: [] };
}

const MAX_DIFF_CONTENT_BYTES = 220_000;

function normalizeGitPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function resolveInsideProject(projectPath: string, relativePath: string): string | null {
  const root = path.resolve(projectPath);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(root)) return null;
  return target;
}

function readTextFileIfSmall(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_DIFF_CONTENT_BYTES) {
      return `[File too large to preview: ${Math.round(stat.size / 1024)}KB]`;
    }
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

async function readGitHeadFile(projectPath: string, relativePath: string): Promise<string | undefined> {
  const normalizedPath = normalizeGitPath(relativePath).trim();
  if (!normalizedPath) return undefined;
  try {
    const { stdout } = await execFileAsync("git", ["show", `HEAD:${normalizedPath}`], {
      cwd: projectPath,
      maxBuffer: 1024 * 1024 * 2,
      encoding: "utf8",
    });
    if (!stdout) return "";
    if (Buffer.byteLength(stdout, "utf8") > MAX_DIFF_CONTENT_BYTES) {
      return `[File too large to preview: ${Math.round(Buffer.byteLength(stdout, "utf8") / 1024)}KB]`;
    }
    return stdout;
  } catch {
    return undefined;
  }
}

function safePreviewString(value: unknown, maxChars = 160_000): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + "\n...[truncated]";
}

function coreToolName(name: string): string {
  const idx = name.lastIndexOf("__");
  return idx >= 0 ? name.slice(idx + 2) : name;
}

function readStringArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return undefined;
}

function listFilesRecursively(rootDir: string, maxFiles = 300): string[] {
  const output: string[] = [];
  const dirs: string[] = [rootDir];
  while (dirs.length > 0 && output.length < maxFiles) {
    const current = dirs.pop();
    if (!current) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (output.length >= maxFiles) break;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        dirs.push(abs);
      } else if (entry.isFile()) {
        output.push(abs);
      }
    }
  }
  return output;
}

const EDITOR_CANDIDATES: Array<{ id: InstalledEditor["id"]; label: string; commands: string[] }> = [
  { id: "vscode", label: "VS Code", commands: process.platform === "win32" ? ["code.cmd", "code"] : ["code"] },
  { id: "cursor", label: "Cursor", commands: process.platform === "win32" ? ["cursor.cmd", "cursor"] : ["cursor"] },
];

async function commandExists(command: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await execFileAsync("where", [command], { windowsHide: true });
    } else {
      await execFileAsync("which", [command]);
    }
    return true;
  } catch {
    return false;
  }
}

async function listInstalledEditors(): Promise<InstalledEditor[]> {
  const detected: InstalledEditor[] = [];
  for (const candidate of EDITOR_CANDIDATES) {
    let found = false;
    for (const cmd of candidate.commands) {
      if (await commandExists(cmd)) {
        found = true;
        break;
      }
    }
    if (found) detected.push({ id: candidate.id, label: candidate.label });
  }
  return detected;
}

async function resolveEditorCommand(editorId: InstalledEditor["id"]): Promise<string | null> {
  const candidate = EDITOR_CANDIDATES.find((c) => c.id === editorId);
  if (!candidate) return null;
  for (const cmd of candidate.commands) {
    if (await commandExists(cmd)) return cmd;
  }
  return null;
}

async function launchProjectInEditor(projectPath: string, editorId: InstalledEditor["id"]): Promise<{ success: boolean; message?: string }> {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return { success: false, message: "Project path does not exist" };
  }
  const command = await resolveEditorCommand(editorId);
  if (!command) {
    return { success: false, message: `${editorId === "vscode" ? "VS Code" : "Cursor"} is not installed or not on PATH` };
  }
  try {
    const child = spawn(command, [projectPath], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    child.unref();
    return { success: true };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

const CODEX_HISTORY_SEED_MAX_CHARS = 28_000;

function buildCodexHistorySeed(history: ThreadMessage[], latestUserContent: string): string | undefined {
  if (!history.length) return undefined;
  const chat = history.filter((m) => m.role === "user" || m.role === "assistant");
  if (chat.length === 0) return undefined;

  let prior = chat;
  const last = chat[chat.length - 1];
  if (last?.role === "user" && last.content.trim() === latestUserContent.trim()) {
    prior = chat.slice(0, -1);
  }
  if (prior.length === 0) return undefined;

  const parts: string[] = [];
  let used = 0;
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    const msg = prior[i];
    const content = msg.content.trim();
    if (!content) continue;
    const block = `${msg.role === "user" ? "User" : "Assistant"}:\n${content}`;
    const len = block.length + 2;
    if (used + len > CODEX_HISTORY_SEED_MAX_CHARS) break;
    parts.unshift(block);
    used += len;
  }
  if (parts.length === 0) return undefined;

  return `Previous conversation context from this thread (before switching to Codex):\n\n${parts.join("\n\n")}`;
}

function sanitizeToolArgsForUi(name: string, args?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!args) return undefined;
  const tool = coreToolName(name);
  if (tool === "write_file") {
    const pathVal = safePreviewString(readStringArg(args, ["path", "filePath", "file_path", "relative_path"]), 2_000);
    const contentVal = safePreviewString(readStringArg(args, ["content", "text", "new_content", "fileContent"]));
    if (!pathVal && !contentVal) return undefined;
    return { path: pathVal, content: contentVal };
  }
  if (tool === "edit_file") {
    const pathVal = safePreviewString(readStringArg(args, ["path", "filePath", "file_path", "relative_path"]), 2_000);
    const oldStrVal = safePreviewString(readStringArg(args, ["old_string", "oldString", "oldText", "old_content"]));
    const newStrVal = safePreviewString(readStringArg(args, ["new_string", "newString", "newText", "new_content", "replacement"]));
    const patchVal = safePreviewString(readStringArg(args, ["patch", "diff", "changes", "unified_diff"]));
    if (!pathVal && !oldStrVal && !newStrVal && !patchVal) return undefined;
    return { path: pathVal, old_string: oldStrVal, new_string: newStrVal, patch: patchVal };
  }
  if (tool === "apply_patch") {
    const patchVal = safePreviewString(readStringArg(args, ["patch", "diff", "changes", "content"]));
    if (!patchVal) return undefined;
    return { patch: patchVal };
  }
  return undefined;
}

function createWindow() {
  Menu.setApplicationMenu(null);

  const isMac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1120,
    minHeight: 720,
    title: "SnCode",
    backgroundColor: "#141414",
    ...(isMac
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 14 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.on("maximize", () => {
    mainWindow?.webContents.send("window:maximizeChanged", true);
  });
  mainWindow.on("unmaximize", () => {
    mainWindow?.webContents.send("window:maximizeChanged", false);
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


async function promptCodexCommandApproval(params: { command?: string | null; cwd?: string | null; reason?: string | null }) {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
  const detailLines = [
    params.reason ? `Reason: ${params.reason}` : null,
    params.cwd ? `CWD: ${params.cwd}` : null,
    params.command ? `Command: ${params.command}` : null,
  ].filter(Boolean) as string[];

  const opts: MessageBoxOptions = {
    type: "question",
    buttons: ["Approve", "Decline", "Cancel Run"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: "SnCode Approval",
    message: "Codex app-server is requesting permission to run a command.",
    detail: detailLines.join("\n"),
  };
  const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);

  if (res.response === 0) return "accept" as const;
  if (res.response === 1) return "decline" as const;
  return "cancel" as const;
}

async function promptCodexFileChangeApproval(params: { reason?: string | null; grantRoot?: string | null }) {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
  const detailLines = [
    params.reason ? `Reason: ${params.reason}` : null,
    params.grantRoot ? `Grant root: ${params.grantRoot}` : null,
  ].filter(Boolean) as string[];

  const opts: MessageBoxOptions = {
    type: "question",
    buttons: ["Approve", "Decline", "Cancel Run"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    title: "SnCode Approval",
    message: "Codex app-server is requesting permission to apply file changes.",
    detail: detailLines.join("\n"),
  };
  const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);

  if (res.response === 0) return "accept" as const;
  if (res.response === 1) return "decline" as const;
  return "cancel" as const;
}

interface ThreadRunUiBridge {
  onStatus: (detail: string) => void;
  onChunk: (chunk: string) => void;
  onToolStart: (name: string, detail: string, args?: Record<string, unknown>) => string;
  onToolEnd: (pendingId: string, name: string, detail: string, result: string, durationMs?: number) => void;
  onText: (text: string, metadata?: Record<string, unknown>) => void;
  onTaskProgress: (pendingId: string, trailEntry: SubAgentTrailEntry) => void;
  onDone: () => void;
  onCancelled: () => void;
}

function createThreadRunUiBridge(threadId: string): ThreadRunUiBridge {
  function storeAndEmit(role: "assistant" | "tool", content: string, metadata?: Record<string, unknown>) {
    const msg = store.appendMessage(threadId, role, content, metadata);
    emit("agent:message", { threadId, message: msg });
    return msg.id;
  }

  return {
    onStatus: (detail) => emit("agent:status", { threadId, status: "running", detail }),
    onChunk: (chunk) => emit("agent:chunk", { threadId, chunk }),
    onToolStart: (name, detail, args) => {
      const meta: Record<string, unknown> = { toolName: name, toolDetail: detail, pending: true };
      const toolArgs = sanitizeToolArgsForUi(name, args);
      if (toolArgs) meta.toolArgs = toolArgs;
      if (name === "spawn_task" && args) {
        meta.isTask = true;
        meta.taskType = String(args.type || "general");
        meta.taskDescription = String(args.description || detail);
      }
      return storeAndEmit("tool", "", meta);
    },
    onToolEnd: (pendingId, name, _detail, result, durationMs) => {
      const meta: Record<string, unknown> = { pending: false };
      if (name === "spawn_task" && durationMs !== undefined) meta.taskDurationMs = durationMs;
      const updated = store.updateMessage(pendingId, { content: result, metadata: meta });
      if (updated) emit("agent:message", { threadId, message: updated });
    },
    onText: (text, metadata) => {
      storeAndEmit("assistant", text, metadata);
    },
    onTaskProgress: (pendingId, trailEntry) => {
      const msg = store.getMessageById(pendingId);
      if (!msg) return;
      const existingTrail: SubAgentTrailEntry[] = msg.metadata?.taskTrail ?? [];
      const newTrail: SubAgentTrailEntry[] = [...existingTrail, trailEntry];
      const updated = store.updateMessage(pendingId, { metadata: { taskTrail: newTrail } });
      if (updated) emit("agent:message", { threadId, message: updated });
    },
    onDone: () => emit("agent:status", { threadId, status: "idle", detail: "Done" }),
    onCancelled: () => emit("agent:status", { threadId, status: "cancelled", detail: "Run cancelled" }),
  };
}

interface UnifiedProviderRunInput {
  threadId: string;
  projectId: string;
  projectRoot: string;
  content: string;
  history: ThreadMessage[];
  images?: z.infer<typeof sendMessageInputSchema>["images"];
  permissionMode: "full" | "approve";
  abortSignal: AbortSignal;
  ui: ThreadRunUiBridge;
}

interface UnifiedProviderRunOutcome {
  status: "completed" | "interrupted";
  codexThreadId?: string;
}

async function runUnifiedProviderTurn(input: UnifiedProviderRunInput): Promise<UnifiedProviderRunOutcome> {
  const providers = store.getState().providers;
  const activeProvider = providers.find((p) => p.enabled);
  if (!activeProvider) throw new Error("No provider enabled. Configure Anthropic or Codex in settings.");

  const projectSkillConfig = store.getProjectSkills(input.projectId);
  const availableSkills = discoverSkills(input.projectRoot);

  const enabledSkillContents: Array<{ name: string; content: string }> = [];
  for (const skillId of projectSkillConfig.enabledSkillIds) {
    const sc = loadSkillContent(skillId, input.projectRoot);
    if (sc) enabledSkillContents.push({ name: sc.skill.name, content: sc.content });
  }
  const enabledSkillRefs = availableSkills
    .filter((s) => projectSkillConfig.enabledSkillIds.includes(s.id))
    .map((s) => ({ name: s.name, filePath: s.filePath }));

  if (activeProvider.id === "codex") {
    const credential = await getProviderCredential("codex");
    if (!credential) throw new Error("codex is enabled but credential is not configured.");
    const localCodexThreadId = store.getThread(input.threadId)?.codexThreadId;
    const seedHistoryText = localCodexThreadId ? undefined : buildCodexHistorySeed(input.history, input.content.trim());

    const codexResult = await runCodexAppServerTurn({
      provider: activeProvider,
      credential,
      projectRoot: input.projectRoot,
      localThreadId: input.threadId,
      localCodexThreadId,
      seedHistoryText,
      content: input.content.trim(),
      images: input.images,
      permissionMode: input.permissionMode,
      settings: store.getSettings(),
      abortSignal: input.abortSignal,
      enabledSkills: enabledSkillRefs,
      approvalPrompts: {
        command: promptCodexCommandApproval,
        fileChange: promptCodexFileChangeApproval,
      },
      callbacks: {
        onChunk: input.ui.onChunk,
        onText: input.ui.onText,
        onToolStart: input.ui.onToolStart,
        onToolEnd: input.ui.onToolEnd,
        onStatus: input.ui.onStatus,
      },
    });

    return { status: codexResult.status, codexThreadId: codexResult.codexThreadId };
  }

  const result = await runAgent({
    providers,
    history: input.history,
    projectRoot: input.projectRoot,
    settings: store.getSettings(),
    abortSignal: input.abortSignal,
    getCredential: getProviderCredential,
    enabledSkills: enabledSkillContents,
    availableSkills: availableSkills.map((s) => ({ id: s.id, name: s.name, description: s.description })),
    mcpTools: mcpManager.getAllTools(),
    callbacks: {
      onChunk: input.ui.onChunk,
      onToolStart: input.ui.onToolStart,
      onToolEnd: input.ui.onToolEnd,
      onText: input.ui.onText,
      onTaskProgress: input.ui.onTaskProgress,
    },
  });

  input.ui.onText(result.text, { inputTokens: result.inputTokens, outputTokens: result.outputTokens });
  return { status: "completed" };
}

async function sendMessageInternal(parsed: z.infer<typeof sendMessageInputSchema>) {
  const thread = store.getThread(parsed.threadId);
  if (!thread) throw new Error("Thread not found");
  const project = store.getState().projects.find((item) => item.id === thread.projectId);
  if (!project) throw new Error("Project not found");

  const previousController = runControllers.get(parsed.threadId);
  if (previousController) throw new Error("A run is already active for this thread");

  const userMetadata = parsed.displayContent && parsed.displayContent.trim() && parsed.displayContent.trim() !== parsed.content.trim()
    ? { userDisplayContent: parsed.displayContent }
    : undefined;
  store.appendMessage(parsed.threadId, "user", parsed.content, userMetadata, parsed.images);
  const threadMsgs = store.getMessages(parsed.threadId);
  const userMsgs = threadMsgs.filter((m) => m.role === "user");
  if (userMsgs.length === 1) {
    store.updateThread(parsed.threadId, { title: truncateTitle(parsed.content) });
    void generateTitle(parsed.content, store.getState().providers).then((aiTitle) => {
      store.updateThread(parsed.threadId, { title: aiTitle });
    });
  }

  const immediateState = toRendererState(store.getState());
  const controller = new AbortController();
  runControllers.set(parsed.threadId, controller);
  const ui = createThreadRunUiBridge(parsed.threadId);
  ui.onStatus("Running agent");

  void (async () => {
    try {
      const outcome = await runUnifiedProviderTurn({
        threadId: parsed.threadId,
        projectId: project.id,
        projectRoot: project.folderPath,
        content: parsed.content,
        history: threadMsgs,
        images: parsed.images,
        permissionMode: parsed.permissionMode === "approve" ? "approve" : "full",
        abortSignal: controller.signal,
        ui,
      });

      if (outcome.codexThreadId && store.getThread(parsed.threadId)?.codexThreadId !== outcome.codexThreadId) {
        store.updateThread(parsed.threadId, { codexThreadId: outcome.codexThreadId });
      }
      if (outcome.status === "interrupted") {
        ui.onCancelled();
        return;
      }

      ui.onDone();
    } catch (error) {
      let detail = error instanceof Error ? error.message : "Unknown error";
      const anyErr = error as Record<string, unknown>;
      if (anyErr?.status) detail = `HTTP ${anyErr.status}: ${detail}`;
      if (anyErr?.error && typeof anyErr.error === "object") {
        const apiErr = anyErr.error as Record<string, unknown>;
        if (apiErr.message) detail += ` — ${apiErr.message}`;
        if (apiErr.type) detail += ` (${apiErr.type})`;
        if (apiErr.code) detail += ` [${apiErr.code}]`;
      }
      console.error("[Agent error]", error);
      const status = detail.includes("Run cancelled") ? "cancelled" : "error";
      ui.onText(`Agent failed: ${detail}`, { isError: true });
      if (status === "cancelled") ui.onCancelled();
      else emit("agent:status", { threadId: parsed.threadId, status, detail });
    } finally {
      runControllers.delete(parsed.threadId);
    }
  })();

  return immediateState;
}

function registerIpc() {
  ipcMain.handle("state:get", () => toRendererState(store.getState()));
  ipcMain.handle("thread:messages", (_event, threadId: unknown) => {
    const id = String(threadId || "");
    if (!id) return [];
    return store.getMessages(id);
  });
  ipcMain.handle("thread:meta", () => store.getThreadMessageMeta());

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

  ipcMain.handle("project:delete", (_event, projectId: unknown) => {
    const id = String(projectId || "");
    if (!id) throw new Error("Project ID is required");
    const threads = store.getState().threads.filter((thread) => thread.projectId === id);
    for (const thread of threads) {
      const controller = runControllers.get(thread.id);
      if (controller) {
        controller.abort();
        runControllers.delete(thread.id);
      }
    }
    store.deleteProject(id);
    return toRendererState(store.getState());
  });

  ipcMain.handle("project:open-in-explorer", async (_event, projectPath: unknown) => {
    const dir = String(projectPath || "");
    if (!dir || !fs.existsSync(dir)) {
      return { success: false, message: "Project path does not exist" };
    }
    const openErr = await shell.openPath(dir);
    if (openErr) {
      return { success: false, message: openErr };
    }
    return { success: true };
  });

  ipcMain.handle("editor:list", async () => {
    return listInstalledEditors();
  });

  ipcMain.handle("project:open-in-editor", async (_event, projectPath: unknown, editorId: unknown) => {
    const dir = String(projectPath || "");
    const id = String(editorId || "") as InstalledEditor["id"];
    if (id !== "vscode" && id !== "cursor") {
      return { success: false, message: "Unsupported editor" };
    }
    return launchProjectInEditor(dir, id);
  });

  ipcMain.handle("thread:create", (_event, payload: unknown) => {
    const parsed = newThreadInputSchema.parse(payload);
    if (!store.getState().projects.some((project) => project.id === parsed.projectId)) {
      throw new Error("Project not found");
    }
    return store.createThread(parsed);
  });

  ipcMain.handle("thread:update", (_event, payload: unknown) => {
    const parsed = threadUpdateInputSchema.parse(payload);
    const updated = store.updateThread(parsed.threadId, {
      title: parsed.title,
      codexThreadId: parsed.codexThreadId,
      lastModel: parsed.lastModel,
    });
    return updated ?? null;
  });

  ipcMain.handle("thread:compact", (_event, threadId: unknown) => {
    const id = String(threadId || "");
    if (!id) throw new Error("Thread ID is required");
    const result = store.compactThread(id);
    return {
      state: toRendererState(store.getState()),
      compacted: result.compacted,
      removed: result.removed,
    };
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
    return toRendererState(store.getState());
  });

  ipcMain.handle("provider:update", (_event, payload: unknown) => {
    const parsed = providerUpdateInputSchema.parse(payload);
    return store.updateProvider(parsed.id, {
      enabled: parsed.enabled,
      authMode: parsed.authMode,
      model: parsed.model
    });
  });

  ipcMain.handle("provider:update-batch", (_event, payload: unknown) => {
    const parsed = providerUpdateBatchInputSchema.parse(payload);
    return store.updateProviders(
      parsed.map((p) => ({ id: p.id, updates: { enabled: p.enabled, authMode: p.authMode, model: p.model } }))
    );
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
    return toRendererState(store.resetAll());
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
      const entries: Array<{
        file: string;
        status: "modified" | "added" | "deleted" | "renamed" | "untracked";
        diff: string;
        beforeContent?: string;
        afterContent?: string;
      }> = [];
      const seenFiles = new Set<string>();

      const addEntryForPath = async (
        rawFileName: string,
        status: "modified" | "added" | "deleted" | "renamed" | "untracked"
      ) => {
        const fileName = normalizeGitPath(rawFileName);
        if (!fileName || seenFiles.has(fileName)) return;
        seenFiles.add(fileName);

        const renameParts = status === "renamed" ? fileName.split(" -> ") : [];
        const oldPath = renameParts.length === 2 ? renameParts[0].trim() : fileName;
        const newPath = renameParts.length === 2 ? renameParts[1].trim() : fileName;
        let diff = "";
        let beforeContent: string | undefined;
        let afterContent: string | undefined;

        const resolvedNewPath = resolveInsideProject(dir, newPath);

        if (status === "modified") {
          beforeContent = await readGitHeadFile(dir, oldPath);
          if (resolvedNewPath) afterContent = readTextFileIfSmall(resolvedNewPath);
        } else if (status === "renamed") {
          beforeContent = await readGitHeadFile(dir, oldPath);
          if (resolvedNewPath) afterContent = readTextFileIfSmall(resolvedNewPath);
        } else if (status === "deleted") {
          beforeContent = await readGitHeadFile(dir, oldPath);
          afterContent = "";
        } else if (status === "added" || status === "untracked") {
          beforeContent = "";
          if (resolvedNewPath) afterContent = readTextFileIfSmall(resolvedNewPath);
        }

        try {
          if (status === "untracked") {
            diff = afterContent ?? "";
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

        entries.push({ file: fileName, status, diff, beforeContent, afterContent });
      };

      for (const line of statusLines) {
        const indexStatus = line[0];
        const workStatus = line[1];
        const rawFileName = line.slice(3).trim();
        let status: "modified" | "added" | "deleted" | "renamed" | "untracked" = "modified";
        if (indexStatus === "?" || workStatus === "?") status = "untracked";
        else if (indexStatus === "A" || workStatus === "A") status = "added";
        else if (indexStatus === "D" || workStatus === "D") status = "deleted";
        else if (indexStatus === "R") status = "renamed";

        const normalizedPath = normalizeGitPath(rawFileName);
        if (status === "untracked") {
          const dirRel = normalizedPath.replace(/\/+$/, "");
          const absDir = resolveInsideProject(dir, dirRel);
          if (absDir && fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
            const files = listFilesRecursively(absDir, 400);
            for (const absFile of files) {
              const relFile = normalizeGitPath(path.relative(dir, absFile));
              if (!relFile || relFile.startsWith("..")) continue;
              await addEntryForPath(relFile, "untracked");
            }
            continue;
          }
        }

        await addEntryForPath(normalizedPath, status);
      }
      entries.sort((a, b) => a.file.localeCompare(b.file));
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
    return sendMessageInternal(parsed);
  });

  ipcMain.handle("window:minimize", () => { mainWindow?.minimize(); });
  ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) mainWindow.restore();
    else mainWindow?.maximize();
  });
  ipcMain.handle("window:close", () => { mainWindow?.close(); });
  ipcMain.handle("window:isMaximized", () => mainWindow?.isMaximized() ?? false);
}

app.whenReady().then(() => {
  store.load();
  registerIpc();
  createWindow();
});

app.on("window-all-closed", () => {
  store.flushPersist();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  store.flushPersist();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
