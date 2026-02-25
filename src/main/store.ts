import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { nanoid } from "nanoid";
import { AgentSettings, AppState, ImageAttachment, NewProjectInput, NewThreadInput, Project, ProjectSkillConfig, ProviderConfig, Thread, ThreadMessage, ThreadMessageSummary } from "../shared/types";
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_CODEX_MODEL } from "../shared/models";

const now = () => new Date().toISOString();

const DEFAULT_SETTINGS: AgentSettings = {
  maxTokens: 16384,
  maxToolSteps: 25,
  maxMessagesPerThread: 400,
  subAgentModel: "",
  subAgentMaxTokens: 8192,
  subAgentMaxToolSteps: 15,
  maxConcurrentTasks: 3,
  theme: "dark",
  thinkingLevel: "none",
  onboardingComplete: false,
};

const defaultProviders: ProviderConfig[] = [
  {
    id: "anthropic",
    enabled: true,
    authMode: "apiKey",
    model: DEFAULT_ANTHROPIC_MODEL,
    credentialSet: false
  },
  {
    id: "codex",
    enabled: false,
    authMode: "apiKey",
    model: DEFAULT_CODEX_MODEL,
    credentialSet: false
  }
];

const defaultState: AppState = {
  projects: [],
  threads: [],
  messages: [],
  providers: defaultProviders,
  settings: DEFAULT_SETTINGS,
  projectSkills: [],
};

const dataPath = () => path.join(app.getPath("userData"), "sncode-state.json");

interface LegacyState {
  projects?: Project[];
  threads?: Array<Thread & { messages?: ThreadMessage[] }>;
  providers?: Array<ProviderConfig & { credential?: string }>;
}

export class Store {
  private state: AppState = structuredClone(defaultState);
  private persistTimer: NodeJS.Timeout | null = null;
  private persistPending = false;
  private readonly persistDelayMs = 150;
  private threadMessageMetaById = new Map<string, ThreadMessageSummary>();

  load(): AppState {
    const target = dataPath();
    if (!fs.existsSync(target)) {
      this.state = structuredClone(defaultState);
      this.threadMessageMetaById = new Map();
      return this.getState();
    }

    let parsed: (Partial<AppState> & LegacyState) | null = null;
    try {
      const raw = fs.readFileSync(target, "utf8");
      parsed = JSON.parse(raw) as Partial<AppState> & LegacyState;
    } catch {
      // Recover from corrupted state by resetting to defaults.
      this.state = structuredClone(defaultState);
      this.threadMessageMetaById = new Map();
      this.persistImmediate();
      return this.getState();
    }
    if (!parsed) {
      this.state = structuredClone(defaultState);
      this.threadMessageMetaById = new Map();
      return this.getState();
    }
    const legacyThreads = (parsed as LegacyState).threads ?? [];
    const legacyProviders = (parsed as LegacyState).providers ?? [];

    const messages: ThreadMessage[] = parsed.messages
      ? parsed.messages
      : legacyThreads.flatMap((thread) =>
          (thread.messages ?? []).map((message: ThreadMessage) => ({
            ...message,
            threadId: message.threadId || thread.id
          }))
        );

    this.state = {
      projects: parsed.projects ?? [],
      threads: legacyThreads.map((thread) => ({
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        codexThreadId: (thread as Thread).codexThreadId,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt
      })),
      messages,
      providers:
        legacyProviders.map((provider) => ({
          id: provider.id,
          enabled: provider.enabled,
          authMode: provider.authMode,
          model: provider.model,
          credentialSet: provider.credentialSet ?? Boolean((provider as { credential?: string }).credential)
        })) || structuredClone(defaultProviders),
      settings: {
        ...DEFAULT_SETTINGS,
        ...(parsed.settings ?? {})
      },
      projectSkills: parsed.projectSkills ?? [],
    };

    if (this.state.providers.length === 0) {
      this.state.providers = structuredClone(defaultProviders);
    }
    const wasTrimmed = this.enforceMessageCapForAllThreads();
    if (wasTrimmed) this.persistImmediate();
    this.rebuildThreadMessageMeta();

    return this.getState();
  }

  private rebuildThreadMessageMeta() {
    const meta = new Map<string, ThreadMessageSummary>();
    for (const msg of this.state.messages) {
      const prev = meta.get(msg.threadId);
      if (!prev) {
        meta.set(msg.threadId, {
          threadId: msg.threadId,
          count: 1,
          lastCreatedAt: msg.createdAt,
        });
        continue;
      }
      prev.count += 1;
      if (!prev.lastCreatedAt || msg.createdAt >= prev.lastCreatedAt) {
        prev.lastCreatedAt = msg.createdAt;
      }
    }
    this.threadMessageMetaById = meta;
  }

  private rebuildThreadMessageMetaForThread(threadId: string) {
    let count = 0;
    let lastCreatedAt: string | undefined;
    for (const msg of this.state.messages) {
      if (msg.threadId !== threadId) continue;
      count += 1;
      if (!lastCreatedAt || msg.createdAt >= lastCreatedAt) {
        lastCreatedAt = msg.createdAt;
      }
    }
    if (count === 0) {
      this.threadMessageMetaById.delete(threadId);
      return;
    }
    this.threadMessageMetaById.set(threadId, { threadId, count, lastCreatedAt });
  }

  private persistImmediate() {
    const target = dataPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(this.state, null, 2), "utf8");
  }

  private persist() {
    this.persistPending = true;
    if (this.persistTimer) return;

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.persistPending) return;
      this.persistPending = false;
      this.persistImmediate();
    }, this.persistDelayMs);

    if (typeof this.persistTimer.unref === "function") {
      this.persistTimer.unref();
    }
  }

  private enforceMessageCapForThread(threadId: string): boolean {
    const cap = this.state.settings.maxMessagesPerThread;
    if (!Number.isFinite(cap) || cap < 1) return false;

    let threadCount = 0;
    for (const msg of this.state.messages) {
      if (msg.threadId === threadId) threadCount += 1;
    }

    let toRemove = threadCount - cap;
    if (toRemove <= 0) return false;

    const next: ThreadMessage[] = [];
    for (const msg of this.state.messages) {
      if (msg.threadId === threadId && toRemove > 0) {
        toRemove -= 1;
        continue;
      }
      next.push(msg);
    }
    this.state.messages = next;
    return true;
  }

  private enforceMessageCapForAllThreads(): boolean {
    const cap = this.state.settings.maxMessagesPerThread;
    if (!Number.isFinite(cap) || cap < 1) return false;

    const counts = new Map<string, number>();
    for (const msg of this.state.messages) {
      counts.set(msg.threadId, (counts.get(msg.threadId) ?? 0) + 1);
    }

    const removeByThread = new Map<string, number>();
    for (const [threadId, count] of counts) {
      if (count > cap) removeByThread.set(threadId, count - cap);
    }
    if (removeByThread.size === 0) return false;

    const next: ThreadMessage[] = [];
    for (const msg of this.state.messages) {
      const remaining = removeByThread.get(msg.threadId) ?? 0;
      if (remaining > 0) {
        removeByThread.set(msg.threadId, remaining - 1);
        continue;
      }
      next.push(msg);
    }
    this.state.messages = next;
    return true;
  }

  flushPersist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.persistPending) return;
    this.persistPending = false;
    this.persistImmediate();
  }

  getState(): AppState {
    return structuredClone(this.state);
  }

  getSettings(): AgentSettings {
    return structuredClone(this.state.settings);
  }

  /** Wipe all data and reset to factory defaults */
  resetAll(): AppState {
    this.state = structuredClone(defaultState);
    this.threadMessageMetaById = new Map();
    this.persistImmediate();
    return this.getState();
  }

  updateSettings(updates: Partial<AgentSettings>): AgentSettings {
    this.state.settings = { ...this.state.settings, ...updates };
    if (updates.maxMessagesPerThread !== undefined) {
      const trimmed = this.enforceMessageCapForAllThreads();
      if (trimmed) this.rebuildThreadMessageMeta();
    }
    this.persist();
    return this.getSettings();
  }

  createProject(input: NewProjectInput): Project {
    const entry: Project = {
      id: nanoid(),
      name: input.name,
      folderPath: input.folderPath,
      createdAt: now(),
      updatedAt: now()
    };

    this.state.projects.unshift(entry);
    this.persist();
    return entry;
  }

  createThread(input: NewThreadInput): Thread {
    const thread: Thread = {
      id: nanoid(),
      projectId: input.projectId,
      title: input.title,
      codexThreadId: undefined,
      createdAt: now(),
      updatedAt: now()
    };

    this.state.threads.unshift(thread);
    this.persist();
    return thread;
  }

  deleteThread(threadId: string): void {
    this.state.threads = this.state.threads.filter((t) => t.id !== threadId);
    this.state.messages = this.state.messages.filter((m) => m.threadId !== threadId);
    this.threadMessageMetaById.delete(threadId);
    this.persist();
  }

  updateThread(threadId: string, updates: Partial<Pick<Thread, "title" | "codexThreadId">>): Thread | undefined {
    const thread = this.state.threads.find((t) => t.id === threadId);
    if (!thread) return undefined;
    if (updates.title !== undefined) thread.title = updates.title;
    if (updates.codexThreadId !== undefined) thread.codexThreadId = updates.codexThreadId;
    thread.updatedAt = now();
    this.persist();
    return structuredClone(thread);
  }

  getThread(threadId: string): Thread | undefined {
    return this.state.threads.find((item) => item.id === threadId);
  }

  getMessages(threadId: string): ThreadMessage[] {
    return this.state.messages.filter((message) => message.threadId === threadId);
  }

  getThreadMessageMeta(): ThreadMessageSummary[] {
    return Array.from(this.threadMessageMetaById.values()).map((entry) => ({ ...entry }));
  }

  getMessageById(messageId: string): ThreadMessage | undefined {
    const msg = this.state.messages.find((m) => m.id === messageId);
    return msg ? structuredClone(msg) : undefined;
  }

  appendMessage(
    threadId: string,
    role: ThreadMessage["role"],
    content: string,
    metadata?: ThreadMessage["metadata"],
    images?: ImageAttachment[]
  ): ThreadMessage {
    if (!this.state.threads.some((item) => item.id === threadId)) {
      throw new Error("Thread not found");
    }

    const msg: ThreadMessage = {
      id: nanoid(),
      threadId,
      role,
      content,
      createdAt: now(),
      metadata
    };
    if (images && images.length > 0) msg.images = images;

    this.state.messages.push(msg);

    const thread = this.state.threads.find((item) => item.id === threadId);
    if (thread) {
      thread.updatedAt = now();
    }
    const trimmed = this.enforceMessageCapForThread(threadId);
    if (trimmed) this.rebuildThreadMessageMetaForThread(threadId);
    else {
      const prev = this.threadMessageMetaById.get(threadId);
      if (prev) {
        prev.count += 1;
        prev.lastCreatedAt = msg.createdAt;
      } else {
        this.threadMessageMetaById.set(threadId, { threadId, count: 1, lastCreatedAt: msg.createdAt });
      }
    }
    this.persist();
    return structuredClone(msg);
  }

  updateMessage(messageId: string, updates: { content?: string; metadata?: ThreadMessage["metadata"] }): ThreadMessage | undefined {
    const msg = this.state.messages.find((m) => m.id === messageId);
    if (!msg) return undefined;
    if (updates.content !== undefined) msg.content = updates.content;
    if (updates.metadata !== undefined) msg.metadata = { ...msg.metadata, ...updates.metadata };
    this.persist();
    return structuredClone(msg);
  }

  updateProvider(
    providerId: ProviderConfig["id"],
    updates: Partial<Pick<ProviderConfig, "enabled" | "authMode" | "model" | "credentialSet">>
  ) {
    const provider = this.state.providers.find((item) => item.id === providerId);
    if (!provider) {
      throw new Error("Provider not found");
    }
    Object.assign(provider, updates);
    this.persist();
    return this.getState().providers;
  }

  updateProviders(
    batch: Array<{ id: ProviderConfig["id"]; updates: Partial<Pick<ProviderConfig, "enabled" | "authMode" | "model">> }>
  ) {
    for (const entry of batch) {
      const provider = this.state.providers.find((item) => item.id === entry.id);
      if (!provider) throw new Error(`Provider not found: ${entry.id}`);
      Object.assign(provider, entry.updates);
    }
    this.persist();
    return this.getState().providers;
  }

  /* ── Skills ── */

  getProjectSkills(projectId: string): ProjectSkillConfig {
    const existing = this.state.projectSkills.find((ps) => ps.projectId === projectId);
    return existing ? structuredClone(existing) : { projectId, enabledSkillIds: [] };
  }

  enableSkill(projectId: string, skillId: string): ProjectSkillConfig {
    let config = this.state.projectSkills.find((ps) => ps.projectId === projectId);
    if (!config) {
      config = { projectId, enabledSkillIds: [] };
      this.state.projectSkills.push(config);
    }
    if (!config.enabledSkillIds.includes(skillId)) {
      config.enabledSkillIds.push(skillId);
    }
    this.persist();
    return structuredClone(config);
  }

  disableSkill(projectId: string, skillId: string): ProjectSkillConfig {
    let config = this.state.projectSkills.find((ps) => ps.projectId === projectId);
    if (!config) {
      return { projectId, enabledSkillIds: [] };
    }
    config.enabledSkillIds = config.enabledSkillIds.filter((id) => id !== skillId);
    this.persist();
    return structuredClone(config);
  }

}
