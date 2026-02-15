export type ProviderId = "anthropic" | "codex";
export type AuthMode = "apiKey" | "subscriptionToken";

export interface ProviderConfig {
  id: ProviderId;
  enabled: boolean;
  authMode: AuthMode;
  model: string;
  credentialSet: boolean;
}

export interface Project {
  id: string;
  name: string;
  folderPath: string;
  createdAt: string;
  updatedAt: string;
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface ImageAttachment {
  /** Base64-encoded image data (no data: prefix) */
  data: string;
  mediaType: ImageMediaType;
  /** Original file name if available */
  name?: string;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  /** Image attachments (user messages only) */
  images?: ImageAttachment[];
  metadata?: {
    toolName?: string;
    toolDetail?: string;
    isError?: boolean;
    pending?: boolean;
    /** Task-specific fields (when toolName === "spawn_task") */
    isTask?: boolean;
    taskType?: SubAgentType;
    taskDescription?: string;
    taskDurationMs?: number;
    /** Token usage for assistant messages */
    inputTokens?: number;
    outputTokens?: number;
    /** Sub-agent trail entries (for running tasks) */
    taskTrail?: SubAgentTrailEntry[];
    /** Sub-agent unique task ID for sidebar detail view */
    taskId?: string;
  };
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type SubAgentType = "general" | "explore";

export type ThemeMode = "dark" | "light";

/**
 * Thinking / reasoning effort level.
 * - Anthropic extended thinking supports: none, low, medium, high
 * - OpenAI/Codex reasoning effort supports: none, low, medium, high, xhigh
 */
export type ThinkingLevel = "none" | "low" | "medium" | "high" | "xhigh";

export interface AgentSettings {
  maxTokens: number;
  maxToolSteps: number;
  /** Model ID for sub-agents (empty string = use same model as parent) */
  subAgentModel: string;
  /** Max tokens per sub-agent response */
  subAgentMaxTokens: number;
  /** Max tool steps per sub-agent run */
  subAgentMaxToolSteps: number;
  /** Max concurrent sub-agent tasks (reserved for future parallel execution) */
  maxConcurrentTasks: number;
  /** UI theme */
  theme: ThemeMode;
  /** Thinking / reasoning effort level */
  thinkingLevel: ThinkingLevel;
}

export interface AppState {
  projects: Project[];
  threads: Thread[];
  messages: ThreadMessage[];
  providers: ProviderConfig[];
  settings: AgentSettings;
  /** Per-project skill enablement */
  projectSkills: ProjectSkillConfig[];
}

export interface NewProjectInput {
  name: string;
  folderPath: string;
}

export interface NewThreadInput {
  projectId: string;
  title: string;
}

export interface SendMessageInput {
  threadId: string;
  content: string;
  images?: ImageAttachment[];
}

export interface ProviderUpdateInput {
  id: ProviderId;
  enabled?: boolean;
  authMode?: AuthMode;
  model?: string;
}

export interface ProviderCredentialInput {
  id: ProviderId;
  credential: string;
}

export interface AgentStatusEvent {
  threadId: string;
  status: "idle" | "running" | "error" | "cancelled";
  detail: string;
}

export interface AgentChunkEvent {
  threadId: string;
  chunk: string;
}

export interface AgentToolEvent {
  threadId: string;
  name: string;
  detail: string;
}

export interface AgentMessageEvent {
  threadId: string;
  message: ThreadMessage;
}

export interface AgentEventMap {
  "agent:status": AgentStatusEvent;
  "agent:chunk": AgentChunkEvent;
  "agent:tool": AgentToolEvent;
  "agent:message": AgentMessageEvent;
}

export interface GitStatusInfo {
  changes: number;
  staged: number;
  /** Whether the project folder is a git repository */
  isRepo: boolean;
}

export interface GitDiffEntry {
  file: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  diff: string;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface SubAgentDetail {
  taskId: string;
  description: string;
  taskType: SubAgentType;
  status: "running" | "completed" | "error";
  startedAt: string;
  completedAt?: string;
  /** Trail of last actions (tool calls, text snippets) */
  trail: SubAgentTrailEntry[];
  result?: string;
}

export interface SubAgentTrailEntry {
  type: "tool" | "text";
  /** Tool name or short text snippet */
  summary: string;
  timestamp: string;
}

/* ── Skills ── */

export type SkillSource = "sncode" | "claude-code" | "project";

export interface Skill {
  /** Unique ID derived from source + directory name (e.g. "sncode:my-skill") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short description of what the skill does */
  description: string;
  /** Where this skill was discovered */
  source: SkillSource;
  /** Absolute path to the SKILL.md file */
  filePath: string;
  /** Absolute path to the skill directory */
  dirPath: string;
}

export interface ProjectSkillConfig {
  projectId: string;
  /** Skill IDs that are enabled for this project */
  enabledSkillIds: string[];
}

export interface SkillContent {
  skill: Skill;
  /** Full markdown content of SKILL.md */
  content: string;
}

export interface FileTreeEntry {
  name: string;
  type: "file" | "dir";
  children?: FileTreeEntry[];
}

export interface SncodeApi {
  getState: () => Promise<AppState>;
  pickFolder: () => Promise<string | null>;
  createProject: (payload: NewProjectInput) => Promise<Project>;
  createThread: (payload: NewThreadInput) => Promise<Thread>;
  deleteThread: (threadId: string) => Promise<AppState>;
  updateProvider: (payload: ProviderUpdateInput) => Promise<ProviderConfig[]>;
  setProviderCredential: (payload: ProviderCredentialInput) => Promise<ProviderConfig[]>;
  sendMessage: (payload: SendMessageInput) => Promise<AppState>;
  cancelRun: (threadId: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  getGitBranches: (projectPath: string) => Promise<{ current: string; branches: string[] }>;
  getGitStatus: (projectPath: string) => Promise<GitStatusInfo>;
  getFileTree: (projectPath: string, depth?: number) => Promise<FileTreeEntry[]>;
  updateSettings: (settings: Partial<AgentSettings>) => Promise<AgentSettings>;
  oauthAnthropicStart: () => Promise<{ url: string }>;
  oauthAnthropicExchange: (code: string) => Promise<{ success: boolean; expires: number }>;
  oauthCodexStart: () => Promise<{ url: string; userCode: string; deviceAuthId: string; interval: number }>;
  oauthCodexPoll: (payload: { deviceAuthId: string; userCode: string }) => Promise<{ success: boolean; expires: number }>;
  /** Discover all available skills from all sources */
  discoverSkills: (projectPath?: string) => Promise<Skill[]>;
  /** Load the full content of a skill by ID */
  loadSkillContent: (skillId: string, projectPath?: string) => Promise<SkillContent | null>;
  /** Enable a skill for a project */
  enableSkill: (projectId: string, skillId: string) => Promise<ProjectSkillConfig>;
  /** Disable a skill for a project */
  disableSkill: (projectId: string, skillId: string) => Promise<ProjectSkillConfig>;
  /** Get enabled skill IDs for a project */
  getProjectSkills: (projectId: string) => Promise<ProjectSkillConfig>;
  /** Install a skill from a directory path into SnCode's skills dir */
  installSkill: (sourcePath: string) => Promise<Skill | null>;
  /** Delete a skill from SnCode's skills dir */
  deleteSkill: (skillId: string) => Promise<boolean>;
  /** Read a file's content for preview */
  readFileContent: (projectPath: string, relativePath: string) => Promise<string>;
  /** Get git diff for the project (all changed files with diffs) */
  getGitDiff: (projectPath: string) => Promise<GitDiffEntry[]>;
  /** Run a git action (commit, pull, push, init, etc.) */
  gitAction: (projectPath: string, action: string, args?: Record<string, string>) => Promise<{ success: boolean; message: string }>;
  on: <T extends keyof AgentEventMap>(
    channel: T,
    listener: (payload: AgentEventMap[T]) => void
  ) => () => void;
}
