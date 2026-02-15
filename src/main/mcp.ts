import { spawn, ChildProcess } from "node:child_process";
import { nanoid } from "nanoid";

/* ── MCP (Model Context Protocol) Client ── */
// Implements a JSON-RPC 2.0 client over stdio for MCP servers.
// Supports tool listing and tool execution.

export interface McpServerConfig {
  /** Unique identifier for this MCP server */
  id: string;
  /** Display name */
  name: string;
  /** Command to launch the server */
  command: string;
  /** Arguments for the command */
  args: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Whether this server is enabled */
  enabled: boolean;
}

export interface McpTool {
  /** Tool name as defined by the MCP server */
  name: string;
  /** Description for the AI */
  description: string;
  /** JSON Schema for the tool's input */
  inputSchema: Record<string, unknown>;
  /** Which MCP server this tool belongs to */
  serverId: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class McpClient {
  private process: ChildProcess | null = null;
  private config: McpServerConfig;
  private pending = new Map<string | number, PendingRequest>();
  private buffer = "";
  private tools: McpTool[] = [];
  private _connected = false;

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  get serverTools(): McpTool[] {
    return this.tools;
  }

  async connect(): Promise<void> {
    if (this._connected) return;

    const env = { ...process.env, ...(this.config.env || {}) };

    this.process = spawn(this.config.command, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString("utf8");
      this.processBuffer();
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      // Log MCP server stderr for debugging
      console.error(`[MCP:${this.config.name}] ${data.toString("utf8").trim()}`);
    });

    this.process.on("close", () => {
      this._connected = false;
      // Reject all pending requests
      for (const [, pending] of this.pending) {
        pending.reject(new Error("MCP server process exited"));
      }
      this.pending.clear();
    });

    this.process.on("error", (err) => {
      console.error(`[MCP:${this.config.name}] Process error:`, err.message);
      this._connected = false;
    });

    // Initialize the MCP session
    try {
      await this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "sncode", version: "0.1.0" },
      });
      this._connected = true;

      // Send initialized notification
      this.sendNotification("notifications/initialized", {});

      // List available tools
      await this.refreshTools();
    } catch (err) {
      this.disconnect();
      throw err;
    }
  }

  disconnect(): void {
    if (this.process) {
      try { this.process.kill(); } catch { /* ignore */ }
      this.process = null;
    }
    this._connected = false;
    this.tools = [];
    this.pending.clear();
    this.buffer = "";
  }

  async refreshTools(): Promise<McpTool[]> {
    const response = await this.sendRequest("tools/list", {}) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };

    this.tools = (response.tools || []).map((t) => ({
      name: t.name,
      description: t.description || t.name,
      inputSchema: t.inputSchema || { type: "object", properties: {} },
      serverId: this.config.id,
    }));

    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const response = await this.sendRequest("tools/call", { name, arguments: args }) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };

    if (!response.content || response.content.length === 0) {
      return response.isError ? "Tool execution failed (no output)" : "Done (no output)";
    }

    return response.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n") || "Done";
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) return;
    const message = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.process.stdin.write(message);
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error("MCP server not connected"));
        return;
      }

      const id = nanoid(8);
      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

      this.pending.set(id, { resolve, reject });

      const message = JSON.stringify(request) + "\n";
      this.process.stdin.write(message);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }
      }, 30_000);
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`MCP error: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
        // Ignore notifications from server for now
      } catch {
        // Not valid JSON — ignore
      }
    }
  }
}

/* ── MCP Manager ── */
// Manages multiple MCP server connections

export class McpManager {
  private clients = new Map<string, McpClient>();
  private configs: McpServerConfig[] = [];

  setConfigs(configs: McpServerConfig[]): void {
    this.configs = configs;
  }

  getConfigs(): McpServerConfig[] {
    return [...this.configs];
  }

  async connectServer(config: McpServerConfig): Promise<McpTool[]> {
    // Disconnect existing client for this server if any
    const existing = this.clients.get(config.id);
    if (existing) existing.disconnect();

    const client = new McpClient(config);
    await client.connect();
    this.clients.set(config.id, client);
    return client.serverTools;
  }

  disconnectServer(serverId: string): void {
    const client = this.clients.get(serverId);
    if (client) {
      client.disconnect();
      this.clients.delete(serverId);
    }
  }

  disconnectAll(): void {
    for (const client of this.clients.values()) {
      client.disconnect();
    }
    this.clients.clear();
  }

  getClient(serverId: string): McpClient | undefined {
    return this.clients.get(serverId);
  }

  /** Get all tools from all connected MCP servers */
  getAllTools(): McpTool[] {
    const tools: McpTool[] = [];
    for (const client of this.clients.values()) {
      if (client.connected) {
        tools.push(...client.serverTools);
      }
    }
    return tools;
  }

  /** Call a tool on the appropriate MCP server */
  async callTool(serverId: string, name: string, args: Record<string, unknown>): Promise<string> {
    const client = this.clients.get(serverId);
    if (!client || !client.connected) {
      throw new Error(`MCP server ${serverId} not connected`);
    }
    return client.callTool(name, args);
  }

  /** Check if any server is connected */
  hasConnections(): boolean {
    for (const client of this.clients.values()) {
      if (client.connected) return true;
    }
    return false;
  }
}

// Global singleton
export const mcpManager = new McpManager();
