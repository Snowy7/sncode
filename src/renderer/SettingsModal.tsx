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
}

type Tab = "providers" | "agent" | "skills";

/* ── component ── */

/* ── Skills tab helpers ── */

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

export default function SettingsModal({
  providers,
  settings,
  projectId,
  projectPath,
  onClose,
  onUpdateProvider,
  onSaveCredential,
  onUpdateSettings,
}: Props) {
  const [tab, setTab] = useState<Tab>("providers");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [oauthStep, setOauthStep] = useState<Record<string, "idle" | "waiting_code" | "waiting_device" | "exchanging">>(
    {}
  );
  const [codexDevice, setCodexDevice] = useState<{ userCode: string; deviceAuthId: string } | null>(null);

  // Local settings drafts
  const [maxTokens, setMaxTokens] = useState(settings.maxTokens);
  const [maxToolSteps, setMaxToolSteps] = useState(settings.maxToolSteps);
  const [subAgentModel, setSubAgentModel] = useState(settings.subAgentModel);
  const [subAgentMaxTokens, setSubAgentMaxTokens] = useState(settings.subAgentMaxTokens);
  const [subAgentMaxToolSteps, setSubAgentMaxToolSteps] = useState(settings.subAgentMaxToolSteps);
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(settings.maxConcurrentTasks);
  const [themeMode, setThemeMode] = useState(settings.theme || "dark");

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[520px] overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#161616] shadow-2xl shadow-black/50">
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-5 py-3.5">
          <span className="text-[13px] font-semibold text-[#e0e0e0]">
            Settings
          </span>
          <button
            onClick={onClose}
            className="grid h-6 w-6 place-items-center rounded-md text-[#555] transition hover:bg-[#222] hover:text-[#999]"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M1.5 1.5l9 9m0-9l-9 9"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* ── Tabs ── */}
        <div className="flex border-b border-[#222] px-5">
          {(["providers", "agent", "skills"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`mr-4 border-b-2 pb-2 text-[12px] font-medium transition ${
                tab === t
                  ? "border-[#e0e0e0] text-[#e0e0e0]"
                  : "border-transparent text-[#555] hover:text-[#999]"
              }`}
            >
              {t === "providers" ? "Providers" : t === "agent" ? "Agent" : "Skills"}
            </button>
          ))}
        </div>

        {/* ── Body ── */}
        <div className="max-h-[480px] overflow-auto p-4">
          {tab === "providers" && (
            <div className="space-y-3">
              {providers.map((provider) => {
                const fb = feedback[provider.id];
                return (
                  <div key={provider.id} className="rounded-lg border border-[#222] bg-[#1a1a1a]">
                    {/* Provider header */}
                    <div className="flex items-center justify-between px-4 py-3">
                      <div>
                        <div className="text-[13px] font-medium text-[#d0d0d0]">
                          {providerName(provider.id)}
                        </div>
                        <div className="mt-0.5 text-[11px] text-[#555]">
                          {providerDescription(provider.id)}
                        </div>
                      </div>
                      <button
                        onClick={() =>
                          onUpdateProvider(provider, { enabled: !provider.enabled })
                        }
                        className={`relative h-[22px] w-[40px] rounded-full transition-colors ${
                          provider.enabled ? "bg-[#34c759]" : "bg-[#333]"
                        }`}
                      >
                        <div
                          className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                            provider.enabled ? "translate-x-[20px]" : "translate-x-[3px]"
                          }`}
                        />
                      </button>
                    </div>

                    <div className="h-px bg-[#222]" />

                    {/* Auth section */}
                    <div className="px-4 py-3">
                      <div className="mb-3 flex rounded-lg bg-[#141414] p-0.5">
                        {(["apiKey", "subscriptionToken"] as AuthMode[]).map(
                          (mode) => (
                            <button
                              key={mode}
                              onClick={() =>
                                onUpdateProvider(provider, { authMode: mode })
                              }
                              className={`flex-1 rounded-md px-3 py-1.5 text-[11px] font-medium transition ${
                                provider.authMode === mode
                                  ? "bg-[#282828] text-[#d0d0d0] shadow-sm"
                                  : "text-[#555] hover:text-[#999]"
                              }`}
                            >
                              {mode === "apiKey" ? "API Key" : "Subscription"}
                            </button>
                          )
                        )}
                      </div>

                      {fb && (
                        <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[#34c759]">
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                            <path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          {fb}
                        </div>
                      )}

                      {provider.authMode === "apiKey" ? (
                        <div>
                          {provider.credentialSet && !drafts[provider.id] && (
                            <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[#606060]">
                              <div className="h-1.5 w-1.5 rounded-full bg-[#34c759]" />
                              API key configured
                            </div>
                          )}
                          <div className="flex gap-2">
                            <input
                              type="password"
                              value={drafts[provider.id] ?? ""}
                              onChange={(e) =>
                                setDrafts((p) => ({
                                  ...p,
                                  [provider.id]: e.target.value,
                                }))
                              }
                              placeholder={
                                provider.credentialSet ? "Replace key..." : "sk-..."
                              }
                              className="min-w-0 flex-1 rounded-lg border border-[#282828] bg-[#141414] px-3 py-2 text-[12px] text-[#d0d0d0] outline-none placeholder:text-[#404040] focus:border-[#444]"
                            />
                            <button
                              onClick={() => handleSave(provider)}
                              disabled={!drafts[provider.id]?.trim()}
                              className="rounded-lg bg-[#282828] px-4 py-2 text-[12px] font-medium text-[#d0d0d0] transition hover:bg-[#333] disabled:opacity-30"
                            >
                              Save
                            </button>
                          </div>
                          {API_KEY_URLS[provider.id] && (
                            <button
                              onClick={() => window.sncode.openExternal(API_KEY_URLS[provider.id])}
                              className="mt-2 text-[11px] text-[#444] transition hover:text-[#808080]"
                            >
                              Get API key from {providerName(provider.id)} &rarr;
                            </button>
                          )}
                        </div>
                      ) : (
                        <div>
                          {provider.credentialSet && (oauthStep[provider.id] ?? "idle") === "idle" && (
                            <div className="mb-2 flex items-center gap-1.5 text-[11px] text-[#606060]">
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
                                    try {
                                      await window.sncode.oauthAnthropicStart();
                                    } catch {
                                      setOauthStep((p) => ({ ...p, [provider.id]: "idle" }));
                                      flash(provider.id, "Failed to start OAuth");
                                    }
                                  }}
                                  className="w-full rounded-lg border border-[#282828] bg-[#141414] py-2.5 text-[12px] font-medium text-[#d0d0d0] transition hover:bg-[#1e1e1e]"
                                >
                                  {provider.credentialSet ? "Re-authorize" : "Sign in with Claude"}
                                </button>
                              )}

                              {oauthStep[provider.id] === "waiting_code" && (
                                <div className="space-y-2">
                                  <p className="text-[11px] leading-relaxed text-[#707070]">
                                    Complete sign-in in your browser, then paste the authorization code below.
                                  </p>
                                  <div className="flex gap-2">
                                    <input
                                      type="text"
                                      value={drafts[provider.id] ?? ""}
                                      onChange={(e) =>
                                        setDrafts((p) => ({ ...p, [provider.id]: e.target.value }))
                                      }
                                      placeholder="Paste authorization code..."
                                      autoFocus
                                      className="min-w-0 flex-1 rounded-lg border border-[#282828] bg-[#141414] px-3 py-2 font-mono text-[12px] text-[#d0d0d0] outline-none placeholder:text-[#404040] focus:border-[#444]"
                                    />
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
                                      className="rounded-lg bg-[#282828] px-4 py-2 text-[12px] font-medium text-[#d0d0d0] transition hover:bg-[#333] disabled:opacity-30"
                                    >
                                      Confirm
                                    </button>
                                  </div>
                                  <button
                                    onClick={() => {
                                      setOauthStep((p) => ({ ...p, [provider.id]: "idle" }));
                                      setDrafts((p) => ({ ...p, [provider.id]: "" }));
                                    }}
                                    className="text-[11px] text-[#555] transition hover:text-[#999]"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              )}

                              {oauthStep[provider.id] === "exchanging" && (
                                <div className="flex items-center gap-2 py-2">
                                  <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400/80" />
                                  <span className="text-[11px] text-[#606060]">Exchanging code for token...</span>
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
                                      window.sncode.oauthCodexPoll({
                                        deviceAuthId: result.deviceAuthId,
                                        userCode: result.userCode,
                                      }).then(() => {
                                        setOauthStep((p) => ({ ...p, [provider.id]: "idle" }));
                                        setCodexDevice(null);
                                        flash(provider.id, "Authorized with ChatGPT");
                                        onUpdateProvider(provider, { credentialSet: true });
                                      }).catch(() => {
                                        setOauthStep((p) => ({ ...p, [provider.id]: "idle" }));
                                        setCodexDevice(null);
                                        flash(provider.id, "Authorization failed or timed out");
                                      });
                                    } catch {
                                      setOauthStep((p) => ({ ...p, [provider.id]: "idle" }));
                                      flash(provider.id, "Failed to start device auth");
                                    }
                                  }}
                                  className="w-full rounded-lg border border-[#282828] bg-[#141414] py-2.5 text-[12px] font-medium text-[#d0d0d0] transition hover:bg-[#1e1e1e]"
                                >
                                  {provider.credentialSet ? "Re-authorize" : "Sign in with ChatGPT"}
                                </button>
                              )}

                              {oauthStep[provider.id] === "waiting_device" && codexDevice && (
                                <div className="space-y-2.5">
                                  <p className="text-[11px] leading-relaxed text-[#707070]">
                                    Enter this code on the page that opened in your browser:
                                  </p>
                                  <div className="flex items-center justify-center rounded-lg bg-[#141414] py-3">
                                    <span className="font-mono text-[18px] font-bold tracking-[0.3em] text-[#d0d0d0]">
                                      {codexDevice.userCode}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400/80" />
                                    <span className="text-[11px] text-[#606060]">Waiting for authorization...</span>
                                  </div>
                                  <button
                                    onClick={() => {
                                      setOauthStep((p) => ({ ...p, [provider.id]: "idle" }));
                                      setCodexDevice(null);
                                    }}
                                    className="text-[11px] text-[#555] transition hover:text-[#999]"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              )}
                            </>
                          )}

                          {(oauthStep[provider.id] ?? "idle") === "idle" && (
                            <p className="mt-2 text-[11px] text-[#383838]">
                              {provider.id === "anthropic"
                                ? "Uses your Claude Pro or Max subscription."
                                : "Uses your ChatGPT Plus or Pro subscription."}
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
          {tab === "agent" && (
            /* ── Agent Settings Tab ── */
            <div className="space-y-5">
              {feedback.settings && (
                <div className="flex items-center gap-1.5 text-[11px] text-[#34c759]">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {feedback.settings}
                </div>
              )}

              {/* Max Tokens */}
              <div className="rounded-lg border border-[#222] bg-[#1a1a1a] p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[13px] font-medium text-[#d0d0d0]">Max tokens</div>
                    <div className="mt-0.5 text-[11px] text-[#555]">
                      Maximum response length per model call
                    </div>
                  </div>
                  <span className="ml-3 shrink-0 rounded bg-[#222] px-2 py-0.5 font-mono text-[12px] text-[#999]">
                    {maxTokens.toLocaleString()}
                  </span>
                </div>
                <input
                  type="range"
                  min={256}
                  max={128000}
                  step={256}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Number(e.target.value))}
                  className="mt-3 w-full accent-[#e0e0e0]"
                />
                <div className="mt-1 flex justify-between text-[10px] text-[#444]">
                  <span>256</span>
                  <span>128,000</span>
                </div>
              </div>

              {/* Max Tool Steps */}
              <div className="rounded-lg border border-[#222] bg-[#1a1a1a] p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[13px] font-medium text-[#d0d0d0]">Max tool steps</div>
                    <div className="mt-0.5 text-[11px] text-[#555]">
                      Maximum tool call iterations per agent run
                    </div>
                  </div>
                  <span className="ml-3 shrink-0 rounded bg-[#222] px-2 py-0.5 font-mono text-[12px] text-[#999]">
                    {maxToolSteps}
                  </span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={100}
                  step={1}
                  value={maxToolSteps}
                  onChange={(e) => setMaxToolSteps(Number(e.target.value))}
                  className="mt-3 w-full accent-[#e0e0e0]"
                />
                <div className="mt-1 flex justify-between text-[10px] text-[#444]">
                  <span>1</span>
                  <span>100</span>
                </div>
              </div>

              {/* ── Sub-agent Settings ── */}
              <div className="pt-2">
                <div className="mb-3 text-[12px] font-medium text-[#808080]">Sub-agents / Tasks</div>

                {/* Sub-agent model */}
                <div className="rounded-lg border border-[#222] bg-[#1a1a1a] p-4">
                  <div>
                    <div className="text-[13px] font-medium text-[#d0d0d0]">Sub-agent model</div>
                    <div className="mt-0.5 text-[11px] text-[#555]">
                      Model used for spawned tasks. Empty = same as parent.
                    </div>
                  </div>
                  <select
                    value={subAgentModel}
                    onChange={(e) => setSubAgentModel(e.target.value)}
                    className="mt-2.5 w-full rounded-lg border border-[#282828] bg-[#141414] px-3 py-2 text-[12px] text-[#d0d0d0] outline-none focus:border-[#444]"
                  >
                    <option value="">Same as parent model</option>
                    {ALL_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>{m.label} ({m.provider === "anthropic" ? "Anthropic" : "OpenAI"})</option>
                    ))}
                  </select>
                </div>

                {/* Sub-agent max tokens */}
                <div className="mt-3 rounded-lg border border-[#222] bg-[#1a1a1a] p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[13px] font-medium text-[#d0d0d0]">Sub-agent max tokens</div>
                      <div className="mt-0.5 text-[11px] text-[#555]">Response length limit per sub-agent call</div>
                    </div>
                    <span className="ml-3 shrink-0 rounded bg-[#222] px-2 py-0.5 font-mono text-[12px] text-[#999]">
                      {subAgentMaxTokens.toLocaleString()}
                    </span>
                  </div>
                  <input type="range" min={256} max={32000} step={256} value={subAgentMaxTokens} onChange={(e) => setSubAgentMaxTokens(Number(e.target.value))} className="mt-3 w-full accent-[#e0e0e0]" />
                  <div className="mt-1 flex justify-between text-[10px] text-[#444]"><span>256</span><span>32,000</span></div>
                </div>

                {/* Sub-agent max tool steps */}
                <div className="mt-3 rounded-lg border border-[#222] bg-[#1a1a1a] p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[13px] font-medium text-[#d0d0d0]">Sub-agent max tool steps</div>
                      <div className="mt-0.5 text-[11px] text-[#555]">Tool iterations per sub-agent run</div>
                    </div>
                    <span className="ml-3 shrink-0 rounded bg-[#222] px-2 py-0.5 font-mono text-[12px] text-[#999]">
                      {subAgentMaxToolSteps}
                    </span>
                  </div>
                  <input type="range" min={1} max={50} step={1} value={subAgentMaxToolSteps} onChange={(e) => setSubAgentMaxToolSteps(Number(e.target.value))} className="mt-3 w-full accent-[#e0e0e0]" />
                  <div className="mt-1 flex justify-between text-[10px] text-[#444]"><span>1</span><span>50</span></div>
                </div>

                {/* Max concurrent tasks */}
                <div className="mt-3 rounded-lg border border-[#222] bg-[#1a1a1a] p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[13px] font-medium text-[#d0d0d0]">Max concurrent tasks</div>
                      <div className="mt-0.5 text-[11px] text-[#555]">Maximum parallel sub-agent tasks</div>
                    </div>
                    <span className="ml-3 shrink-0 rounded bg-[#222] px-2 py-0.5 font-mono text-[12px] text-[#999]">
                      {maxConcurrentTasks}
                    </span>
                  </div>
                  <input type="range" min={1} max={10} step={1} value={maxConcurrentTasks} onChange={(e) => setMaxConcurrentTasks(Number(e.target.value))} className="mt-3 w-full accent-[#e0e0e0]" />
                  <div className="mt-1 flex justify-between text-[10px] text-[#444]"><span>1</span><span>10</span></div>
                </div>
              </div>

              {/* ── Appearance ── */}
              <div className="pt-2">
                <div className="mb-3 text-[12px] font-medium text-[#808080]">Appearance</div>
                <div className="rounded-lg border border-[#222] bg-[#1a1a1a] p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[13px] font-medium text-[#d0d0d0]">Theme</div>
                      <div className="mt-0.5 text-[11px] text-[#555]">Switch between dark and light mode</div>
                    </div>
                    <div className="flex rounded-lg bg-[#141414] p-0.5">
                      <button
                        onClick={() => setThemeMode("dark")}
                        className={`rounded-md px-3 py-1.5 text-[11px] font-medium transition ${themeMode === "dark" ? "bg-[#282828] text-[#d0d0d0] shadow-sm" : "text-[#555] hover:text-[#999]"}`}
                      >
                        Dark
                      </button>
                      <button
                        onClick={() => setThemeMode("light")}
                        className={`rounded-md px-3 py-1.5 text-[11px] font-medium transition ${themeMode === "light" ? "bg-[#282828] text-[#d0d0d0] shadow-sm" : "text-[#555] hover:text-[#999]"}`}
                      >
                        Light
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <button
                onClick={handleSaveSettings}
                className="w-full rounded-lg bg-[#282828] py-2.5 text-[12px] font-medium text-[#d0d0d0] transition hover:bg-[#333]"
              >
                Save settings
              </button>
            </div>
          )}
          {tab === "skills" && (
            /* ── Skills Tab ── */
            <div className="space-y-3">
              {feedback.skills && (
                <div className="flex items-center gap-1.5 text-[11px] text-[#34c759]">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {feedback.skills}
                </div>
              )}

              {!projectId ? (
                <div className="rounded-lg border border-[#222] bg-[#1a1a1a] p-4">
                  <p className="text-[12px] text-[#555]">Select a project to manage skills.</p>
                </div>
              ) : skillsLoading ? (
                <div className="flex items-center gap-2 py-4">
                  <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400/80" />
                  <span className="text-[11px] text-[#606060]">Discovering skills...</span>
                </div>
              ) : (
                <>
                  <p className="text-[11px] text-[#555]">
                    Enable skills to inject domain-specific instructions into the agent. The agent can also dynamically load available skills when needed.
                  </p>

                  {availableSkills.length === 0 ? (
                    <div className="rounded-lg border border-[#222] bg-[#1a1a1a] p-4">
                      <p className="text-[12px] text-[#606060]">No skills found.</p>
                      <p className="mt-1 text-[11px] text-[#444]">
                        Skills are discovered from Claude Code directories, project-local .sncode/skills/, and SnCode&apos;s own skills directory.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {availableSkills.map((skill) => {
                        const enabled = projectSkillConfig.enabledSkillIds.includes(skill.id);
                        const isSncode = skill.source === "sncode";
                        return (
                          <div key={skill.id} className="group rounded-lg border border-[#222] bg-[#1a1a1a] px-4 py-3">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-[13px] font-medium text-[#d0d0d0]">{skill.name}</span>
                                  <span className={`rounded border px-1 py-px text-[9px] ${sourceBadgeColor(skill.source)}`}>
                                    {sourceLabel(skill.source)}
                                  </span>
                                </div>
                                <p className="mt-0.5 text-[11px] leading-relaxed text-[#555]">{skill.description}</p>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                {isSncode && (
                                  <button
                                    onClick={() => handleDeleteSkill(skill.id)}
                                    className="hidden rounded-md p-1 text-[#505050] transition hover:bg-[#2a2a2a] hover:text-red-400 group-hover:block"
                                    title="Delete skill"
                                  >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1.5 14a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2L5 6" />
                                    </svg>
                                  </button>
                                )}
                                <button
                                  onClick={() => toggleSkill(skill.id, !enabled)}
                                  className={`relative h-[22px] w-[40px] rounded-full transition-colors ${
                                    enabled ? "bg-[#34c759]" : "bg-[#333]"
                                  }`}
                                >
                                  <div
                                    className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                                      enabled ? "translate-x-[20px]" : "translate-x-[3px]"
                                    }`}
                                  />
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
                    className="w-full rounded-lg border border-dashed border-[#333] bg-[#141414] py-2.5 text-[12px] text-[#606060] transition hover:border-[#444] hover:text-[#999]"
                  >
                    + Install skill from folder
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="border-t border-[#222] px-5 py-3">
          <p className="text-[11px] text-[#404040]">
            All credentials are stored securely in your OS keychain.
          </p>
        </div>
      </div>
    </div>
  );
}
