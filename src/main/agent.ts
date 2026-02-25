import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AgentSettings, ProviderConfig, SubAgentType, ThreadMessage } from "../shared/types";
import { modelEntryById } from "../shared/models";
import { isOAuthCredential, parseOAuthCredential, OAuthData, refreshAnthropicToken, refreshCodexToken } from "./oauth";
import { EnvironmentInfo, listFiles, readTextFile, runCommand, writeTextFile, editFile, globFiles, grepFiles, RunCommandOptions, getEnvironmentInfo } from "./project-tools";
import { applyPatch } from "./apply-patch";
import { loadSkillContent } from "./skills";
import { McpTool, mcpManager } from "./mcp";

/* ── Types ── */

interface AgentCallbacks {
  onChunk: (chunk: string) => void;
  /** Called when a tool is about to execute. Returns a pending message ID. */
  onToolStart: (name: string, detail: string, args?: Record<string, unknown>) => string;
  /** Called when a tool finishes. Receives the pending message ID to update. */
  onToolEnd: (pendingId: string, name: string, detail: string, result: string, durationMs?: number) => void;
  onText: (text: string, metadata?: Record<string, unknown>) => void;
  /** Called when a sub-agent reports progress (updates the task card trail) */
  onTaskProgress?: (pendingId: string, trailEntry: { type: "tool" | "text"; summary: string; timestamp: string }) => void;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
}

export interface RunAgentInput {
  providers: ProviderConfig[];
  history: ThreadMessage[];
  projectRoot: string;
  settings: AgentSettings;
  getCredential: (providerId: ProviderConfig["id"]) => Promise<string | null>;
  abortSignal?: AbortSignal;
  callbacks: AgentCallbacks;
  /** Pre-loaded skill content for skills enabled on this project */
  enabledSkills?: Array<{ name: string; content: string }>;
  /** All available skills the agent can dynamically load via load_skill tool */
  availableSkills?: SkillSummary[];
  /** MCP tools from connected servers */
  mcpTools?: McpTool[];
}

const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_MAX_TOOL_STEPS = 25;
const FALLBACK_CONTEXT_WINDOW = 32768;
const AUTO_COMPACT_THRESHOLD_RATIO = 0.92;
const COMPACT_TARGET_RATIO = 0.67;
const MIN_HISTORY_BUDGET = 256;

/* ── Project memory ── */

const MEMORY_DIR = ".sncode";
const MEMORY_FILE = "memory.md";

function readProjectMemory(projectRoot: string): string {
  try {
    const memPath = path.join(projectRoot, MEMORY_DIR, MEMORY_FILE);
    return fs.readFileSync(memPath, "utf-8");
  } catch {
    return "";
  }
}

function writeProjectMemory(projectRoot: string, content: string): string {
  try {
    const dir = path.join(projectRoot, MEMORY_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MEMORY_FILE), content, "utf-8");
    return "Memory updated successfully.";
  } catch (err) {
    return `Error writing memory: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/* ── Token estimation ── */

/** Rough token estimate: ~4 chars per token for English text */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(msg: ThreadMessage): number {
  let tokens = estimateTokens(msg.content) + 8;
  if (msg.images) {
    // Rough vision input estimate per image.
    tokens += msg.images.length * 1500;
  }
  return tokens;
}

/* ── Context compaction ── */

/**
 * Codex-style context budgeting:
 * estimated usage = system prompt tokens + history tokens + reserved output tokens.
 * If usage crosses threshold, compact history and keep required anchor messages.
 */
function getContextWindow(provider: ProviderConfig): number {
  const modelWindow = modelEntryById(provider.model)?.contextWindow;
  if (typeof modelWindow === "number" && modelWindow > 0) return modelWindow;
  if (provider.id === "anthropic") return 200_000;
  if (provider.id === "codex") return 400_000;
  return FALLBACK_CONTEXT_WINDOW;
}

function toChatHistory(history: ThreadMessage[]): ThreadMessage[] {
  return history.filter((m) => m.role === "user" || m.role === "assistant");
}

function estimateHistoryTokens(history: ThreadMessage[]): number {
  let total = 0;
  for (const msg of history) total += estimateMessageTokens(msg);
  return total;
}

function findLastIndexByRole(history: ThreadMessage[], role: "user" | "assistant"): number {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === role) return i;
  }
  return -1;
}

function buildRequiredIndexes(history: ThreadMessage[]): Set<number> {
  const required = new Set<number>();
  if (history.length === 0) return required;

  const lastIdx = history.length - 1;
  required.add(lastIdx);

  const firstUserIdx = history.findIndex((m) => m.role === "user");
  if (firstUserIdx >= 0) required.add(firstUserIdx);

  const latestUserIdx = findLastIndexByRole(history, "user");
  if (latestUserIdx >= 0) {
    required.add(latestUserIdx);
    if (latestUserIdx > 0 && history[latestUserIdx - 1].role === "assistant") {
      required.add(latestUserIdx - 1);
    }
  }

  const latestAssistantIdx = findLastIndexByRole(history, "assistant");
  if (latestAssistantIdx >= 0) required.add(latestAssistantIdx);

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    if (msg.role !== "assistant") continue;
    if (!msg.content.startsWith("[Context compacted")) continue;
    required.add(i);
    break;
  }

  return required;
}

function compactHistoryToBudget(history: ThreadMessage[], historyBudget: number): ThreadMessage[] {
  if (history.length <= 2) return history;
  const budget = Math.max(MIN_HISTORY_BUDGET, historyBudget);

  const tokenByIndex = history.map((msg) => estimateMessageTokens(msg));
  const required = buildRequiredIndexes(history);
  const selected = new Set<number>();
  let used = 0;

  const trySelect = (idx: number): boolean => {
    if (idx < 0 || idx >= history.length) return false;
    if (selected.has(idx)) return true;
    const cost = tokenByIndex[idx];
    if (used + cost > budget) return false;
    selected.add(idx);
    used += cost;
    return true;
  };

  // Prioritize required messages newest-first.
  const requiredNewestFirst = [...required].sort((a, b) => b - a);
  for (const idx of requiredNewestFirst) {
    void trySelect(idx);
  }

  // Backfill with newest optional messages until budget is reached.
  for (let idx = history.length - 1; idx >= 0; idx -= 1) {
    if (required.has(idx)) continue;
    if (!trySelect(idx)) continue;
  }

  if (selected.size === 0) {
    // Always keep at least the latest message, even if it exceeds budget.
    selected.add(history.length - 1);
  }

  const sorted = [...selected].sort((a, b) => a - b);
  return sorted.map((idx) => history[idx]);
}

function prepareHistoryForRequest(
  provider: ProviderConfig,
  history: ThreadMessage[],
  systemPrompt: string,
  maxOutputTokens: number
): ThreadMessage[] {
  const chatHistory = toChatHistory(history);
  if (chatHistory.length <= 2) return chatHistory;

  const contextWindow = getContextWindow(provider);
  const systemTokens = estimateTokens(systemPrompt);
  const triggerLimit = Math.floor(contextWindow * AUTO_COMPACT_THRESHOLD_RATIO);
  const targetUsage = Math.floor(contextWindow * COMPACT_TARGET_RATIO);

  const historyTokens = estimateHistoryTokens(chatHistory);
  const estimatedUsage = systemTokens + historyTokens + maxOutputTokens;
  if (estimatedUsage <= triggerLimit) return chatHistory;

  let historyBudget = targetUsage - systemTokens - maxOutputTokens;
  if (historyBudget < MIN_HISTORY_BUDGET) {
    historyBudget = contextWindow - systemTokens - maxOutputTokens;
  }
  if (historyBudget < MIN_HISTORY_BUDGET) {
    historyBudget = MIN_HISTORY_BUDGET;
  }

  let compacted = compactHistoryToBudget(chatHistory, historyBudget);
  const compactedUsage = systemTokens + estimateHistoryTokens(compacted) + maxOutputTokens;
  if (compactedUsage > contextWindow) {
    const hardBudget = Math.max(MIN_HISTORY_BUDGET, contextWindow - systemTokens - maxOutputTokens);
    compacted = compactHistoryToBudget(compacted, hardBudget);
  }

  return compacted;
}

/* ── Timeout helper ── */

const SUB_AGENT_TIMEOUT_MS = 180_000; // 3 minutes per sub-agent API call

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }).catch((e) => { clearTimeout(timer); reject(e); });
  });
}

/* ── System prompt ── */

function platformLabel(platform: string): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  return "Linux";
}

function buildSystemPrompt(
  env: EnvironmentInfo,
  projectRoot: string,
  enabledSkills?: Array<{ name: string; content: string }>,
  availableSkills?: SkillSummary[],
  projectMemory?: string
): string {
  const today = new Date().toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  const platformName = platformLabel(env.platform);

  let prompt = `You are SnCode, an interactive AI coding agent running as a desktop application.
You help users with software engineering tasks: solving bugs, adding features, refactoring code, writing tests, explaining code, running builds, and more.

You have access to tools to inspect and edit code in the user's project. Use tools proactively when you need to explore the codebase, read files, write changes, or run commands. Do not guess at code or file contents — always read first.

# Tone and style
- Be direct, concise, and action-oriented. Skip unnecessary filler.
- Use markdown formatting in responses (code blocks, headers, lists, bold, etc.).
- When referencing specific code, mention the file path and relevant context.
- After completing a task, provide a brief summary of what you did.
- Prioritize technical accuracy. If you're uncertain, investigate first rather than guessing.

# Environment
<env>
  Platform: ${platformName} (${env.arch})
  Shell: ${env.shellName} (${env.shellPath})
  Working directory: ${projectRoot}
  Today's date: ${today}
</env>

# Tool usage
- You can call multiple tools in sequence. Use them frequently to gather context before making changes.
- Always read a file before editing it. Never guess at file contents.
- When exploring a codebase, start by listing files at the root, then read key files (package.json, README, config files) to understand the project structure.
- If the user provides an image, analyze its contents to help with their request.

# File editing
- For multi-file or multi-hunk edits, prefer apply_patch. Keep patches focused and reviewable.
- ALWAYS prefer edit_file over write_file for existing files. edit_file makes precise string replacements without rewriting the entire file.
- ALWAYS read_file first before using edit_file, so you have the exact text to match.
- When using edit_file, provide enough surrounding context in old_string to uniquely identify the target location.
- Only use write_file when creating new files, or when the changes are so extensive that edit_file would be impractical.
- When using write_file, include the COMPLETE file content. Never use placeholder comments like "// ... rest of the code".

# Searching
- Use glob to find files by name/pattern (e.g. "**/*.ts", "src/**/*.tsx"). It's fast and skips heavy directories automatically.
- Use grep to search file contents by regex (e.g. "function handleClick", "TODO|FIXME"). Filter by file type with include (e.g. "*.ts").
- Prefer glob and grep over run_command for file search tasks — they are faster, safer, and cross-platform.
- Only use run_command for grep/find when you need features not available in the built-in tools.

# Rules for run_command
- Your shell is ${env.shellName}. Write commands compatible with ${platformName} and ${env.shellName}.${env.platform === "win32" ? "\n- Use PowerShell syntax. For example: Get-ChildItem instead of ls, Select-String instead of grep, Remove-Item instead of rm." : ""}
- When searching code (grep, rg, find), NEVER search inside node_modules, .git, dist, build, .next, or vendor directories.${env.platform !== "win32" ? "\n- For grep, always add --exclude-dir=node_modules --exclude-dir=.git. Prefer ripgrep (rg) over grep — it respects .gitignore by default." : "\n- Prefer Select-String with -Path targeting specific folders, or use rg (ripgrep) if available."}
- Keep commands short-lived. Avoid long-running processes (dev servers, watchers, interactive commands) unless explicitly asked.
- Always quote file paths that contain spaces.
- NEVER run destructive commands (like deleting folders, reformatting disks, force pushing) without the user explicitly asking.

# Git
- Do NOT make git commits unless the user explicitly asks you to.
- When asked to commit, first check git status and git diff to understand what's being committed.
- Write concise commit messages that focus on the "why" rather than the "what".
- NEVER force push, amend pushed commits, or run destructive git operations unless the user explicitly requests it.
- Do not commit files that likely contain secrets (.env, credentials, tokens).

# Code changes
- ALWAYS prefer editing existing files over creating new ones.
- When writing or editing code, follow the existing code style and conventions in the project.
- After making changes, consider running relevant checks (typecheck, lint, build, tests) to verify correctness.
- If a build or test fails after your change, analyze the error and fix it.
- Only create new files when the task genuinely requires it.`;

  // Append project memory if present
  if (projectMemory && projectMemory.trim()) {
    prompt += `\n\n# Project Memory
The following is persistent memory for this project. It carries over across all threads and sessions. Use the \`memory_read\` and \`memory_write\` tools to read and update it. Save important context here: project conventions, architecture decisions, key file locations, user preferences, resolved issues, etc.

<project_memory>
${projectMemory.trim()}
</project_memory>`;
  } else {
    prompt += `\n\n# Project Memory
This project has no saved memory yet. Use the \`memory_write\` tool to save important context that should persist across threads: project conventions, architecture decisions, key file locations, user preferences, etc.`;
  }

  // Append available skills section
  if (availableSkills && availableSkills.length > 0) {
    let skillsSection = `\n\n# Available Skills\nYou have access to specialized skills that provide domain-specific instructions. Use the \`load_skill\` tool to load a skill when a task matches its description.\n\n<available_skills>\n`;
    for (const skill of availableSkills) {
      skillsSection += `  <skill>\n    <name>${skill.name}</name>\n    <id>${skill.id}</id>\n    <description>${skill.description}</description>\n  </skill>\n`;
    }
    skillsSection += `</available_skills>`;
    prompt += skillsSection;
  }

  // Append enabled skill content (already loaded)
  if (enabledSkills && enabledSkills.length > 0) {
    for (const skill of enabledSkills) {
      prompt += `\n\n<skill_content name="${skill.name}">\n${skill.content}\n</skill_content>`;
    }
  }

  return prompt;
}

function mcpToolName(tool: McpTool): string {
  return `mcp__${tool.serverId}__${tool.name}`;
}

function parseMcpToolName(name: string): { serverId: string; toolName: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  return { serverId: parts[1], toolName: parts.slice(2).join("__") };
}

/* ── Anthropic native tool definitions ── */

function buildAnthropicTools(env: EnvironmentInfo, availableSkills?: SkillSummary[], mcpTools?: McpTool[]): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [
    {
      name: "list_files",
      description: "List files and directories at a relative path within the project. Returns an array of {name, type} entries. Does not recurse into subdirectories.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Relative path within the project (default: '.')" },
        },
        required: [],
      },
    },
    {
      name: "read_file",
      description: "Read the full text content of a file at a relative path within the project. Max 300KB. Always use this before editing a file.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Relative file path to read" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Write COMPLETE content to a file at a relative path within the project. Creates parent directories as needed. Always include the full file content — never use placeholders or ellipsis for omitted code.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Relative file path to write" },
          content: { type: "string", description: "The COMPLETE file content to write. Must include all lines." },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file",
      description: "Make an exact string replacement in a file. Finds oldString and replaces it with newString. ALWAYS read the file first before editing. The oldString must match exactly (including whitespace and indentation). If oldString appears multiple times, provide more context to make it unique, or set replaceAll to true.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Relative file path to edit" },
          old_string: { type: "string", description: "The exact text to find and replace. Must match the file content exactly." },
          new_string: { type: "string", description: "The replacement text" },
          replace_all: { type: "boolean", description: "If true, replace ALL occurrences. Default false." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    {
      name: "glob",
      description: "Find files by glob pattern (e.g. \"**/*.ts\", \"src/**/*.tsx\", \"*.json\"). Returns matching file paths. Automatically skips node_modules, .git, dist, build, and other heavy directories.",
      input_schema: {
        type: "object" as const,
        properties: {
          pattern: { type: "string", description: "Glob pattern to match files (e.g. \"**/*.ts\")" },
          path: { type: "string", description: "Relative directory to search in (default: \".\")" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "grep",
      description: "Search file contents using a regex pattern. Returns matching file paths, line numbers, and line content. Automatically skips binary files and heavy directories. Use the include parameter to filter by file extension.",
      input_schema: {
        type: "object" as const,
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for (e.g. \"function\\\\s+handleClick\", \"TODO|FIXME\")" },
          include: { type: "string", description: "File pattern to filter (e.g. \"*.ts\", \"*.{ts,tsx}\")" },
          path: { type: "string", description: "Relative directory to search in (default: \".\")" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "run_command",
      description: `Run a ${env.shellName} command in the project root directory. Returns stdout, stderr, and exit code. Commands run in ${env.shellName} on ${platformLabel(env.platform)}. Commands time out after 90 seconds. Avoid long-running or interactive processes. Prefer using the glob and grep tools over shelling out to find/grep when searching for files or content.`,
      input_schema: {
        type: "object" as const,
        properties: {
          command: { type: "string", description: `${env.shellName} command to execute` },
        },
        required: ["command"],
      },
    },
    {
      name: "apply_patch",
      description: "Apply a multi-file patch using the Codex apply_patch format. Supports Add/Update/Delete and Move-to in a single atomic patch.",
      input_schema: {
        type: "object" as const,
        properties: {
          patch: { type: "string", description: "Patch text that starts with '*** Begin Patch' and ends with '*** End Patch'." },
        },
        required: ["patch"],
      },
    },
  ];

  // Codex CLI naming compatibility.
  tools.push(
    {
      name: "shell_command",
      description: `Alias of run_command. Run a ${env.shellName} command in the project root directory.`,
      input_schema: {
        type: "object" as const,
        properties: {
          command: { type: "string", description: `${env.shellName} command to execute` },
        },
        required: ["command"],
      },
    },
    {
      name: "update_plan",
      description: "Update the task plan (Codex-compatible helper).",
      input_schema: {
        type: "object" as const,
        properties: {
          explanation: { type: "string", description: "Optional short explanation." },
          plan: {
            type: "array",
            description: "Ordered steps with status fields.",
            items: {
              type: "object",
              properties: {
                step: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["step", "status"],
            },
          },
        },
        required: ["plan"],
      },
    },
    {
      name: "list_mcp_resources",
      description: "List resources exposed by connected MCP servers. Optional server and cursor filters.",
      input_schema: {
        type: "object" as const,
        properties: {
          server: { type: "string", description: "Optional MCP server ID to scope results." },
          cursor: { type: "string", description: "Optional pagination cursor." },
        },
        required: [],
      },
    },
    {
      name: "list_mcp_resource_templates",
      description: "List parameterized MCP resource templates. Optional server and cursor filters.",
      input_schema: {
        type: "object" as const,
        properties: {
          server: { type: "string", description: "Optional MCP server ID to scope results." },
          cursor: { type: "string", description: "Optional pagination cursor." },
        },
        required: [],
      },
    },
    {
      name: "read_mcp_resource",
      description: "Read one MCP resource by server ID and resource URI.",
      input_schema: {
        type: "object" as const,
        properties: {
          server: { type: "string", description: "MCP server ID." },
          uri: { type: "string", description: "Resource URI returned by list_mcp_resources." },
        },
        required: ["server", "uri"],
      },
    }
  );

  // Memory tools
  tools.push(
    {
      name: "memory_read",
      description: "Read the project's persistent memory file (.sncode/memory.md). Use this to recall saved context about the project: conventions, architecture decisions, key file locations, user preferences, etc.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
    {
      name: "memory_write",
      description: "Write to the project's persistent memory file (.sncode/memory.md). This REPLACES the entire memory content. Use this to save important context that should persist across threads: project conventions, architecture decisions, key file locations, resolved issues, user preferences. Always read memory first, then write the updated version.",
      input_schema: {
        type: "object" as const,
        properties: {
          content: { type: "string", description: "The full markdown content to save as project memory." },
        },
        required: ["content"],
      },
    }
  );

  // Add load_skill tool if there are available skills
  if (availableSkills && availableSkills.length > 0) {
    tools.push({
      name: "load_skill",
      description: "Load a specialized skill to get domain-specific instructions and workflows. Use this when a task matches an available skill's description. The skill content will be returned and should guide your approach to the task.",
      input_schema: {
        type: "object" as const,
        properties: {
          skill_id: { type: "string", description: "The ID of the skill to load (from the available_skills list)" },
        },
        required: ["skill_id"],
      },
    });
  }

  // Add connected MCP tools.
  if (mcpTools && mcpTools.length > 0) {
    for (const tool of mcpTools) {
      tools.push({
        name: mcpToolName(tool),
        description: `[MCP:${tool.serverId}] ${tool.description || tool.name}`,
        input_schema: (tool.inputSchema || { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
      });
    }
  }

  // spawn_task — sub-agent delegation
  tools.push({
    name: "spawn_task",
    description: `Launch a sub-agent to handle a specific task autonomously. Use this to delegate complex multi-step work or codebase exploration to a separate agent that runs independently. Two types are available:
- "general": Full tool access (read, write, edit, glob, grep, run_command). Use for tasks that require making changes or running commands.
- "explore": Read-only tools (list_files, read_file, glob, grep). Use for fast research, finding files, understanding code structure, or answering questions about the codebase.
The sub-agent receives your prompt and returns a final summary. Use clear, detailed prompts that specify exactly what to do and what to return.`,
    input_schema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string", description: "Detailed task description for the sub-agent. Be specific about what to do and what to return." },
        description: { type: "string", description: "Short (3-8 word) description of the task for display purposes." },
        type: { type: "string", enum: ["general", "explore"], description: "Sub-agent type: 'general' for full access, 'explore' for read-only research." },
      },
      required: ["prompt", "description", "type"],
    },
  });

  return tools;
}

/* ── OpenAI native tool definitions ── */

function buildOpenAITools(env: EnvironmentInfo, availableSkills?: SkillSummary[], mcpTools?: McpTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files and directories at a relative path within the project. Does not recurse.",
        parameters: { type: "object", properties: { path: { type: "string", description: "Relative path (default: '.')" } }, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read the full text content of a file at a relative path. Max 300KB. Always read before editing.",
        parameters: { type: "object", properties: { path: { type: "string", description: "Relative file path to read" } }, required: ["path"] },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write COMPLETE content to a file. Creates parent directories as needed. Always include the full file content.",
        parameters: { type: "object", properties: { path: { type: "string", description: "Relative file path to write" }, content: { type: "string", description: "The COMPLETE file content. Must include all lines." } }, required: ["path", "content"] },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "Make an exact string replacement in a file. ALWAYS read the file first. oldString must match exactly including whitespace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative file path to edit" },
            old_string: { type: "string", description: "Exact text to find and replace" },
            new_string: { type: "string", description: "Replacement text" },
            replace_all: { type: "boolean", description: "Replace ALL occurrences (default: false)" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: "Find files by glob pattern (e.g. \"**/*.ts\"). Skips node_modules, .git, dist, etc.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern (e.g. \"**/*.ts\")" },
            path: { type: "string", description: "Directory to search in (default: \".\")" },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search file contents with regex. Returns file paths, line numbers, and matching lines. Skips binary files and heavy directories.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern to search for" },
            include: { type: "string", description: "File pattern filter (e.g. \"*.ts\")" },
            path: { type: "string", description: "Directory to search in (default: \".\")" },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description: `Run a ${env.shellName} command in the project root on ${platformLabel(env.platform)}. 90s timeout. Prefer glob/grep tools over shelling out for file searches.`,
        parameters: { type: "object", properties: { command: { type: "string", description: `${env.shellName} command to execute` } }, required: ["command"] },
      },
    },
    {
      type: "function",
      function: {
        name: "apply_patch",
        description: "Apply a multi-file patch using the Codex apply_patch format. Supports Add/Update/Delete and Move-to in a single atomic patch.",
        parameters: {
          type: "object",
          properties: {
            patch: { type: "string", description: "Patch text that starts with '*** Begin Patch' and ends with '*** End Patch'." },
          },
          required: ["patch"],
        },
      },
    },
  ];

  // Codex CLI naming compatibility.
  tools.push(
    {
      type: "function",
      function: {
        name: "shell_command",
        description: `Alias of run_command. Run a ${env.shellName} command in the project root on ${platformLabel(env.platform)}.`,
        parameters: { type: "object", properties: { command: { type: "string", description: `${env.shellName} command to execute` } }, required: ["command"] },
      },
    },
    {
      type: "function",
      function: {
        name: "update_plan",
        description: "Update the task plan (Codex-compatible helper).",
        parameters: {
          type: "object",
          properties: {
            explanation: { type: "string", description: "Optional short explanation." },
            plan: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  step: { type: "string" },
                  status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                },
                required: ["step", "status"],
              },
            },
          },
          required: ["plan"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_mcp_resources",
        description: "List resources exposed by connected MCP servers. Optional server and cursor filters.",
        parameters: {
          type: "object",
          properties: {
            server: { type: "string", description: "Optional MCP server ID to scope results." },
            cursor: { type: "string", description: "Optional pagination cursor." },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_mcp_resource_templates",
        description: "List parameterized MCP resource templates. Optional server and cursor filters.",
        parameters: {
          type: "object",
          properties: {
            server: { type: "string", description: "Optional MCP server ID to scope results." },
            cursor: { type: "string", description: "Optional pagination cursor." },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_mcp_resource",
        description: "Read one MCP resource by server ID and resource URI.",
        parameters: {
          type: "object",
          properties: {
            server: { type: "string", description: "MCP server ID." },
            uri: { type: "string", description: "Resource URI returned by list_mcp_resources." },
          },
          required: ["server", "uri"],
        },
      },
    }
  );

  // Memory tools
  tools.push(
    {
      type: "function",
      function: {
        name: "memory_read",
        description: "Read the project's persistent memory file (.sncode/memory.md). Recall saved context about the project.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_write",
        description: "Write to the project's persistent memory file (.sncode/memory.md). REPLACES the entire memory content. Always read first, then write the updated version.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "Full markdown content to save as project memory." },
          },
          required: ["content"],
        },
      },
    }
  );

  // Add load_skill tool if there are available skills
  if (availableSkills && availableSkills.length > 0) {
    tools.push({
      type: "function",
      function: {
        name: "load_skill",
        description: "Load a specialized skill to get domain-specific instructions. Use when a task matches an available skill's description.",
        parameters: {
          type: "object",
          properties: {
            skill_id: { type: "string", description: "The ID of the skill to load" },
          },
          required: ["skill_id"],
        },
      },
    });
  }

  // Add connected MCP tools.
  if (mcpTools && mcpTools.length > 0) {
    for (const tool of mcpTools) {
      tools.push({
        type: "function",
        function: {
          name: mcpToolName(tool),
          description: `[MCP:${tool.serverId}] ${tool.description || tool.name}`,
          parameters: tool.inputSchema || { type: "object", properties: {} },
        },
      });
    }
  }

  // spawn_task — sub-agent delegation
  tools.push({
    type: "function",
    function: {
      name: "spawn_task",
      description: "Launch a sub-agent to handle a specific task. 'general' type has full tool access; 'explore' type is read-only for fast research.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed task description for the sub-agent" },
          description: { type: "string", description: "Short (3-8 word) task label" },
          type: { type: "string", enum: ["general", "explore"], description: "Sub-agent type" },
        },
        required: ["prompt", "description", "type"],
      },
    },
  });

  return tools;
}

/* ── Sub-agent types ── */

/** Read-only tools available to "explore" sub-agents */
const EXPLORE_TOOLS = new Set(["list_files", "read_file", "glob", "grep"]);

interface SubAgentContext {
  providers: ProviderConfig[];
  getCredential: (providerId: ProviderConfig["id"]) => Promise<string | null>;
  settings: AgentSettings;
  /** Callback to update the task card's detail text */
  onProgress?: (detail: string) => void;
}

/* ── Sub-agent runner (non-streaming, tool loop only) ── */

async function runSubAgent(
  projectRoot: string,
  prompt: string,
  taskType: SubAgentType,
  ctx: SubAgentContext,
  abortSignal?: AbortSignal
): Promise<string> {
  const provider = ctx.providers.find((p) => p.enabled);
  if (!provider) return "Error: No provider enabled.";

  const credential = await ctx.getCredential(provider.id);
  if (!credential) return `Error: ${provider.id} credential not configured.`;

  // Resolve sub-agent model — use configured model, or fall back to parent's model
  const subModel = ctx.settings.subAgentModel || provider.model;
  const subMaxTokens = ctx.settings.subAgentMaxTokens || 8192;
  const subMaxToolSteps = ctx.settings.subAgentMaxToolSteps || 15;
  const isExplore = taskType === "explore";

  const env = getEnvironmentInfo();
  const platformName = platformLabel(env.platform);
  const today = new Date().toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" });

  const subSystemPrompt = `You are a sub-agent of SnCode, working on a specific task. Complete the task described below and return a clear, concise summary of your findings or actions.

# Environment
Platform: ${platformName} | Shell: ${env.shellName} | CWD: ${projectRoot} | Date: ${today}

# Rules
- Focus exclusively on the task given.
- Be thorough but concise in your response.
- Always read files before editing. Use glob/grep to find files.${isExplore ? "\n- You have READ-ONLY access. You cannot write, edit, or run commands." : ""}
- Return a final summary that directly addresses what was asked.`;

  // Use Anthropic or OpenAI based on the active provider
  if (provider.id === "anthropic") {
    return runSubAgentAnthropic(provider, credential, subModel, subSystemPrompt, prompt, subMaxTokens, subMaxToolSteps, env, projectRoot, isExplore, ctx.onProgress, abortSignal);
  }
  return runSubAgentOpenAI(provider, credential, subModel, subSystemPrompt, prompt, subMaxTokens, subMaxToolSteps, env, projectRoot, isExplore, ctx.onProgress, abortSignal);
}

async function runSubAgentAnthropic(
  provider: ProviderConfig, credential: string, model: string, systemPrompt: string, userPrompt: string,
  maxTokens: number, maxToolSteps: number, env: EnvironmentInfo, projectRoot: string, isExplore: boolean,
  onProgress?: (detail: string) => void, abortSignal?: AbortSignal
): Promise<string> {
  const isOAuth = isOAuthCredential(credential);
  let client: Anthropic;
  if (isOAuth) {
    const accessToken = await getValidOAuthToken(credential, "anthropic");
    client = new Anthropic({
      apiKey: "placeholder",
      fetch: async (reqInput: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.delete("x-api-key");
        headers.set("authorization", `Bearer ${accessToken}`);
        headers.set("anthropic-beta", "oauth-2025-04-20,interleaved-thinking-2025-05-14");
        return globalThis.fetch(reqInput, { ...init, headers });
      },
    });
  } else {
    client = new Anthropic({ apiKey: credential });
  }

  const allTools = buildAnthropicTools(env);
  const tools = isExplore ? allTools.filter((t) => EXPLORE_TOOLS.has(t.name)) : allTools.filter((t) => t.name !== "spawn_task" && t.name !== "load_skill" && t.name !== "memory_read" && t.name !== "memory_write");
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];
  let finalText = "";

  for (let step = 0; step < maxToolSteps; step++) {
    if (abortSignal?.aborted) throw new Error("Run cancelled");

    const response = await withTimeout(
      client.messages.create(
        { model, max_tokens: maxTokens, system: systemPrompt, tools, messages },
        { signal: abortSignal }
      ),
      SUB_AGENT_TIMEOUT_MS,
      "Sub-agent Anthropic API call"
    );

    let stepText = "";
    const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    for (const block of response.content) {
      if (block.type === "text") stepText += block.text;
      else if (block.type === "tool_use") toolUses.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
    }

    if (toolUses.length === 0) { finalText = stepText; break; }

    const assistantContent: Anthropic.ContentBlockParam[] = [];
    if (stepText) assistantContent.push({ type: "text", text: stepText });
    for (const t of toolUses) assistantContent.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
    messages.push({ role: "assistant", content: assistantContent });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      if (abortSignal?.aborted) throw new Error("Run cancelled");
      onProgress?.(formatToolDetail(t.name, t.input));
      const result = await executeTool(projectRoot, t.name, t.input, abortSignal);
      toolResults.push({ type: "tool_result", tool_use_id: t.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });

    if (step === maxToolSteps - 1) finalText = stepText || "Reached max tool steps.";
  }

  return finalText;
}

async function runSubAgentOpenAI(
  provider: ProviderConfig, credential: string, model: string, systemPrompt: string, userPrompt: string,
  maxTokens: number, maxToolSteps: number, env: EnvironmentInfo, projectRoot: string, isExplore: boolean,
  onProgress?: (detail: string) => void, abortSignal?: AbortSignal
): Promise<string> {
  const isOAuth = isOAuthCredential(credential);

  // OAuth users → Codex Responses API (different endpoint + request format)
  if (isOAuth) {
    return runCodexOAuthSubAgent(provider, credential, model, systemPrompt, userPrompt, maxTokens, maxToolSteps, env, projectRoot, isExplore, onProgress, abortSignal);
  }

  // API key users → standard Chat Completions API
  const client = new OpenAI({ apiKey: credential });

  const allTools = buildOpenAITools(env);
  const fnName = (t: OpenAI.Chat.Completions.ChatCompletionTool) => t.type === "function" ? t.function.name : "";
  const tools = isExplore
    ? allTools.filter((t) => EXPLORE_TOOLS.has(fnName(t)))
    : allTools.filter((t) => { const n = fnName(t); return n !== "spawn_task" && n !== "load_skill" && n !== "memory_read" && n !== "memory_write"; });
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  let finalText = "";

  for (let step = 0; step < maxToolSteps; step++) {
    if (abortSignal?.aborted) throw new Error("Run cancelled");

    const response = await withTimeout(
      client.chat.completions.create(
        { model, max_completion_tokens: maxTokens, messages, tools },
        { signal: abortSignal }
      ),
      SUB_AGENT_TIMEOUT_MS,
      "Sub-agent OpenAI API call"
    );

    const choice = response.choices[0];
    if (!choice) { finalText = "No response from model."; break; }

    const stepText = choice.message.content || "";
    const rawToolCalls = choice.message.tool_calls || [];
    // Narrow to function-type tool calls only
    const toolCalls = rawToolCalls.filter((tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageToolCall & { type: "function" } => tc.type === "function");

    if (toolCalls.length === 0) { finalText = stepText; break; }

    messages.push({
      role: "assistant",
      content: stepText || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id, type: "function" as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });

    for (const tc of toolCalls) {
      if (abortSignal?.aborted) throw new Error("Run cancelled");
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { /* empty */ }
      onProgress?.(formatToolDetail(tc.function.name, parsedArgs));
      const result = await executeTool(projectRoot, tc.function.name, parsedArgs, abortSignal);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }

    if (step === maxToolSteps - 1) finalText = stepText || "Reached max tool steps.";
  }

  return finalText;
}

/* ── Tool execution ── */

async function executeTool(
  projectRoot: string,
  name: string,
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
  subAgentCtx?: SubAgentContext,
  /** For spawn_task: pending message ID to report trail entries */
  taskPendingId?: string,
  taskProgressCb?: (pendingId: string, entry: { type: "tool" | "text"; summary: string; timestamp: string }) => void,
): Promise<string> {
  try {
    if (abortSignal?.aborted) throw new Error("Run cancelled");

    if (name === "list_files") {
      const pathArg = String(args.path || ".");
      const result = listFiles(projectRoot, pathArg);
      return JSON.stringify(result, null, 2);
    }
    if (name === "read_file") {
      const pathArg = String(args.path || "");
      return readTextFile(projectRoot, pathArg);
    }
    if (name === "write_file") {
      const pathArg = String(args.path || "");
      const contentArg = String(args.content || "");
      writeTextFile(projectRoot, pathArg, contentArg);
      return `Successfully wrote ${pathArg}`;
    }
    if (name === "edit_file") {
      const pathArg = String(args.path || "");
      const oldStr = String(args.old_string || "");
      const newStr = String(args.new_string || "");
      const replaceAllArg = Boolean(args.replace_all);
      const result = editFile(projectRoot, pathArg, oldStr, newStr, replaceAllArg);
      return result.message;
    }
    if (name === "apply_patch") {
      const patch = String(args.patch || "");
      const result = applyPatch(projectRoot, patch);
      return result.message;
    }
    if (name === "glob") {
      const patternArg = String(args.pattern || "");
      const pathArg = String(args.path || ".");
      const result = globFiles(projectRoot, patternArg, pathArg);
      const lines = result.matches;
      if (result.truncated) lines.push(`... (truncated at ${lines.length} results)`);
      return lines.length > 0 ? lines.join("\n") : "No files matched the pattern.";
    }
    if (name === "grep") {
      const patternArg = String(args.pattern || "");
      const includeArg = args.include ? String(args.include) : undefined;
      const pathArg = String(args.path || ".");
      const result = grepFiles(projectRoot, patternArg, { include: includeArg, searchPath: pathArg });
      if (result.matches.length === 0) return "No matches found.";
      const lines = result.matches.map((m) => `${m.file}:${m.line}: ${m.content}`);
      if (result.truncated) lines.push(`... (truncated at ${result.matches.length} matches across ${result.fileCount} files)`);
      else lines.push(`\n${result.matches.length} matches in ${result.fileCount} files`);
      return lines.join("\n");
    }
    if (name === "run_command" || name === "shell_command") {
      const commandArg = String(args.command || "");
      const opts: RunCommandOptions = { abortSignal };
      const result = await runCommand(projectRoot, commandArg, opts);
      return JSON.stringify(result, null, 2);
    }
    if (name === "update_plan") {
      const explanation = typeof args.explanation === "string" ? args.explanation.trim() : "";
      const plan = Array.isArray(args.plan) ? args.plan : [];
      const lines: string[] = [];
      if (explanation) lines.push(explanation);
      if (plan.length > 0) {
        for (const item of plan) {
          if (!item || typeof item !== "object") continue;
          const step = String((item as Record<string, unknown>).step || "");
          const status = String((item as Record<string, unknown>).status || "pending");
          if (!step) continue;
          lines.push(`- [${status}] ${step}`);
        }
      }
      return lines.length > 0 ? `Plan updated:\n${lines.join("\n")}` : "Plan updated.";
    }
    if (name === "list_mcp_resources") {
      const server = args.server ? String(args.server) : undefined;
      const cursor = args.cursor ? String(args.cursor) : undefined;
      const result = await mcpManager.listResources(server, cursor);
      return JSON.stringify(result, null, 2);
    }
    if (name === "list_mcp_resource_templates") {
      const server = args.server ? String(args.server) : undefined;
      const cursor = args.cursor ? String(args.cursor) : undefined;
      const result = await mcpManager.listResourceTemplates(server, cursor);
      return JSON.stringify(result, null, 2);
    }
    if (name === "read_mcp_resource") {
      const server = String(args.server || "");
      const uri = String(args.uri || "");
      if (!server) return "Error: server is required";
      if (!uri) return "Error: uri is required";
      const result = await mcpManager.readResource(server, uri);
      return JSON.stringify(result, null, 2);
    }
    if (name === "memory_read") {
      const content = readProjectMemory(projectRoot);
      return content || "(No project memory saved yet)";
    }
    if (name === "memory_write") {
      const content = String(args.content || "");
      if (!content) return "Error: content is required";
      return writeProjectMemory(projectRoot, content);
    }
    if (name === "load_skill") {
      const skillId = String(args.skill_id || "");
      if (!skillId) return "Error: skill_id is required";
      const skillContent = loadSkillContent(skillId, projectRoot);
      if (!skillContent) return `Skill not found: ${skillId}`;
      return `<skill_content name="${skillContent.skill.name}">\n${skillContent.content}\n</skill_content>`;
    }
    if (name === "spawn_task") {
      if (!subAgentCtx) return "Error: Sub-agent context not available.";
      const prompt = String(args.prompt || "");
      const taskType = (String(args.type || "general")) as SubAgentType;
      if (!prompt) return "Error: prompt is required";
      // Wire up trail tracking via onProgress
      const ctxWithTrail: SubAgentContext = {
        ...subAgentCtx,
        onProgress: taskPendingId && taskProgressCb
          ? (detail) => taskProgressCb(taskPendingId, { type: "tool", summary: detail, timestamp: new Date().toISOString() })
          : subAgentCtx.onProgress,
      };
      const result = await runSubAgent(projectRoot, prompt, taskType, ctxWithTrail, abortSignal);
      return result;
    }
    const mcpParsed = parseMcpToolName(name);
    if (mcpParsed) {
      return await mcpManager.callTool(mcpParsed.serverId, mcpParsed.toolName, args);
    }
    return `Unknown tool: ${name}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === "Run cancelled") throw error; // Let cancel propagate
    return `Tool error: ${msg}`;
  }
}

/* ── OAuth helpers ── */

/** Codex Responses API endpoint — all OAuth requests are rewritten here */
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

async function getValidOAuthToken(
  credential: string,
  providerId: ProviderConfig["id"]
): Promise<string> {
  const oauth = parseOAuthCredential(credential);
  if (!oauth) throw new Error("Invalid OAuth credential");

  if (oauth.expires < Date.now() + 30_000) {
    const refreshed = providerId === "anthropic"
      ? await refreshAnthropicToken(oauth)
      : await refreshCodexToken(oauth);
    return refreshed.access;
  }

  return oauth.access;
}

/** Get valid OAuth data (with refresh if expired) */
async function getValidOAuthData(
  credential: string,
  providerId: ProviderConfig["id"]
): Promise<OAuthData> {
  const oauth = parseOAuthCredential(credential);
  if (!oauth) throw new Error("Invalid OAuth credential");

  if (oauth.expires < Date.now() + 30_000) {
    return providerId === "anthropic"
      ? await refreshAnthropicToken(oauth)
      : await refreshCodexToken(oauth);
  }

  return oauth;
}

/**
 * Build a User-Agent string for Codex requests.
 * Format: "sncode/0.2.0 (win32 10.0.26100; x64)"
 */
function codexUserAgent(): string {
  return `sncode/0.2.0 (${os.platform()} ${os.release()}; ${os.arch()})`;
}

/**
 * Create an OpenAI client configured for Codex OAuth.
 *
 * Key behaviors (matching the reference opencode implementation):
 * 1. URL rewrite: all /v1/responses and /chat/completions requests → CODEX_API_ENDPOINT
 * 2. Authorization: Bearer <access_token> (not API key)
 * 3. ChatGPT-Account-Id header for org subscriptions
 * 4. originator: opencode header
 * 5. Custom User-Agent
 */
function createCodexOAuthClient(oauthData: OAuthData): OpenAI {
  return new OpenAI({
    apiKey: "codex-oauth-placeholder", // dummy, overridden by fetch
    baseURL: "https://api.openai.com/v1",
    fetch: async (reqInput: string | URL | Request, init?: RequestInit) => {
      // Build headers from init
      const headers = new Headers(init?.headers);

      // Remove any default API key authorization
      headers.delete("authorization");
      headers.delete("Authorization");

      // Set Bearer token auth
      headers.set("authorization", `Bearer ${oauthData.access}`);

      // Set ChatGPT-Account-Id for organization subscriptions
      if (oauthData.accountId) {
        headers.set("ChatGPT-Account-Id", oauthData.accountId);
      }

      // Set originator and User-Agent (matching opencode reference)
      headers.set("originator", "opencode");
      headers.set("User-Agent", codexUserAgent());

      // Rewrite URL: /v1/responses and /chat/completions → CODEX_API_ENDPOINT
      let url: URL;
      if (reqInput instanceof URL) {
        url = reqInput;
      } else if (typeof reqInput === "string") {
        url = new URL(reqInput);
      } else {
        url = new URL(reqInput.url);
      }

      const finalUrl =
        url.pathname.includes("/v1/responses") || url.pathname.includes("/chat/completions")
          ? new URL(CODEX_API_ENDPOINT)
          : url;

      // Debug: log outgoing request details
      const headersObj: Record<string, string> = {};
      headers.forEach((v, k) => { headersObj[k] = k.toLowerCase() === "authorization" ? `${v.slice(0, 20)}...` : v; });
      console.log(`[Codex fetch] ${init?.method || "GET"} ${finalUrl.toString()}`);
      console.log(`[Codex fetch] Headers:`, JSON.stringify(headersObj, null, 2));
      if (init?.body) {
        try {
          const bodyStr = typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as ArrayBuffer);
          const bodyJson = JSON.parse(bodyStr);
          // Log body without the full input/tools (too large), just keys and model
          console.log(`[Codex fetch] Body keys:`, Object.keys(bodyJson));
          console.log(`[Codex fetch] model:`, bodyJson.model);
          if (bodyJson.tools) console.log(`[Codex fetch] tools count:`, bodyJson.tools.length, `first tool type:`, bodyJson.tools[0]?.type, `name:`, bodyJson.tools[0]?.name);
          if (bodyJson.input) console.log(`[Codex fetch] input items:`, bodyJson.input.length);
          if (bodyJson.messages) console.log(`[Codex fetch] messages count:`, bodyJson.messages.length, `(WRONG FORMAT — Chat Completions detected!)`);
          if (bodyJson.stream !== undefined) console.log(`[Codex fetch] stream:`, bodyJson.stream);
          if (bodyJson.instructions) console.log(`[Codex fetch] instructions length:`, bodyJson.instructions.length);
        } catch { console.log(`[Codex fetch] Body: (not JSON)`); }
      }

      const response = await globalThis.fetch(finalUrl, { ...init, headers });

      // Debug: log response status and body on error
      if (!response.ok) {
        const cloned = response.clone();
        const errorBody = await cloned.text().catch(() => "(could not read body)");
        console.error(`[Codex fetch] ERROR ${response.status} ${response.statusText}`);
        console.error(`[Codex fetch] Response headers:`, Object.fromEntries(cloned.headers.entries()));
        console.error(`[Codex fetch] Response body:`, errorBody || "(empty)");
      } else {
        console.log(`[Codex fetch] OK ${response.status}`);
      }

      return response;
    },
  });
}

/* ── Convert ThreadMessage history → Anthropic messages ── */

function toAnthropicMessages(history: ThreadMessage[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const msg of history) {
    if (msg.role === "user") {
      if (msg.images && msg.images.length > 0) {
        // Multimodal: images + text
        const content: Anthropic.ContentBlockParam[] = [];
        for (const img of msg.images) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: img.data,
            },
          });
        }
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        messages.push({ role: "user", content });
      } else {
        messages.push({ role: "user", content: msg.content });
      }
    } else if (msg.role === "assistant") {
      messages.push({ role: "assistant", content: msg.content });
    }
  }
  return messages;
}

/* ── Convert ThreadMessage history → OpenAI messages ── */

function toOpenAIMessages(history: ThreadMessage[], systemPrompt: string): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];
  for (const msg of history) {
    if (msg.role === "user") {
      if (msg.images && msg.images.length > 0) {
        // Multimodal: images + text
        const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
        for (const img of msg.images) {
          content.push({
            type: "image_url",
            image_url: { url: `data:${img.mediaType};base64,${img.data}` },
          });
        }
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        messages.push({ role: "user", content });
      } else {
        messages.push({ role: "user", content: msg.content });
      }
    } else if (msg.role === "assistant") {
      messages.push({ role: "assistant", content: msg.content });
    }
  }
  return messages;
}

/* ── Codex Responses API helpers ── */

/** Convert Chat Completions tool defs to Responses API format */
function toResponsesTools(
  chatTools: OpenAI.Chat.Completions.ChatCompletionTool[]
): Array<{ type: "function"; name: string; description: string; parameters: Record<string, unknown> }> {
  return chatTools
    .filter((t): t is OpenAI.Chat.Completions.ChatCompletionTool & { type: "function"; function: { name: string; description?: string; parameters?: unknown } } => t.type === "function" && "function" in t)
    .map((t) => ({
      type: "function" as const,
      name: t.function.name,
      description: t.function.description || "",
      parameters: (t.function.parameters || { type: "object", properties: {} }) as Record<string, unknown>,
    }));
}

/** Convert ThreadMessage history to Responses API input items */
function toResponsesInput(history: ThreadMessage[]): any[] {
  const items: any[] = [];
  for (const msg of history) {
    if (msg.role === "user") {
      if (msg.images && msg.images.length > 0) {
        const content: any[] = [];
        for (const img of msg.images) {
          content.push({
            type: "input_image",
            image_url: `data:${img.mediaType};base64,${img.data}`,
          });
        }
        if (msg.content) {
          content.push({ type: "input_text", text: msg.content });
        }
        items.push({ role: "user", content });
      } else {
        items.push({ role: "user", content: msg.content });
      }
    } else if (msg.role === "assistant") {
      items.push({ role: "assistant", content: msg.content });
    }
  }
  return items;
}

/** Internal type for accumulated function calls from Responses API */
interface CodexFnCall {
  id: string;
  callId: string;
  name: string;
  arguments: string;
}

/* ── Codex OAuth streaming agentic loop (Responses API) ── */

async function runCodexOAuthAgent(
  provider: ProviderConfig,
  credential: string,
  input: RunAgentInput
): Promise<AgentResult> {
  const oauthData = await getValidOAuthData(credential, "codex");
  const client = createCodexOAuthClient(oauthData);

  const env = getEnvironmentInfo();
  const projectMemory = readProjectMemory(input.projectRoot);
  const systemPrompt = buildSystemPrompt(env, input.projectRoot, input.enabledSkills, input.availableSkills, projectMemory);
  const chatTools = buildOpenAITools(env, input.availableSkills, input.mcpTools);
  const tools = toResponsesTools(chatTools);

  const maxTokens = input.settings.maxTokens || DEFAULT_MAX_TOKENS;
  const compactedHistory = prepareHistoryForRequest(provider, input.history, systemPrompt, maxTokens);
  const inputItems: any[] = toResponsesInput(compactedHistory);
  const maxToolSteps = input.settings.maxToolSteps || DEFAULT_MAX_TOOL_STEPS;
  let finalText = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const subAgentCtx: SubAgentContext = {
    providers: input.providers,
    getCredential: input.getCredential,
    settings: input.settings,
  };

  // Reasoning effort — Codex 5.2/5.3 support: low, medium, high, xhigh
  // Codex 5.1 supports: low, medium, high. Default to "medium" (matching opencode reference).
  const thinkingLevel = input.settings.thinkingLevel || "none";
  const reasoningEffort = thinkingLevel !== "none" ? thinkingLevel : "medium";

  for (let step = 0; step < maxToolSteps; step++) {
    if (input.abortSignal?.aborted) throw new Error("Run cancelled");

    let stepText = "";
    const functionCalls: CodexFnCall[] = [];
    const fnAccumulators = new Map<number, CodexFnCall>();
    let stepInputTokens = 0;
    let stepOutputTokens = 0;

    const createParams: any = {
      model: provider.model,
      instructions: systemPrompt,
      input: inputItems,
      tools,
      store: false, // Codex endpoint requires store=false
      reasoning: { effort: reasoningEffort, summary: "auto" },
      max_output_tokens: maxTokens,
    };

    const stream = client.responses.stream(createParams);

    for await (const event of stream as any as AsyncIterable<any>) {
      if (input.abortSignal?.aborted) throw new Error("Run cancelled");

      const t = event.type as string;

      if (t === "response.output_text.delta") {
        stepText += event.delta;
        input.callbacks.onChunk(event.delta);
      } else if (t === "response.output_item.added" && event.item?.type === "function_call") {
        fnAccumulators.set(event.output_index, {
          id: event.item.id ?? "",
          callId: event.item.call_id ?? "",
          name: event.item.name ?? "",
          arguments: "",
        });
      } else if (t === "response.function_call_arguments.delta") {
        const acc = fnAccumulators.get(event.output_index);
        if (acc) acc.arguments += event.delta;
      } else if (t === "response.output_item.done" && event.item?.type === "function_call") {
        const acc = fnAccumulators.get(event.output_index);
        if (acc) {
          acc.id = event.item.id ?? acc.id;
          acc.callId = event.item.call_id ?? acc.callId;
          acc.name = event.item.name ?? acc.name;
          acc.arguments = event.item.arguments ?? acc.arguments;
          functionCalls.push({ ...acc });
        }
      } else if (t === "response.completed") {
        const usage = event.response?.usage;
        if (usage) {
          stepInputTokens = usage.input_tokens ?? 0;
          stepOutputTokens = usage.output_tokens ?? 0;
        }
      }
    }

    // No function calls → final answer
    if (functionCalls.length === 0) {
      finalText = stepText;
      totalInputTokens += stepInputTokens;
      totalOutputTokens += stepOutputTokens;
      break;
    }

    totalInputTokens += stepInputTokens;
    totalOutputTokens += stepOutputTokens;

    // Emit intermediate text
    if (stepText.trim()) {
      input.callbacks.onText(stepText, { inputTokens: stepInputTokens, outputTokens: stepOutputTokens });
    }

    // Separate spawn_task (parallel) from sequential tools
    const spawnTasks: CodexFnCall[] = [];
    const sequentialFns: CodexFnCall[] = [];
    for (const fc of functionCalls) {
      if (fc.name === "spawn_task") spawnTasks.push(fc);
      else sequentialFns.push(fc);
    }

    // Results map: callId → result
    const resultsMap = new Map<string, string>();

    // Run sequential tools
    for (const fc of sequentialFns) {
      if (input.abortSignal?.aborted) throw new Error("Run cancelled");
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = fc.arguments ? JSON.parse(fc.arguments) : {}; } catch { /* empty */ }
      const detail = formatToolDetail(fc.name, parsedArgs);
      const pendingId = input.callbacks.onToolStart(fc.name, detail, parsedArgs);
      const t0 = Date.now();
      const result = await executeTool(input.projectRoot, fc.name, parsedArgs, input.abortSignal, subAgentCtx, pendingId, input.callbacks.onTaskProgress);
      input.callbacks.onToolEnd(pendingId, fc.name, detail, result, Date.now() - t0);
      resultsMap.set(fc.callId, result);
    }

    // Run spawn_task calls in parallel
    if (spawnTasks.length > 0) {
      const maxConcurrent = input.settings.maxConcurrentTasks || 3;
      const pendingIds = new Map<string, string>();
      for (const fc of spawnTasks) {
        let parsedArgs: Record<string, unknown> = {};
        try { parsedArgs = fc.arguments ? JSON.parse(fc.arguments) : {}; } catch { /* empty */ }
        const detail = formatToolDetail(fc.name, parsedArgs);
        const pendingId = input.callbacks.onToolStart(fc.name, detail, parsedArgs);
        pendingIds.set(fc.callId, pendingId);
      }
      for (let batch = 0; batch < spawnTasks.length; batch += maxConcurrent) {
        const batchItems = spawnTasks.slice(batch, batch + maxConcurrent);
        await Promise.all(batchItems.map(async (fc) => {
          let parsedArgs: Record<string, unknown> = {};
          try { parsedArgs = fc.arguments ? JSON.parse(fc.arguments) : {}; } catch { /* empty */ }
          const t0 = Date.now();
          const pId = pendingIds.get(fc.callId)!;
          const result = await executeTool(input.projectRoot, fc.name, parsedArgs, input.abortSignal, subAgentCtx, pId, input.callbacks.onTaskProgress);
          const detail = formatToolDetail(fc.name, parsedArgs);
          input.callbacks.onToolEnd(pId, fc.name, detail, result, Date.now() - t0);
          resultsMap.set(fc.callId, result);
        }));
      }
    }

    // Append assistant output + tool results to input for the next turn
    // The Responses API expects function_call items followed by function_call_output items
    if (stepText) {
      inputItems.push({ role: "assistant", content: stepText });
    }
    for (const fc of functionCalls) {
      inputItems.push({
        type: "function_call",
        id: fc.id,
        call_id: fc.callId,
        name: fc.name,
        arguments: fc.arguments,
      });
      inputItems.push({
        type: "function_call_output",
        call_id: fc.callId,
        output: resultsMap.get(fc.callId) || "",
      });
    }

    if (step === maxToolSteps - 1) {
      finalText = stepText || "Reached maximum tool steps. Please continue with a follow-up message.";
    }
  }

  return { text: finalText, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
}

/* ── Codex OAuth sub-agent (Responses API, non-streaming) ── */

async function runCodexOAuthSubAgent(
  provider: ProviderConfig, credential: string, model: string, systemPrompt: string, userPrompt: string,
  maxTokens: number, maxToolSteps: number, env: EnvironmentInfo, projectRoot: string, isExplore: boolean,
  onProgress?: (detail: string) => void, abortSignal?: AbortSignal
): Promise<string> {
  const oauthData = await getValidOAuthData(credential, "codex");
  const client = createCodexOAuthClient(oauthData);

  const allChatTools = buildOpenAITools(env);
  const fnName = (t: OpenAI.Chat.Completions.ChatCompletionTool) => t.type === "function" ? t.function.name : "";
  const filteredChatTools = isExplore
    ? allChatTools.filter((t) => EXPLORE_TOOLS.has(fnName(t)))
    : allChatTools.filter((t) => { const n = fnName(t); return n !== "spawn_task" && n !== "load_skill" && n !== "memory_read" && n !== "memory_write"; });
  const tools = toResponsesTools(filteredChatTools);

  const inputItems: any[] = [{ role: "user", content: userPrompt }];
  let finalText = "";

  for (let step = 0; step < maxToolSteps; step++) {
    if (abortSignal?.aborted) throw new Error("Run cancelled");

    const response: any = await withTimeout(
      client.responses.create(
        {
          model,
          instructions: systemPrompt,
          input: inputItems,
          tools,
          store: false, // Codex endpoint requires store=false
        } as any,
        { signal: abortSignal }
      ),
      SUB_AGENT_TIMEOUT_MS,
      "Sub-agent Codex API call"
    );

    // Extract text and function calls from response output
    let stepText = "";
    const functionCalls: CodexFnCall[] = [];

    for (const item of response.output || []) {
      if (item.type === "message") {
        for (const part of item.content || []) {
          if (part.type === "output_text") stepText += part.text;
        }
      } else if (item.type === "function_call") {
        functionCalls.push({
          id: item.id || "",
          callId: item.call_id || "",
          name: item.name || "",
          arguments: item.arguments || "",
        });
      }
    }

    if (functionCalls.length === 0) {
      finalText = stepText;
      break;
    }

    // Append assistant text to input
    if (stepText) {
      inputItems.push({ role: "assistant", content: stepText });
    }

    // Execute tools and append function_call + function_call_output to input
    for (const fc of functionCalls) {
      if (abortSignal?.aborted) throw new Error("Run cancelled");
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = fc.arguments ? JSON.parse(fc.arguments) : {}; } catch { /* empty */ }
      onProgress?.(formatToolDetail(fc.name, parsedArgs));
      const result = await executeTool(projectRoot, fc.name, parsedArgs, abortSignal);

      inputItems.push({
        type: "function_call",
        id: fc.id,
        call_id: fc.callId,
        name: fc.name,
        arguments: fc.arguments,
      });
      inputItems.push({
        type: "function_call_output",
        call_id: fc.callId,
        output: result,
      });
    }

    if (step === maxToolSteps - 1) finalText = stepText || "Reached max tool steps.";
  }

  return finalText;
}

/* ── Helpers ── */

function formatToolDetail(name: string, args: Record<string, unknown>): string {
  if (name === "list_files") return `Listing ${String(args.path || ".")}`;
  if (name === "read_file") return `Reading ${String(args.path || "")}`;
  if (name === "write_file") return `Writing ${String(args.path || "")}`;
  if (name === "edit_file") return `Editing ${String(args.path || "")}`;
  if (name === "apply_patch") return "Applying patch";
  if (name === "glob") return `Finding ${String(args.pattern || "")}`;
  if (name === "grep") return `Searching for ${String(args.pattern || "")}`;
  if (name === "run_command") return `Running: ${String(args.command || "")}`;
  if (name === "shell_command") return `Running: ${String(args.command || "")}`;
  if (name === "update_plan") return "Updating plan";
  if (name === "list_mcp_resources") return "Listing MCP resources";
  if (name === "list_mcp_resource_templates") return "Listing MCP resource templates";
  if (name === "read_mcp_resource") return `Reading MCP resource: ${String(args.uri || "")}`;
  if (name === "memory_read") return "Reading project memory";
  if (name === "memory_write") return "Updating project memory";
  if (name === "load_skill") return `Loading skill: ${String(args.skill_id || "")}`;
  if (name === "spawn_task") return `Task: ${String(args.description || "Working...")}`;
  if (name.startsWith("mcp__")) return `MCP: ${name}`;
  return name;
}

/* ── Anthropic streaming agentic loop ── */

async function runAnthropicAgent(
  provider: ProviderConfig,
  credential: string,
  input: RunAgentInput
): Promise<AgentResult> {
  const isOAuth = isOAuthCredential(credential);

  let client: Anthropic;
  if (isOAuth) {
    const accessToken = await getValidOAuthToken(credential, "anthropic");
    client = new Anthropic({
      apiKey: "placeholder",
      fetch: async (reqInput: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.delete("x-api-key");
        headers.set("authorization", `Bearer ${accessToken}`);
        headers.set("anthropic-beta", "oauth-2025-04-20,interleaved-thinking-2025-05-14");
        return globalThis.fetch(reqInput, { ...init, headers });
      },
    });
  } else {
    client = new Anthropic({ apiKey: credential });
  }

  const env = getEnvironmentInfo();
  const projectMemory = readProjectMemory(input.projectRoot);
  const systemPrompt = buildSystemPrompt(env, input.projectRoot, input.enabledSkills, input.availableSkills, projectMemory);
  const tools = buildAnthropicTools(env, input.availableSkills, input.mcpTools);

  const maxTokens = input.settings.maxTokens || DEFAULT_MAX_TOKENS;
  const compactedHistory = prepareHistoryForRequest(provider, input.history, systemPrompt, maxTokens);
  const messages: Anthropic.MessageParam[] = toAnthropicMessages(compactedHistory);
  const maxToolSteps = input.settings.maxToolSteps || DEFAULT_MAX_TOOL_STEPS;
  let finalText = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Sub-agent context for spawn_task tool calls
  const subAgentCtx: SubAgentContext = {
    providers: input.providers,
    getCredential: input.getCredential,
    settings: input.settings,
  };

  for (let step = 0; step < maxToolSteps; step += 1) {
    if (input.abortSignal?.aborted) throw new Error("Run cancelled");

    let stepText = "";
    const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let currentToolId = "";
    let currentToolName = "";
    let currentToolInputJson = "";
    let stepInputTokens = 0;
    let stepOutputTokens = 0;

    // Build request params, optionally with extended thinking
    const thinkingLevel = input.settings.thinkingLevel || "none";
    const anthropicThinkingEnabled = thinkingLevel !== "none";
    const anthropicBudgetMap: Record<string, number> = { low: 2048, medium: 8192, high: 16384 };
    const streamParams: Record<string, unknown> = {
      model: provider.model,
      max_tokens: anthropicThinkingEnabled ? maxTokens + (anthropicBudgetMap[thinkingLevel] ?? 0) : maxTokens,
      system: systemPrompt,
      tools,
      messages,
    };
    if (anthropicThinkingEnabled) {
      streamParams.thinking = {
        type: "enabled",
        budget_tokens: anthropicBudgetMap[thinkingLevel] ?? 8192,
      };
    }

    const stream = client.messages.stream(
      streamParams as Parameters<typeof client.messages.stream>[0],
      { signal: input.abortSignal }
    );

    for await (const event of stream) {
      if (input.abortSignal?.aborted) throw new Error("Run cancelled");

      if (event.type === "message_start") {
        const usage = (event as unknown as { message: { usage?: { input_tokens?: number; output_tokens?: number } } }).message?.usage;
        if (usage) {
          stepInputTokens = usage.input_tokens ?? 0;
          stepOutputTokens = usage.output_tokens ?? 0;
        }
      } else if (event.type === "message_delta") {
        const usage = (event as unknown as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        if (usage) {
          if (usage.output_tokens) stepOutputTokens = usage.output_tokens;
        }
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          currentToolId = event.content_block.id;
          currentToolName = event.content_block.name;
          currentToolInputJson = "";
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          stepText += event.delta.text;
          input.callbacks.onChunk(event.delta.text);
        } else if (event.delta.type === "input_json_delta") {
          currentToolInputJson += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        if (currentToolId) {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = currentToolInputJson ? JSON.parse(currentToolInputJson) : {};
          } catch { /* empty */ }
          toolUseBlocks.push({ id: currentToolId, name: currentToolName, input: parsedInput });
          currentToolId = "";
          currentToolName = "";
          currentToolInputJson = "";
        }
      }
    }

    // No tool calls → final answer
    if (toolUseBlocks.length === 0) {
      finalText = stepText;
      totalInputTokens += stepInputTokens;
      totalOutputTokens += stepOutputTokens;
      break;
    }

    totalInputTokens += stepInputTokens;
    totalOutputTokens += stepOutputTokens;

    // Emit intermediate text as a stored message so it appears before tool calls
    if (stepText.trim()) {
      input.callbacks.onText(stepText, { inputTokens: stepInputTokens, outputTokens: stepOutputTokens });
    }

    // Build assistant content blocks for the API conversation
    const assistantContent: Anthropic.ContentBlockParam[] = [];
    if (stepText) {
      assistantContent.push({ type: "text", text: stepText });
    }
    for (const tool of toolUseBlocks) {
      assistantContent.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input });
    }
    messages.push({ role: "assistant", content: assistantContent });

    // Execute tools: emit start (pending card) → execute → emit end (update card with result)
    // spawn_task calls run in parallel; other tools run sequentially
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    const spawnTasks: Array<{ tool: typeof toolUseBlocks[0]; index: number }> = [];
    const sequentialTools: Array<{ tool: typeof toolUseBlocks[0]; index: number }> = [];

    for (let ti = 0; ti < toolUseBlocks.length; ti++) {
      if (toolUseBlocks[ti].name === "spawn_task") {
        spawnTasks.push({ tool: toolUseBlocks[ti], index: ti });
      } else {
        sequentialTools.push({ tool: toolUseBlocks[ti], index: ti });
      }
    }

    // Pre-allocate results array
    const resultsByIndex: Array<{ toolUseId: string; content: string }> = new Array(toolUseBlocks.length);

    // Run sequential tools first
    for (const { tool, index } of sequentialTools) {
      if (input.abortSignal?.aborted) throw new Error("Run cancelled");
      const detail = formatToolDetail(tool.name, tool.input);
      const pendingId = input.callbacks.onToolStart(tool.name, detail, tool.input);
      const t0 = Date.now();
      const result = await executeTool(input.projectRoot, tool.name, tool.input, input.abortSignal, subAgentCtx, pendingId, input.callbacks.onTaskProgress);
      input.callbacks.onToolEnd(pendingId, tool.name, detail, result, Date.now() - t0);
      resultsByIndex[index] = { toolUseId: tool.id, content: result };
    }

    // Run spawn_task calls in parallel (up to maxConcurrentTasks)
    if (spawnTasks.length > 0) {
      const maxConcurrent = input.settings.maxConcurrentTasks || 3;
      const pendingIds: Map<number, string> = new Map();

      // Emit all pending cards first
      for (const { tool, index } of spawnTasks) {
        const detail = formatToolDetail(tool.name, tool.input);
        const pendingId = input.callbacks.onToolStart(tool.name, detail, tool.input);
        pendingIds.set(index, pendingId);
      }

      // Process in batches of maxConcurrent
      for (let batch = 0; batch < spawnTasks.length; batch += maxConcurrent) {
        const batchItems = spawnTasks.slice(batch, batch + maxConcurrent);
        const batchPromises = batchItems.map(async ({ tool, index }) => {
          const t0 = Date.now();
          const pId = pendingIds.get(index)!;
          const result = await executeTool(input.projectRoot, tool.name, tool.input, input.abortSignal, subAgentCtx, pId, input.callbacks.onTaskProgress);
          const detail = formatToolDetail(tool.name, tool.input);
          input.callbacks.onToolEnd(pId, tool.name, detail, result, Date.now() - t0);
          resultsByIndex[index] = { toolUseId: tool.id, content: result };
        });
        await Promise.all(batchPromises);
      }
    }

    // Build final tool results in original order
    for (let ti = 0; ti < toolUseBlocks.length; ti++) {
      toolResults.push({ type: "tool_result", tool_use_id: resultsByIndex[ti].toolUseId, content: resultsByIndex[ti].content });
    }

    messages.push({ role: "user", content: toolResults });

    if (step === maxToolSteps - 1) {
      finalText = stepText || "Reached maximum tool steps. Please continue with a follow-up message.";
    }
  }

  return { text: finalText, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
}

/* ── OpenAI streaming agentic loop ── */

async function runOpenAIAgent(
  provider: ProviderConfig,
  credential: string,
  input: RunAgentInput
): Promise<AgentResult> {
  const isOAuth = isOAuthCredential(credential);

  // OAuth users → Codex Responses API (different endpoint + request format)
  if (isOAuth) {
    return runCodexOAuthAgent(provider, credential, input);
  }

  // API key users → standard Chat Completions API
  const client = new OpenAI({ apiKey: credential });

  const env = getEnvironmentInfo();
  const projectMemory = readProjectMemory(input.projectRoot);
  const systemPrompt = buildSystemPrompt(env, input.projectRoot, input.enabledSkills, input.availableSkills, projectMemory);
  const tools = buildOpenAITools(env, input.availableSkills, input.mcpTools);

  const maxTokens = input.settings.maxTokens || DEFAULT_MAX_TOKENS;
  const compactedHistory = prepareHistoryForRequest(provider, input.history, systemPrompt, maxTokens);
  const messages = toOpenAIMessages(compactedHistory, systemPrompt);
  const maxToolSteps = input.settings.maxToolSteps || DEFAULT_MAX_TOOL_STEPS;
  let finalText = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const subAgentCtx: SubAgentContext = {
    providers: input.providers,
    getCredential: input.getCredential,
    settings: input.settings,
  };

  for (let step = 0; step < maxToolSteps; step += 1) {
    if (input.abortSignal?.aborted) throw new Error("Run cancelled");

    let stepText = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    const toolCallAccumulators = new Map<number, { id: string; name: string; arguments: string }>();
    let stepInputTokens = 0;
    let stepOutputTokens = 0;

    // Build request params, optionally with reasoning effort
    const openaiThinkingLevel = input.settings.thinkingLevel || "none";
    const openaiReasoningMap: Record<string, string> = { low: "low", medium: "medium", high: "high", xhigh: "high" };
    const reasoningEffort = openaiThinkingLevel !== "none" ? openaiReasoningMap[openaiThinkingLevel] : undefined;

    const stream = await client.chat.completions.create(
      {
        model: provider.model,
        max_completion_tokens: maxTokens,
        messages,
        tools,
        stream: true,
        stream_options: { include_usage: true },
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort as "low" | "medium" | "high" } : {}),
      },
      { signal: input.abortSignal }
    );

    for await (const chunk of stream) {
      if (input.abortSignal?.aborted) throw new Error("Run cancelled");
      // Capture usage from the last chunk
      if (chunk.usage) {
        stepInputTokens = chunk.usage.prompt_tokens ?? 0;
        stepOutputTokens = chunk.usage.completion_tokens ?? 0;
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta.content) {
        stepText += delta.content;
        input.callbacks.onChunk(delta.content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallAccumulators.has(tc.index)) {
            toolCallAccumulators.set(tc.index, { id: tc.id || "", name: tc.function?.name || "", arguments: "" });
          }
          const acc = toolCallAccumulators.get(tc.index)!;
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        }
      }
    }

    for (const [, acc] of toolCallAccumulators) {
      if (acc.id && acc.name) toolCalls.push(acc);
    }

    if (toolCalls.length === 0) {
      finalText = stepText;
      totalInputTokens += stepInputTokens;
      totalOutputTokens += stepOutputTokens;
      break;
    }

    totalInputTokens += stepInputTokens;
    totalOutputTokens += stepOutputTokens;

    // Emit intermediate text
    if (stepText.trim()) {
      input.callbacks.onText(stepText, { inputTokens: stepInputTokens, outputTokens: stepOutputTokens });
    }

    const assistantMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
      role: "assistant",
      content: stepText || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id, type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
    messages.push(assistantMsg);

    // Parse all args first
    const parsedToolCalls = toolCalls.map((tc) => {
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { /* empty */ }
      return { ...tc, parsedArgs };
    });

    // Separate spawn_task (parallel) from sequential tools
    const spawnTaskCalls: typeof parsedToolCalls = [];
    const sequentialCalls: typeof parsedToolCalls = [];
    for (const tc of parsedToolCalls) {
      if (tc.name === "spawn_task") spawnTaskCalls.push(tc);
      else sequentialCalls.push(tc);
    }

    // Tool results need to be pushed in original order
    const toolResultsMap = new Map<string, string>();

    // Run sequential tools
    for (const tc of sequentialCalls) {
      if (input.abortSignal?.aborted) throw new Error("Run cancelled");
      const detail = formatToolDetail(tc.name, tc.parsedArgs);
      const pendingId = input.callbacks.onToolStart(tc.name, detail, tc.parsedArgs);
      const t0 = Date.now();
      const result = await executeTool(input.projectRoot, tc.name, tc.parsedArgs, input.abortSignal, subAgentCtx, pendingId, input.callbacks.onTaskProgress);
      input.callbacks.onToolEnd(pendingId, tc.name, detail, result, Date.now() - t0);
      toolResultsMap.set(tc.id, result);
    }

    // Run spawn_task calls in parallel
    if (spawnTaskCalls.length > 0) {
      const maxConcurrent = input.settings.maxConcurrentTasks || 3;
      // Emit pending cards
      const pendingIds = new Map<string, string>();
      for (const tc of spawnTaskCalls) {
        const detail = formatToolDetail(tc.name, tc.parsedArgs);
        const pendingId = input.callbacks.onToolStart(tc.name, detail, tc.parsedArgs);
        pendingIds.set(tc.id, pendingId);
      }
      // Process in batches
      for (let batch = 0; batch < spawnTaskCalls.length; batch += maxConcurrent) {
        const batchItems = spawnTaskCalls.slice(batch, batch + maxConcurrent);
        await Promise.all(batchItems.map(async (tc) => {
          const t0 = Date.now();
          const pId = pendingIds.get(tc.id)!;
          const result = await executeTool(input.projectRoot, tc.name, tc.parsedArgs, input.abortSignal, subAgentCtx, pId, input.callbacks.onTaskProgress);
          const detail = formatToolDetail(tc.name, tc.parsedArgs);
          input.callbacks.onToolEnd(pId, tc.name, detail, result, Date.now() - t0);
          toolResultsMap.set(tc.id, result);
        }));
      }
    }

    // Push tool results in original order
    for (const tc of parsedToolCalls) {
      messages.push({ role: "tool", tool_call_id: tc.id, content: toolResultsMap.get(tc.id) || "" });
    }

    if (step === maxToolSteps - 1) {
      finalText = stepText || "Reached maximum tool steps. Please continue with a follow-up message.";
    }
  }

  return { text: finalText, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
}

export interface AgentResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/* ── Main entry point ── */

export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  return runAgentInner(input);
}

async function runAgentInner(input: RunAgentInput): Promise<AgentResult> {
  const provider = input.providers.find((item) => item.enabled);
  if (!provider) {
    return { text: "No provider enabled. Configure Anthropic or Codex in settings.", inputTokens: 0, outputTokens: 0 };
  }

  const credential = await input.getCredential(provider.id);
  if (!credential) {
    return { text: `${provider.id} is enabled but credential is not configured.`, inputTokens: 0, outputTokens: 0 };
  }

  if (provider.id === "anthropic") {
    return runAnthropicAgent(provider, credential, input);
  }

  return runOpenAIAgent(provider, credential, input);
}
