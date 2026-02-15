import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { nanoid } from "nanoid";
import { AgentSettings, AppState, ImageAttachment, NewProjectInput, NewThreadInput, Project, ProjectSkillConfig, ProviderConfig, Thread, ThreadMessage } from "../shared/types";
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_CODEX_MODEL } from "../shared/models";

const now = () => new Date().toISOString();

const DEFAULT_SETTINGS: AgentSettings = {
  maxTokens: 16384,
  maxToolSteps: 25,
  subAgentModel: "",
  subAgentMaxTokens: 8192,
  subAgentMaxToolSteps: 15,
  maxConcurrentTasks: 3,
  theme: "dark",
  thinkingLevel: "none",
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
  projectSkills: []
};

const dataPath = () => path.join(app.getPath("userData"), "sncode-state.json");

interface LegacyState {
  projects?: Project[];
  threads?: Array<Thread & { messages?: ThreadMessage[] }>;
  providers?: Array<ProviderConfig & { credential?: string }>;
}

export class Store {
  private state: AppState = structuredClone(defaultState);

  load(): AppState {
    const target = dataPath();
    if (!fs.existsSync(target)) {
      this.state = structuredClone(defaultState);
      return this.getState();
    }

    const raw = fs.readFileSync(target, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppState> & LegacyState;
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
      projectSkills: parsed.projectSkills ?? []
    };

    if (this.state.providers.length === 0) {
      this.state.providers = structuredClone(defaultProviders);
    }

    return this.getState();
  }

  private persist() {
    const target = dataPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(this.state, null, 2), "utf8");
  }

  getState(): AppState {
    return structuredClone(this.state);
  }

  getSettings(): AgentSettings {
    return structuredClone(this.state.settings);
  }

  updateSettings(updates: Partial<AgentSettings>): AgentSettings {
    this.state.settings = { ...this.state.settings, ...updates };
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
    this.persist();
  }

  updateThread(threadId: string, updates: Partial<Pick<Thread, "title">>): Thread | undefined {
    const thread = this.state.threads.find((t) => t.id === threadId);
    if (!thread) return undefined;
    if (updates.title !== undefined) thread.title = updates.title;
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

  appendMessage(
    threadId: string,
    role: ThreadMessage["role"],
    content: string,
    metadata?: ThreadMessage["metadata"],
    images?: ImageAttachment[]
  ) {
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
    this.persist();
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
