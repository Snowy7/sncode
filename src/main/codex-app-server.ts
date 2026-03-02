import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { AgentSettings, ImageAttachment, ProviderConfig } from "../shared/types";
import { extractAccountId, parseOAuthCredential, refreshCodexToken } from "./oauth";

type JsonRpcId = number;

type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingResponse = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

export type CodexApprovalMode = "full" | "approve";

export interface CodexApprovalPrompts {
  command: (params: {
    command?: string | null;
    cwd?: string | null;
    reason?: string | null;
  }) => Promise<"accept" | "decline" | "cancel">;
  fileChange: (params: {
    reason?: string | null;
    grantRoot?: string | null;
  }) => Promise<"accept" | "decline" | "cancel">;
}

export interface CodexRunCallbacks {
  onChunk: (chunk: string) => void;
  onText: (text: string, metadata?: Record<string, unknown>) => void;
  onToolStart: (name: string, detail: string, args?: Record<string, unknown>) => string;
  onToolEnd: (pendingId: string, name: string, detail: string, result: string, durationMs?: number) => void;
  onStatus: (detail: string) => void;
}

export interface CodexRunInput {
  provider: ProviderConfig;
  credential: string;
  projectRoot: string;
  localThreadId: string;
  localCodexThreadId?: string;
  /** Optional seed context when a local thread is first switched to Codex. */
  seedHistoryText?: string;
  content: string;
  images?: ImageAttachment[];
  permissionMode: CodexApprovalMode;
  settings: AgentSettings;
  abortSignal?: AbortSignal;
  callbacks: CodexRunCallbacks;
  approvalPrompts: CodexApprovalPrompts;
  enabledSkills?: Array<{ name: string; filePath: string }>;
}

export interface CodexRunResult {
  status: "completed" | "interrupted";
  codexThreadId: string;
  turnId: string;
}

class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams;
  private rl: readline.Interface;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingResponse>();
  private closed = false;
  private notifications = new Set<(method: string, params: any) => void>();
  private closedListeners = new Set<(reason: string) => void>();
  private serverRequestHandler?: (msg: Required<Pick<JsonRpcMessage, "id" | "method">> & { params: any }) => Promise<void>;
  private stderrTail: string[] = [];

  private constructor(proc: ChildProcessWithoutNullStreams) {
    this.proc = proc;
    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    this.proc.stderr.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 50) this.stderrTail.shift();
      }
    });
    const onClose = (why: string) => {
      if (this.closed) return;
      this.closed = true;
      this.rl.close();
      for (const fn of this.closedListeners) fn(why);
      const notFoundHint = why.includes("ENOENT") && why.toLowerCase().includes("codex")
        ? "\nCodex CLI was not found. Install it and ensure `codex --version` works in your terminal, then restart SnCode."
        : "";
      const err = new Error(`codex app-server closed (${why})${notFoundHint}${this.stderrTail.length ? `\n${this.stderrTail.slice(-8).join("\n")}` : ""}`);
      for (const [, pending] of this.pending) pending.reject(err);
      this.pending.clear();
    };
    this.proc.on("error", (err) => onClose(err instanceof Error ? err.message : String(err)));
    this.proc.on("exit", (code, signal) => onClose(`exit=${code ?? "null"} signal=${signal ?? "null"}`));
  }

  static async start(): Promise<CodexAppServerClient> {
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawnCodexAppServer();
    } catch (err) {
      throw new Error(`Failed to start codex app-server: ${err instanceof Error ? err.message : String(err)}`);
    }
    const client = new CodexAppServerClient(proc);
    await client.request("initialize", {
      clientInfo: {
        name: "sncode_desktop",
        title: "SnCode Desktop",
        version: "0.2.2",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    client.notify("initialized", {});
    return client;
  }

  onNotification(fn: (method: string, params: any) => void): () => void {
    this.notifications.add(fn);
    return () => this.notifications.delete(fn);
  }

  onClosed(fn: (reason: string) => void): () => void {
    this.closedListeners.add(fn);
    return () => this.closedListeners.delete(fn);
  }

  setServerRequestHandler(fn: (msg: Required<Pick<JsonRpcMessage, "id" | "method">> & { params: any }) => Promise<void>) {
    this.serverRequestHandler = fn;
  }

  async request(method: string, params?: any): Promise<any> {
    if (this.closed) throw new Error("codex app-server is closed");
    const id = this.nextId++;
    const payload: JsonRpcMessage = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(payload);
    });
  }

  notify(method: string, params?: any) {
    if (this.closed) return;
    this.write({ method, params });
  }

  respond(id: number, result?: any, error?: { code: number; message: string }) {
    if (this.closed) return;
    if (error) {
      this.write({ id, error });
      return;
    }
    this.write({ id, result });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.closedListeners) fn("manual close");
    try { this.rl.close(); } catch { /* noop */ }
    try { this.proc.kill(); } catch { /* noop */ }
    for (const [, pending] of this.pending) pending.reject(new Error("codex app-server closed"));
    this.pending.clear();
  }

  get isClosed() {
    return this.closed;
  }

  private write(msg: JsonRpcMessage) {
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private handleLine(line: string) {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    if (msg.id !== undefined && msg.method && this.serverRequestHandler) {
      void this.serverRequestHandler({ id: msg.id, method: msg.method, params: msg.params });
      return;
    }

    if (msg.id !== undefined && !msg.method) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || `JSON-RPC error ${msg.error.code ?? ""}`.trim()));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.method) {
      for (const fn of this.notifications) fn(msg.method, msg.params);
    }
  }
}

function spawnCodexAppServer(): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    // npm/pnpm global CLIs are usually `.cmd` wrappers; launch via cmd.exe for compatibility.
    return spawn("cmd.exe", ["/d", "/s", "/c", "codex app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  return spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

let sharedCodexClient: CodexAppServerClient | null = null;
let sharedCodexClientStart: Promise<CodexAppServerClient> | null = null;

async function getSharedCodexAppServerClient(): Promise<{ client: CodexAppServerClient; reused: boolean }> {
  if (sharedCodexClient && !sharedCodexClient.isClosed) {
    return { client: sharedCodexClient, reused: true };
  }
  if (sharedCodexClientStart) {
    const client = await sharedCodexClientStart;
    return { client, reused: true };
  }

  sharedCodexClientStart = CodexAppServerClient.start()
    .then((client) => {
      sharedCodexClient = client;
      client.onClosed(() => {
        if (sharedCodexClient === client) sharedCodexClient = null;
      });
      return client;
    })
    .finally(() => {
      sharedCodexClientStart = null;
    });

  const client = await sharedCodexClientStart;
  return { client, reused: false };
}

function mapThinkingEffort(level: AgentSettings["thinkingLevel"]): string | null {
  if (!level || level === "none") return null;
  return level;
}

function buildTurnSandboxPolicy(projectRoot: string, mode: CodexApprovalMode) {
  if (mode === "full") {
    return { type: "dangerFullAccess" };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [projectRoot],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function buildThreadSandboxMode(mode: CodexApprovalMode): "danger-full-access" | "workspace-write" {
  return mode === "full" ? "danger-full-access" : "workspace-write";
}

function buildApprovalPolicy(mode: CodexApprovalMode): "never" | "on-request" {
  return mode === "full" ? "never" : "on-request";
}

function mediaTypeToExt(mediaType: ImageAttachment["mediaType"]): string {
  switch (mediaType) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    default: return "bin";
  }
}

function writeTempImages(localThreadId: string, images?: ImageAttachment[]): string[] {
  if (!images?.length) return [];
  const baseDir = path.join(os.tmpdir(), "sncode-codex-images", localThreadId);
  fs.mkdirSync(baseDir, { recursive: true });
  return images.map((img, index) => {
    const ext = mediaTypeToExt(img.mediaType);
    const fileName = `${Date.now()}-${index}.${ext}`;
    const outPath = path.join(baseDir, fileName);
    fs.writeFileSync(outPath, Buffer.from(img.data, "base64"));
    return outPath;
  });
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatFileChanges(changes: Array<{ path: string; kind: string; diff: string }>): string {
  if (!changes.length) return "No file changes reported.";
  const MAX_DIFF_CHARS = 80_000;
  const parts: string[] = [];
  let used = 0;
  for (const c of changes) {
    const header = `# ${c.kind}: ${c.path}\n`;
    const diff = c.diff || "";
    const room = Math.max(0, MAX_DIFF_CHARS - used - header.length);
    const clipped = diff.length > room ? `${diff.slice(0, room)}\n\n[diff truncated]` : diff;
    parts.push(`${header}${clipped}`.trimEnd());
    used += header.length + clipped.length;
    if (used >= MAX_DIFF_CHARS) break;
  }
  return parts.join("\n\n");
}

function toolMetaFromItem(item: any): { name: string; detail: string; result?: string; args?: Record<string, unknown> } | null {
  if (!item || typeof item !== "object" || typeof item.type !== "string") return null;
  switch (item.type) {
    case "commandExecution": {
      const command = typeof item.command === "string" ? item.command : "";
      const result = typeof item.aggregatedOutput === "string" && item.aggregatedOutput.length > 0
        ? item.aggregatedOutput
        : `Exit code: ${item.exitCode ?? "unknown"}`;
      return { name: "run_command", detail: `Running: ${command}`, result, args: { command } };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return {
        name: "edit_file",
        detail: `Applying file changes (${changes.length} file${changes.length === 1 ? "" : "s"})`,
        result: formatFileChanges(changes),
      };
    }
    case "mcpToolCall": {
      const detail = `MCP ${item.server}/${item.tool}`;
      const result = item.error ? formatJson(item.error) : (item.result ? formatJson(item.result) : "Done");
      return { name: "mcp_tool", detail, result };
    }
    case "webSearch": {
      const q = typeof item.query === "string" ? item.query : "";
      return { name: "web_search", detail: `Web search: ${q}`, result: item.action ? formatJson(item.action) : "Search started" };
    }
    case "imageView": {
      const p = typeof item.path === "string" ? item.path : "";
      return { name: "image_view", detail: `Viewing image: ${path.basename(p)}`, result: p };
    }
    case "collabToolCall":
    case "collabAgentToolCall": {
      const prompt = typeof item.prompt === "string" ? item.prompt : "";
      return { name: "spawn_task", detail: `Sub-agent: ${String(item.tool ?? "task")}`, result: prompt || "Sub-agent task completed." };
    }
    default:
      return null;
  }
}

async function authenticateCodex(client: CodexAppServerClient, credential: string): Promise<void> {
  if (!credential) throw new Error("Codex credential is not configured.");

  if (!credential.startsWith("oauth:")) {
    await client.request("account/login/start", { type: "apiKey", apiKey: credential });
    return;
  }

  let oauth = parseOAuthCredential(credential);
  if (!oauth) throw new Error("Invalid stored Codex OAuth credential.");
  if (oauth.expires < Date.now() + 30_000) {
    oauth = await refreshCodexToken(oauth);
  }

  const accountId = oauth.accountId || extractAccountId({ access_token: oauth.access });
  if (!accountId) {
    throw new Error("Codex OAuth token is missing chatgpt account id. Re-authenticate Codex in Settings.");
  }

  await client.request("account/login/start", {
    type: "chatgptAuthTokens",
    accessToken: oauth.access,
    chatgptAccountId: accountId,
  });
}

async function refreshAuthTokensForServer(credential: string): Promise<{ accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null }> {
  const oauth = parseOAuthCredential(credential);
  if (!oauth) throw new Error("Cannot refresh non-OAuth credential");
  const refreshed = await refreshCodexToken(oauth);
  const accountId = refreshed.accountId || extractAccountId({ access_token: refreshed.access });
  if (!accountId) throw new Error("Refreshed Codex token missing account id");
  return {
    accessToken: refreshed.access,
    chatgptAccountId: accountId,
    chatgptPlanType: null,
  };
}

export async function runCodexAppServerTurn(input: CodexRunInput): Promise<CodexRunResult> {
  const { client, reused } = await getSharedCodexAppServerClient();
  const tempImagePaths = writeTempImages(input.localThreadId, input.images);
  const toolMessageMap = new Map<string, { localId: string; name: string; detail: string; startedAt: number }>();

  let codexThreadId = input.localCodexThreadId || "";
  let turnId = "";
  let terminalError: string | null = null;
  let lastTurnTokenUsage: { inputTokens: number; outputTokens: number } | null = null;
  let abortTriggered = false;

  const cleanup = () => {
    // Intentionally keep the app-server process alive across turns.
  };

  client.setServerRequestHandler(async ({ id, method, params }) => {
    try {
      if (method === "item/commandExecution/requestApproval") {
        const decision = input.permissionMode === "full"
          ? "accept"
          : await input.approvalPrompts.command({
              command: params?.command ?? null,
              cwd: params?.cwd ?? null,
              reason: params?.reason ?? null,
            });
        client.respond(id, { decision });
        return;
      }
      if (method === "item/fileChange/requestApproval") {
        const decision = input.permissionMode === "full"
          ? "accept"
          : await input.approvalPrompts.fileChange({
              reason: params?.reason ?? null,
              grantRoot: params?.grantRoot ?? null,
            });
        client.respond(id, { decision });
        return;
      }
      if (method === "account/chatgptAuthTokens/refresh") {
        const result = await refreshAuthTokensForServer(input.credential);
        client.respond(id, result);
        return;
      }
      // Unsupported server request types for now: cancel gracefully.
      const fallbackDecision = method.includes("requestApproval")
        ? { decision: "cancel" }
        : method === "item/tool/requestUserInput"
          ? { answers: [] }
          : {};
      client.respond(id, fallbackDecision);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      client.respond(id, undefined, { code: -32000, message });
    }
  });

  let resolveDone: ((v: CodexRunResult) => void) | null = null;
  let rejectDone: ((e: Error) => void) | null = null;
  const done = new Promise<CodexRunResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const offNotification = client.onNotification((method, params) => {
    try {
      if (method === "thread/tokenUsage/updated" && params?.threadId === codexThreadId) {
        const last = params?.tokenUsage?.last;
        if (last && typeof last.inputTokens === "number" && typeof last.outputTokens === "number") {
          lastTurnTokenUsage = { inputTokens: last.inputTokens, outputTokens: last.outputTokens };
        }
        return;
      }

      if (method === "turn/started" && params?.turn?.id) {
        if (!turnId) turnId = String(params.turn.id);
        return;
      }

      if (method === "item/agentMessage/delta") {
        if (params?.threadId !== codexThreadId) return;
        if (turnId && params?.turnId !== turnId) return;
        if (typeof params?.delta === "string") {
          input.callbacks.onChunk(params.delta);
        }
        return;
      }

      if (method === "item/started") {
        if (params?.threadId !== codexThreadId) return;
        if (turnId && params?.turnId !== turnId) return;
        const meta = toolMetaFromItem(params.item);
        if (!meta) return;
        const localId = input.callbacks.onToolStart(meta.name, meta.detail, meta.args);
        toolMessageMap.set(String(params.item.id), { localId, name: meta.name, detail: meta.detail, startedAt: Date.now() });
        return;
      }

      if (method === "item/completed") {
        if (params?.threadId !== codexThreadId) return;
        if (turnId && params?.turnId !== turnId) return;
        const item = params.item;
        if (!item || typeof item !== "object") return;

        if (item.type === "agentMessage" && typeof item.text === "string") {
          const meta = lastTurnTokenUsage
            ? { inputTokens: lastTurnTokenUsage.inputTokens, outputTokens: lastTurnTokenUsage.outputTokens }
            : undefined;
          input.callbacks.onText(item.text, meta);
          return;
        }

        const mapped = toolMessageMap.get(String(item.id));
        const meta = toolMetaFromItem(item);
        if (mapped && meta) {
          const durationMs = Date.now() - mapped.startedAt;
          input.callbacks.onToolEnd(mapped.localId, mapped.name, mapped.detail, meta.result || "Done", durationMs);
          toolMessageMap.delete(String(item.id));
        }
        return;
      }

      if (method === "turn/completed") {
        if (params?.threadId !== codexThreadId) return;
        const completedTurnId = String(params?.turn?.id || "");
        if (turnId && completedTurnId !== turnId) return;
        if (!turnId) turnId = completedTurnId;
        const status = String(params?.turn?.status || "");
        const errMsg = params?.turn?.error?.message ? String(params.turn.error.message) : null;
        if (status === "failed") {
          rejectDone?.(new Error(errMsg || "Codex turn failed"));
          return;
        }
        if (status === "interrupted") {
          resolveDone?.({ status: "interrupted", codexThreadId, turnId });
          return;
        }
        resolveDone?.({ status: "completed", codexThreadId, turnId });
        return;
      }

      if (method === "error") {
        const message = params?.error?.message ? String(params.error.message) : "Unknown app-server error";
        terminalError = message;
        return;
      }
    } catch (err) {
      rejectDone?.(err instanceof Error ? err : new Error(String(err)));
    }
  });
  const offClosed = client.onClosed((reason) => {
    rejectDone?.(new Error(`codex app-server closed (${reason})`));
  });

  const onAbort = () => {
    abortTriggered = true;
    if (codexThreadId && turnId) {
      void client.request("turn/interrupt", { threadId: codexThreadId, turnId }).catch(() => {
        client.close();
      });
      return;
    }
    client.close();
  };
  input.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    input.callbacks.onStatus(reused ? "Using Codex app-server" : "Starting Codex app-server");
    await authenticateCodex(client, input.credential);

    const threadArgsBase = {
      model: input.provider.model,
      cwd: input.projectRoot,
      approvalPolicy: buildApprovalPolicy(input.permissionMode),
      sandbox: buildThreadSandboxMode(input.permissionMode),
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    };

    if (input.localCodexThreadId) {
      try {
        const resumed = await client.request("thread/resume", {
          threadId: input.localCodexThreadId,
          persistExtendedHistory: true,
          cwd: input.projectRoot,
        });
        codexThreadId = String(resumed?.thread?.id || input.localCodexThreadId);
      } catch {
        const started = await client.request("thread/start", threadArgsBase);
        codexThreadId = String(started?.thread?.id || "");
      }
    } else {
      const started = await client.request("thread/start", threadArgsBase);
      codexThreadId = String(started?.thread?.id || "");
    }

    if (!codexThreadId) throw new Error("Failed to obtain Codex thread id");

    const userInput: any[] = [];
    if (!input.localCodexThreadId && input.seedHistoryText?.trim()) {
      userInput.push({ type: "text", text: input.seedHistoryText.trim(), text_elements: [] });
    }
    if (input.content.length > 0) {
      userInput.push({ type: "text", text: input.content, text_elements: [] });
    }
    userInput.push(...tempImagePaths.map((p) => ({ type: "localImage", path: p })));
    if (input.enabledSkills?.length) {
      for (const skill of input.enabledSkills) {
        userInput.push({ type: "skill", name: skill.name, path: skill.filePath });
      }
    }

    input.callbacks.onStatus("Running Codex");
    const effort = mapThinkingEffort(input.settings.thinkingLevel);
    const turnStartParams: Record<string, unknown> = {
      threadId: codexThreadId,
      input: userInput,
      cwd: input.projectRoot,
      approvalPolicy: buildApprovalPolicy(input.permissionMode),
      sandboxPolicy: buildTurnSandboxPolicy(input.projectRoot, input.permissionMode),
      model: input.provider.model,
    };
    if (effort) turnStartParams.effort = effort;
    const turnStartResp = await client.request("turn/start", turnStartParams);
    if (!turnId && turnStartResp?.turn?.id) turnId = String(turnStartResp.turn.id);

    const result = await done;
    return result;
  } catch (err) {
    if (abortTriggered || input.abortSignal?.aborted) {
      throw new Error("Run cancelled");
    }
    if (terminalError && err instanceof Error && !err.message.includes(terminalError)) {
      throw new Error(`${err.message} — ${terminalError}`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    offNotification();
    offClosed();
    input.abortSignal?.removeEventListener("abort", onAbort);
    cleanup();
  }
}
