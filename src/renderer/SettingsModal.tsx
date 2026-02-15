import { useCallback, useEffect, useState } from "react";
import { AgentSettings, ProviderConfig, AuthMode, Skill, ProjectSkillConfig } from "../shared/types";
import { ALL_MODELS, API_KEY_URLS } from "../shared/models";

/* ── helpers ── */

function providerName(id: string) {
  return id === "anthropic" ? "Anthropic" : "OpenAI / Codex";
}

function providerDescription(id: string) {
  return id === "anthropic"
    ? "Claude models via Anthropic API"
    : "Codex models via OpenAI API";
}

function sourceLabel(source: string) {
  if (source === "sncode") return "SnCode";
  if (source === "claude-code") return "Claude Code";
  if (source === "project") return "Project";
  return source;
}

function sourceBadgeColor(source: string) {
  if (source === "sncode") return "text-blue-400 border-blue-400/30";
  if (source === "claude-code") return "text-purple-400 border-purple-400/30";
  return "text-amber-400 border-amber-400/30";
}

/* ── types ── */

interface Props {
  providers: ProviderConfig[];
  settings: AgentSettings;
  projectId: string | null;
  projectPath: string | null;
  onClose: () => void;
  onUpdateProvider: (
    provider: ProviderConfig,
    updates: Partial<ProviderConfig>
  ) => Promise<void>;
  onSaveCredential: (providerId: string, credential: string) => Promise<void>;
  onUpdateSettings: (updates: Partial<AgentSettings>) => Promise<void>;
  onClearAllData: () => Promise<void>;
}

type Tab = "general" | "providers" | "agent" | "tasks" | "skills" | "data";

/* ── icons ── */

function IconGeneral() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  );
}

function IconProviders() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 3h-8l-2 4h12z"/>
    </svg>
  );
}

function IconAgent() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/>
      <line x1="9" y1="21" x2="15" y2="21"/>
    </svg>
  );
}

function IconTasks() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
  );
}

function IconSkills() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  );
}

function IconData() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
    </svg>
  );
}

/* ── Shared slider component ── */

function SettingSlider({ label, description, value, min, max, step, display, onChange }: {
  label: string; description: string; value: number;
  min: number; max: number; step: number; display?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="rounded-lg border border-[#1e1e1e] bg-[#161616] p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[13px] font-medium text-[#d0d0d0]">{label}</div>
          <div className="mt-0.5 text-[11px] text-[#505050]">{description}</div>
        </div>
        <span className="ml-3 shrink-0 rounded bg-[#1e1e1e] px-2 py-0.5 font-mono text-[12px] text-[#808080]">
          {display ?? value.toLocaleString()}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step}
        value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="mt-3 w-full accent-[#e0e0e0]"
      />
      <div className="mt-1 flex justify-between text-[10px] text-[#383838]">
        <span>{min.toLocaleString()}</span><span>{max.toLocaleString()}</span>
      </div>
    </div>
  );
}

/* ── component ── */

export default function SettingsModal({
  providers,
  settings,
  projectId,
  projectPath,
  onClose,
  onUpdateProvider,
  onSaveCredential,
  onUpdateSettings,
  onClearAllData,
}: Props) {
  const [tab, setTab] = useState<Tab>("general");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [oauthStep, setOauthStep] = useState<Record<string, "idle" | "waiting_code" | "waiting_device" | "exchanging">>({});
  const [codexDevice, setCodexDevice] = useState<{ userCode: string; deviceAuthId: string } | null>(null);

  // Local settings drafts
  const [maxTokens, setMaxTokens] = useState(settings.maxTokens);
  const [maxToolSteps, setMaxToolSteps] = useState(settings.maxToolSteps);
  const [subAgentModel, setSubAgentModel] = useState(settings.subAgentModel);
  const [subAgentMaxTokens, setSubAgentMaxTokens] = useState(settings.subAgentMaxTokens);
  const [subAgentMaxToolSteps, setSubAgentMaxToolSteps] = useState(settings.subAgentMaxToolSteps);
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(settings.maxConcurrentTasks);
  const [themeMode, setThemeMode] = useState(settings.theme || "dark");
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Skills state
  const [availableSkills, setAvailableSkills] = useState<Skill[]>([]);
  const [projectSkillConfig, setProjectSkillConfig] = useState<ProjectSkillConfig>({ projectId: "", enabledSkillIds: [] });
  const [skillsLoading, setSkillsLoading] = useState(false);

  const refreshSkills = useCallback(async () => {
    if (!projectId) return;
    setSkillsLoading(true);
    try {
      const [skills, config] = await Promise.all([
        window.sncode.discoverSkills(projectPath ?? undefined),
        window.sncode.getProjectSkills(projectId),
      ]);
      setAvailableSkills(skills);
      setProjectSkillConfig(config);
    } finally {
      setSkillsLoading(false);
    }
  }, [projectId, projectPath]);

  useEffect(() => {
    if (tab === "skills") void refreshSkills();
  }, [tab, refreshSkills]);

  async function toggleSkill(skillId: string, enabled: boolean) {
    if (!projectId) return;
    const config = enabled
      ? await window.sncode.enableSkill(projectId, skillId)
      : await window.sncode.disableSkill(projectId, skillId);
    setProjectSkillConfig(config);
  }

  async function handleDeleteSkill(skillId: string) {
    const deleted = await window.sncode.deleteSkill(skillId);
    if (deleted) void refreshSkills();
  }

  async function handleInstallSkill() {
    const folder = await window.sncode.pickFolder();
    if (!folder) return;
    const skill = await window.sncode.installSkill(folder);
    if (skill) {
      flash("skills", `Installed "${skill.name}"`);
      void refreshSkills();
    } else {
      flash("skills", "Invalid skill directory (no SKILL.md found)");
    }
  }

  function flash(id: string, msg: string) {
    setFeedback((p) => ({ ...p, [id]: msg }));
    setTimeout(() => setFeedback((p) => ({ ...p, [id]: "" })), 2200);
  }

  async function handleSave(provider: ProviderConfig) {
    const val = drafts[provider.id]?.trim();
    if (!val) return;
    await onSaveCredential(provider.id, val);
    setDrafts((p) => ({ ...p, [provider.id]: "" }));
    flash(provider.id, "Saved to keychain");
  }

  async function handleSaveSettings() {
    await onUpdateSettings({ maxTokens, maxToolSteps, subAgentModel, subAgentMaxTokens, subAgentMaxToolSteps, maxConcurrentTasks, theme: themeMode });
    flash("settings", "Settings saved");
  }

  async function handleSaveTaskSettings() {
    await onUpdateSettings({ subAgentModel, subAgentMaxTokens, subAgentMaxToolSteps, maxConcurrentTasks });
    flash("tasks", "Task settings saved");
  }

  const tabs: { id: Tab; label: string; icon: () => React.JSX.Element; danger?: boolean }[] = [
    { id: "general", label: "General", icon: IconGeneral },
    { id: "providers", label: "Providers", icon: IconProviders },
    { id: "agent", label: "Agent", icon: IconAgent },
    { id: "tasks", label: "Tasks", icon: IconTasks },
    { id: "skills", label: "Skills", icon: IconSkills },
    { id: "data", label: "Data", icon: IconData, danger: true },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-[560px] w-full max-w-[680px] overflow-hidden rounded-xl border border-[#252525] bg-[#141414] shadow-2xl shadow-black/60">

        {/* ── Sidebar ── */}
        <div className="flex w-[180px] shrink-0 flex-col border-r border-[#1e1e1e] bg-[#131313]">
          {/* Header */}
          <div className="flex h-12 shrink-0 items-center px-4">
            <span className="text-[13px] font-semibold text-[#e0e0e0]">Settings</span>
          </div>

          {/* Nav */}
          <nav className="flex-1 space-y-0.5 px-2 pb-4">
            {tabs.map((t) => {
              const active = tab === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-[7px] text-left text-[12px] transition ${
                    active
                      ? "bg-[#1e1e1e] text-[#e0e0e0] font-medium"
                      : t.danger
                        ? "text-[#555] hover:bg-[#1a1a1a] hover:text-red-400/80"
                        : "text-[#555] hover:bg-[#1a1a1a] hover:text-[#999]"
                  }`}
                >
                  <span className={active ? "text-[#999]" : ""}><Icon /></span>
                  {t.label}
                </button>
              );
            })}
          </nav>

          {/* Version */}
          <div className="border-t border-[#1e1e1e] px-4 py-3">
            <div className="text-[10px] text-[#333]">
              <span className="font-medium text-[#444]">Sn</span><span className="text-[#333]">Code</span> v0.1.0
            </div>
          </div>
        </div>

        {/* ── Content ── */}
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Content header + close */}
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-[#1e1e1e] px-5">
            <span className="text-[13px] font-medium text-[#b0b0b0]">
              {tabs.find((t) => t.id === tab)?.label}
            </span>
            <button
              onClick={onClose}
              className="grid h-6 w-6 place-items-center rounded-md text-[#444] transition hover:bg-[#1e1e1e] hover:text-[#999]"
            >
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path d="M1.5 1.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            </button>
          </div>

          {/* Scrollable body */}
          <div className="min-h-0 flex-1 overflow-auto p-5">

            {/* ══════════ General ══════════ */}
            {tab === "general" && (
              <div className="space-y-5">
                {/* Theme */}
                <div>
                  <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-[#444]">Appearance</div>
                  <div className="rounded-lg border border-[#1e1e1e] bg-[#161616] p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[13px] font-medium text-[#d0d0d0]">Theme</div>
                        <div className="mt-0.5 text-[11px] text-[#505050]">Switch between dark and light mode</div>
                      </div>
                      <div className="flex rounded-lg bg-[#111] p-0.5">
                        <button
                          onClick={() => { setThemeMode("dark"); void onUpdateSettings({ theme: "dark" }); }}
                          className={`rounded-md px-3 py-1.5 text-[11px] font-medium transition ${themeMode === "dark" ? "bg-[#252525] text-[#d0d0d0] shadow-sm" : "text-[#555] hover:text-[#999]"}`}
                        >
                          Dark
                        </button>
                        <button
                          onClick={() => { setThemeMode("light"); void onUpdateSettings({ theme: "light" }); }}
                          className={`rounded-md px-3 py-1.5 text-[11px] font-medium transition ${themeMode === "light" ? "bg-[#252525] text-[#d0d0d0] shadow-sm" : "text-[#555] hover:text-[#999]"}`}
                        >
                          Light
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Developer */}
                <div>
                  <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-[#444]">Developer</div>
                  <div className="rounded-lg border border-[#1e1e1e] bg-[#161616] p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[13px] font-medium text-[#d0d0d0]">DevTools</div>
                        <div className="mt-0.5 text-[11px] text-[#505050]">
                          Open Chromium developer tools
                          <span className="ml-1.5 rounded border border-[#252525] bg-[#1a1a1a] px-1 py-px text-[9px] text-[#444]">F12</span>
                        </div>
                      </div>
                      <button
                        onClick={() => void window.sncode.openDevTools()}
                        className="rounded-lg border border-[#252525] bg-[#1a1a1a] px-3.5 py-1.5 text-[12px] text-[#b0b0b0] transition hover:bg-[#1e1e1e] hover:text-[#d0d0d0]"
                      >
                        Open
                      </button>
                    </div>
                  </div>
                </div>

                {/* Keyboard shortcuts reference */}
                <div>
                  <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-[#444]">Shortcuts</div>
                  <div className="rounded-lg border border-[#1e1e1e] bg-[#161616] p-4">
                    <div className="space-y-2.5 text-[12px]">
                      {[
                        ["Ctrl+N", "New thread"],
                        ["Ctrl+W", "Close thread"],
                        ["Ctrl+F", "Search messages"],
                        ["Ctrl+B", "Toggle file tree"],
                        ["Ctrl+,", "Open settings"],
                        ["F12", "Toggle DevTools"],
                      ].map(([key, desc]) => (
                        <div key={key} className="flex items-center justify-between">
                          <span className="text-[#606060]">{desc}</span>
                          <kbd className="rounded border border-[#252525] bg-[#1a1a1a] px-1.5 py-0.5 font-mono text-[10px] text-[#555]">{key}</kbd>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ══════════ Providers ══════════ */}
            {tab === "providers" && (
              <div className="space-y-4">
                <p className="text-[11px] text-[#505050]">
                  Configure AI providers and authentication. Credentials are stored in your OS keychain.
                </p>
                {providers.map((provider) => {
                  const fb = feedback[provider.id];
                  return (
                    <div key={provider.id} className="rounded-lg border border-[#1e1e1e] bg-[#161616]">
                      {/* Provider header */}
                      <div className="flex items-center justify-between px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="grid h-8 w-8 place-items-center rounded-lg bg-[#1a1a1a] text-[14px] font-bold text-[#555]">
                            {provider.id === "anthropic" ? "A" : "O"}
                          </div>
                          <div>
                            <div className="text-[13px] font-medium text-[#d0d0d0]">{providerName(provider.id)}</div>
                            <div className="text-[11px] text-[#505050]">{providerDescription(provider.id)}</div>
                          </div>
                        </div>
                        <button
                          onClick={() => onUpdateProvider(provider, { enabled: !provider.enabled })}
                          className={`relative h-[22px] w-[40px] rounded-full transition-colors ${provider.enabled ? "bg-[#34c759]" : "bg-[#2a2a2a]"}`}
                        >
                          <div className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${provider.enabled ? "translate-x-[20px]" : "translate-x-[3px]"}`}/>
                        </button>
                      </div>

                      <div className="h-px bg-[#1e1e1e]" />

                      {/* Auth section */}
                      <div className="px-4 py-3">
                        <div className="mb-3 flex rounded-lg bg-[#111] p-0.5">
                          {(["apiKey", "subscriptionToken"] as AuthMode[]).map((mode) => (
                            <button
                              key={mode}
                              onClick={() => onUpdateProvider(provider, { authMode: mode })}
                              className={`flex-1 rounded-md px-3 py-1.5 text-[11px] font-medium transition ${
                                provider.authMode === mode ? "bg-[#252525] text-[#d0d0d0] shadow-sm" : "text-[#555] hover:text-[#999]"
                              }`}
                            >
                              {mode === "apiKey" ? "API Key" : "Subscription"}
                            </button>
                          ))}
                        </div>

                        {fb && (
                          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[#34c759]">
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            {fb}
                          </div>
                        )}

                        {provider.authMode === "apiKey" ? (
                          <div>
                            {provider.credentialSet && !drafts[provider.id] && (
                              <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[#505050]">
                                <div className="h-1.5 w-1.5 rounded-full bg-[#34c759]" />
                                API key configured
                              </div>
                            )}
                            <div className="flex gap-2">
                              <input
                                type="password"
                                value={drafts[provider.id] ?? ""}
                                onChange={(e) => setDrafts((p) => ({ ...p, [provider.id]: e.target.value }))}
                                placeholder={provider.credentialSet ? "Replace key..." : "sk-..."}
                                className="min-w-0 flex-1 rounded-lg border border-[#222] bg-[#111] px-3 py-2 text-[12px] text-[#d0d0d0] outline-none placeholder:text-[#333] focus:border-[#444]"
                              />
                              <button
                                onClick={() => handleSave(provider)}
                                disabled={!drafts[provider.id]?.trim()}
                                className="rounded-lg bg-[#252525] px-4 py-2 text-[12px] font-medium text-[#d0d0d0] transition hover:bg-[#333] disabled:opacity-30"
                              >
                                Save
                              </button>
                            </div>
                            {API_KEY_URLS[provider.id] && (
                              <button
                                onClick={() => window.sncode.openExternal(API_KEY_URLS[provider.id])}
                                className="mt-2 text-[11px] text-[#383838] underline decoration-[#2a2a2a] transition hover:text-[#808080]"
                              >
                                Get API key from {providerName(provider.id)}
                              </button>
                            )}
                          </div>
                        ) : (
                          <div>
                            {provider.credentialSet && (oauthStep[provider.id] ?? "idle") === "idle" && (
                              <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[#505050]">
                                <div className="h-1.5 w-1.5 rounded-full bg-[#34c759]" />
                                Subscription authorized
                              </div>
                            )}

                            {provider.id === "anthropic" ? (
                              <>
                                {(oauthStep[provider.id] ?? "idle") === "idle" && (
                                  <button
                                    onClick={async () => {
                                      setOauthStep((p) => ({ ...p, [provider.id]: "waiting_code" }));
                                      try { await window.sncode.oauthAnthropicStart(); }
                                      catch { setOauthStep((p) => ({ ...p, [provider.id]: "idle" })); flash(provider.id, "Failed to start OAuth"); }
                                    }}
                                    className="w-full rounded-lg border border-[#222] bg-[#111] py-2.5 text-[12px] font-medium text-[#d0d0d0] transition hover:bg-[#1a1a1a]"
                                  >
                                    {provider.credentialSet ? "Re-authorize" : "Sign in with Claude"}
                                  </button>
                                )}
                                {oauthStep[provider.id] === "waiting_code" && (
                                  <div className="space-y-2">
                                    <p className="text-[11px] leading-relaxed text-[#606060]">Complete sign-in in your browser, then paste the authorization code below.</p>
                                    <div className="flex gap-2">
                                      <input type="text" value={drafts[provider.id] ?? ""} onChange={(e) => setDrafts((p) => ({ ...p, [provider.id]: e.target.value }))} placeholder="Paste authorization code..." autoFocus className="min-w-0 flex-1 rounded-lg border border-[#222] bg-[#111] px-3 py-2 font-mono text-[12px] text-[#d0d0d0] outline-none placeholder:text-[#333] focus:border-[#444]"/>
                                      <button
                                        onClick={async () => {
                                          const code = drafts[provider.id]?.trim();
                                          if (!code) return;
                                          setOauthStep((p) => ({ ...p, [provider.id]: "exchanging" }));
                                          try {
                                            await window.sncode.oauthAnthropicExchange(code);
                                            setDrafts((p) => ({ ...p, [provider.id]: "" }));
                                            setOauthStep((p) => ({ ...p, [provider.id]: "idle" }));
                                            flash(provider.id, "Authorized with Claude Max");
                                            onUpdateProvider(provider, { credentialSet: true });
                                          } catch {
                                            setOauthStep((p) => ({ ...p, [provider.id]: "waiting_code" }));
                                            flash(provider.id, "Invalid code, try again");
                                          }
                                        }}
                                        disabled={!drafts[provider.id]?.trim()}
                                        className="rounded-lg bg-[#252525] px-4 py-2 text-[12px] font-medium text-[#d0d0d0] transition hover:bg-[#333] disabled:opacity-30"
                                      >
                                        Confirm
                                      </button>
                                    </div>
                                    <button onClick={() => { setOauthStep((p) => ({ ...p, [provider.id]: "idle" })); setDrafts((p) => ({ ...p, [provider.id]: "" })); }} className="text-[11px] text-[#505050] transition hover:text-[#999]">Cancel</button>
                                  </div>
                                )}
                                {oauthStep[provider.id] === "exchanging" && (
                                  <div className="flex items-center gap-2 py-2">
                                    <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400/80" />
                                    <span className="text-[11px] text-[#505050]">Exchanging code for token...</span>
                                  </div>
                                )}
                              </>
                            ) : (
                              <>
                                {(oauthStep[provider.id] ?? "idle") === "idle" && (
                                  <button
                                    onClick={async () => {
                                      setOauthStep((p) => ({ ...p, [provider.id]: "waiting_device" }));
                                      try {
                                        const result = await window.sncode.oauthCodexStart();
                                        setCodexDevice({ userCode: result.userCode, deviceAuthId: result.deviceAuthId });
                                        window.sncode.oauthCodexPoll({ deviceAuthId: result.deviceAuthId, userCode: result.userCode })
                                          .then(() => { setOauthStep((p) => ({ ...p, [provider.id]: "idle" })); setCodexDevice(null); flash(provider.id, "Authorized with ChatGPT"); onUpdateProvider(provider, { credentialSet: true }); })
                                          .catch(() => { setOauthStep((p) => ({ ...p, [provider.id]: "idle" })); setCodexDevice(null); flash(provider.id, "Authorization failed or timed out"); });
                                      } catch { setOauthStep((p) => ({ ...p, [provider.id]: "idle" })); flash(provider.id, "Failed to start device auth"); }
                                    }}
                                    className="w-full rounded-lg border border-[#222] bg-[#111] py-2.5 text-[12px] font-medium text-[#d0d0d0] transition hover:bg-[#1a1a1a]"
                                  >
                                    {provider.credentialSet ? "Re-authorize" : "Sign in with ChatGPT"}
                                  </button>
                                )}
                                {oauthStep[provider.id] === "waiting_device" && codexDevice && (
                                  <div className="space-y-2.5">
                                    <p className="text-[11px] leading-relaxed text-[#606060]">Enter this code on the page that opened in your browser:</p>
                                    <div className="flex items-center justify-center rounded-lg bg-[#111] py-3">
                                      <span className="font-mono text-[18px] font-bold tracking-[0.3em] text-[#d0d0d0]">{codexDevice.userCode}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400/80" />
                                      <span className="text-[11px] text-[#505050]">Waiting for authorization...</span>
                                    </div>
                                    <button onClick={() => { setOauthStep((p) => ({ ...p, [provider.id]: "idle" })); setCodexDevice(null); }} className="text-[11px] text-[#505050] transition hover:text-[#999]">Cancel</button>
                                  </div>
                                )}
                              </>
                            )}

                            {(oauthStep[provider.id] ?? "idle") === "idle" && (
                              <p className="mt-2 text-[11px] text-[#333]">
                                {provider.id === "anthropic" ? "Uses your Claude Pro or Max subscription." : "Uses your ChatGPT Plus or Pro subscription."}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ══════════ Agent ══════════ */}
            {tab === "agent" && (
              <div className="space-y-4">
                {feedback.settings && (
                  <div className="flex items-center gap-1.5 text-[11px] text-[#34c759]">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    {feedback.settings}
                  </div>
                )}

                <p className="text-[11px] text-[#505050]">
                  Configure the primary agent&apos;s response limits and tool usage.
                </p>

                <SettingSlider label="Max tokens" description="Maximum response length per model call" value={maxTokens} min={256} max={128000} step={256} onChange={setMaxTokens} />
                <SettingSlider label="Max tool steps" description="Maximum tool call iterations per agent run" value={maxToolSteps} min={1} max={100} step={1} onChange={setMaxToolSteps} />

                <button
                  onClick={handleSaveSettings}
                  className="w-full rounded-lg bg-[#222] py-2.5 text-[12px] font-medium text-[#d0d0d0] transition hover:bg-[#2a2a2a]"
                >
                  Save agent settings
                </button>
              </div>
            )}

            {/* ══════════ Tasks ══════════ */}
            {tab === "tasks" && (
              <div className="space-y-4">
                {feedback.tasks && (
                  <div className="flex items-center gap-1.5 text-[11px] text-[#34c759]">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    {feedback.tasks}
                  </div>
                )}

                <p className="text-[11px] text-[#505050]">
                  Configure sub-agent tasks that the main agent can spawn for parallel work.
                </p>

                {/* Sub-agent model */}
                <div className="rounded-lg border border-[#1e1e1e] bg-[#161616] p-4">
                  <div>
                    <div className="text-[13px] font-medium text-[#d0d0d0]">Sub-agent model</div>
                    <div className="mt-0.5 text-[11px] text-[#505050]">Model used for spawned tasks. Empty = same as parent.</div>
                  </div>
                  <select
                    value={subAgentModel}
                    onChange={(e) => setSubAgentModel(e.target.value)}
                    className="mt-2.5 w-full rounded-lg border border-[#222] bg-[#111] px-3 py-2 text-[12px] text-[#d0d0d0] outline-none focus:border-[#444]"
                  >
                    <option value="">Same as parent model</option>
                    {ALL_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>{m.label} ({m.provider === "anthropic" ? "Anthropic" : "OpenAI"})</option>
                    ))}
                  </select>
                </div>

                <SettingSlider label="Sub-agent max tokens" description="Response length limit per sub-agent call" value={subAgentMaxTokens} min={256} max={32000} step={256} onChange={setSubAgentMaxTokens} />
                <SettingSlider label="Sub-agent max tool steps" description="Tool iterations per sub-agent run" value={subAgentMaxToolSteps} min={1} max={50} step={1} onChange={setSubAgentMaxToolSteps} />
                <SettingSlider label="Max concurrent tasks" description="Maximum parallel sub-agent tasks" value={maxConcurrentTasks} min={1} max={10} step={1} onChange={setMaxConcurrentTasks} />

                <button
                  onClick={handleSaveTaskSettings}
                  className="w-full rounded-lg bg-[#222] py-2.5 text-[12px] font-medium text-[#d0d0d0] transition hover:bg-[#2a2a2a]"
                >
                  Save task settings
                </button>
              </div>
            )}

            {/* ══════════ Skills ══════════ */}
            {tab === "skills" && (
              <div className="space-y-3">
                {feedback.skills && (
                  <div className="flex items-center gap-1.5 text-[11px] text-[#34c759]">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    {feedback.skills}
                  </div>
                )}

                {!projectId ? (
                  <div className="rounded-lg border border-[#1e1e1e] bg-[#161616] p-4">
                    <p className="text-[12px] text-[#505050]">Select a project to manage skills.</p>
                  </div>
                ) : skillsLoading ? (
                  <div className="flex items-center gap-2 py-4">
                    <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400/80" />
                    <span className="text-[11px] text-[#505050]">Discovering skills...</span>
                  </div>
                ) : (
                  <>
                    <p className="text-[11px] text-[#505050]">
                      Enable skills to inject domain-specific instructions into the agent.
                    </p>

                    {availableSkills.length === 0 ? (
                      <div className="rounded-lg border border-[#1e1e1e] bg-[#161616] p-4">
                        <p className="text-[12px] text-[#505050]">No skills found.</p>
                        <p className="mt-1 text-[11px] text-[#383838]">
                          Skills are discovered from Claude Code directories, project-local .sncode/skills/, and SnCode&apos;s own skills directory.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {availableSkills.map((skill) => {
                          const enabled = projectSkillConfig.enabledSkillIds.includes(skill.id);
                          const isSncode = skill.source === "sncode";
                          return (
                            <div key={skill.id} className="group rounded-lg border border-[#1e1e1e] bg-[#161616] px-4 py-3">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[13px] font-medium text-[#d0d0d0]">{skill.name}</span>
                                    <span className={`rounded border px-1 py-px text-[9px] ${sourceBadgeColor(skill.source)}`}>
                                      {sourceLabel(skill.source)}
                                    </span>
                                  </div>
                                  <p className="mt-0.5 text-[11px] leading-relaxed text-[#505050]">{skill.description}</p>
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                  {isSncode && (
                                    <button onClick={() => handleDeleteSkill(skill.id)} className="hidden rounded-md p-1 text-[#505050] transition hover:bg-[#222] hover:text-red-400 group-hover:block" title="Delete skill">
                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1.5 14a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2L5 6"/></svg>
                                    </button>
                                  )}
                                  <button
                                    onClick={() => toggleSkill(skill.id, !enabled)}
                                    className={`relative h-[22px] w-[40px] rounded-full transition-colors ${enabled ? "bg-[#34c759]" : "bg-[#2a2a2a]"}`}
                                  >
                                    <div className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? "translate-x-[20px]" : "translate-x-[3px]"}`}/>
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <button
                      onClick={handleInstallSkill}
                      className="w-full rounded-lg border border-dashed border-[#2a2a2a] bg-[#111] py-2.5 text-[12px] text-[#505050] transition hover:border-[#444] hover:text-[#999]"
                    >
                      + Install skill from folder
                    </button>
                  </>
                )}
              </div>
            )}

            {/* ══════════ Data ══════════ */}
            {tab === "data" && (
              <div className="space-y-5">
                <p className="text-[11px] text-[#505050]">
                  Manage your application data. These actions cannot be undone.
                </p>

                {/* Clear all data */}
                <div className="rounded-lg border border-red-500/10 bg-[#161616] p-5">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-red-500/5 text-red-400/60">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1.5 14a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                      </svg>
                    </div>
                    <div className="flex-1">
                      <div className="text-[13px] font-medium text-[#d0d0d0]">Clear all data</div>
                      <div className="mt-1 text-[11px] leading-relaxed text-[#505050]">
                        This will permanently delete all projects, threads, messages, API keys from your keychain, and reset all settings to defaults. You will be returned to the onboarding screen.
                      </div>
                    </div>
                  </div>

                  {!confirmReset ? (
                    <button
                      onClick={() => setConfirmReset(true)}
                      className="mt-4 w-full rounded-lg border border-red-500/20 bg-red-500/5 py-2.5 text-[12px] font-medium text-red-400 transition hover:bg-red-500/10"
                    >
                      Clear all data
                    </button>
                  ) : (
                    <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/5 p-4">
                      <p className="mb-3 text-[12px] font-medium text-red-400">
                        Are you absolutely sure?
                      </p>
                      <p className="mb-4 text-[11px] leading-relaxed text-red-400/60">
                        This action cannot be reversed. All your data, including stored API keys, will be permanently erased.
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setConfirmReset(false)}
                          className="flex-1 rounded-lg border border-[#252525] bg-[#1a1a1a] py-2 text-[12px] text-[#808080] transition hover:bg-[#222]"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={async () => {
                            setResetting(true);
                            await onClearAllData();
                            setResetting(false);
                            setConfirmReset(false);
                          }}
                          disabled={resetting}
                          className="flex-1 rounded-lg bg-red-500/20 py-2 text-[12px] font-medium text-red-400 transition hover:bg-red-500/30 disabled:opacity-50"
                        >
                          {resetting ? "Clearing..." : "Yes, clear everything"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
