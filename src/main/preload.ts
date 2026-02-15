import { contextBridge, ipcRenderer } from "electron";
import { AgentEventMap, AgentSettings, FileTreeEntry, GitDiffEntry, NewProjectInput, NewThreadInput, ProviderCredentialInput, ProviderUpdateInput, Skill, SkillContent, ProjectSkillConfig, SendMessageInput, SncodeApi } from "../shared/types";

const api: SncodeApi = {
  getState: () => ipcRenderer.invoke("state:get"),
  pickFolder: () => ipcRenderer.invoke("folder:pick"),
  createProject: (payload: NewProjectInput) => ipcRenderer.invoke("project:create", payload),
  createThread: (payload: NewThreadInput) => ipcRenderer.invoke("thread:create", payload),
  deleteThread: (threadId: string) => ipcRenderer.invoke("thread:delete", threadId),
  updateProvider: (payload: ProviderUpdateInput) => ipcRenderer.invoke("provider:update", payload),
  setProviderCredential: (payload: ProviderCredentialInput) =>
    ipcRenderer.invoke("provider:credential:set", payload),
  sendMessage: (payload: SendMessageInput) => ipcRenderer.invoke("message:send", payload),
  cancelRun: (threadId: string) => ipcRenderer.invoke("run:cancel", threadId),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  getGitBranches: (projectPath: string) => ipcRenderer.invoke("git:branches", projectPath),
  getGitStatus: (projectPath: string) => ipcRenderer.invoke("git:status", projectPath),
  getFileTree: (projectPath: string, depth?: number): Promise<FileTreeEntry[]> => ipcRenderer.invoke("filetree:get", projectPath, depth),
  updateSettings: (settings: Partial<AgentSettings>) => ipcRenderer.invoke("settings:update", settings),
  oauthAnthropicStart: () => ipcRenderer.invoke("oauth:anthropic:start"),
  oauthAnthropicExchange: (code: string) => ipcRenderer.invoke("oauth:anthropic:exchange", code),
  oauthCodexStart: () => ipcRenderer.invoke("oauth:codex:start"),
  oauthCodexPoll: (payload: { deviceAuthId: string; userCode: string }) => ipcRenderer.invoke("oauth:codex:poll", payload),
  discoverSkills: (projectPath?: string): Promise<Skill[]> => ipcRenderer.invoke("skills:discover", projectPath),
  loadSkillContent: (skillId: string, projectPath?: string): Promise<SkillContent | null> => ipcRenderer.invoke("skills:load-content", skillId, projectPath),
  enableSkill: (projectId: string, skillId: string): Promise<ProjectSkillConfig> => ipcRenderer.invoke("skills:enable", projectId, skillId),
  disableSkill: (projectId: string, skillId: string): Promise<ProjectSkillConfig> => ipcRenderer.invoke("skills:disable", projectId, skillId),
  getProjectSkills: (projectId: string): Promise<ProjectSkillConfig> => ipcRenderer.invoke("skills:project-config", projectId),
  installSkill: (sourcePath: string): Promise<Skill | null> => ipcRenderer.invoke("skills:install", sourcePath),
  deleteSkill: (skillId: string): Promise<boolean> => ipcRenderer.invoke("skills:delete", skillId),
  readFileContent: (projectPath: string, relativePath: string): Promise<string> => ipcRenderer.invoke("file:read", projectPath, relativePath),
  getGitDiff: (projectPath: string): Promise<GitDiffEntry[]> => ipcRenderer.invoke("git:diff", projectPath),
  gitAction: (projectPath: string, action: string, args?: Record<string, string>): Promise<{ success: boolean; message: string }> => ipcRenderer.invoke("git:action", projectPath, action, args),
  on: <T extends keyof AgentEventMap>(channel: T, listener: (payload: AgentEventMap[T]) => void) => {
    const wrapped = (_event: unknown, payload: AgentEventMap[T]) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
};

contextBridge.exposeInMainWorld("sncode", api);
