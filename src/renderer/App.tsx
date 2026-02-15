import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/core";

// Register common languages for syntax highlighting
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import diff from "highlight.js/lib/languages/diff";
import csharp from "highlight.js/lib/languages/csharp";
import cpp from "highlight.js/lib/languages/cpp";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("powershell", bash);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("cs", csharp);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c", cpp);

import { AgentSettings, AppState, FileTreeEntry, GitDiffEntry, GitStatusInfo, ImageAttachment, ImageMediaType, ProviderId, ProviderConfig, Project, ThinkingLevel, ThreadMessage, TodoItem } from "../shared/types";
import { ALL_MODELS, API_KEY_URLS, labelForModelId, providerForModelId } from "../shared/models";
import SettingsModal from "./SettingsModal";

/* ── constants ── */

const emptyState: AppState = {
  projects: [],
  threads: [],
  messages: [],
  providers: [],
  settings: { maxTokens: 16384, maxToolSteps: 25, subAgentModel: "", subAgentMaxTokens: 8192, subAgentMaxToolSteps: 15, maxConcurrentTasks: 3, theme: "dark", thinkingLevel: "none", onboardingComplete: false },
  projectSkills: [],
};

type PermissionMode = "full" | "approve";

/* ── helpers ── */

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function authorizedProviderIds(providers: ProviderConfig[]): Set<string> {
  return new Set(providers.filter((p) => p.credentialSet).map((p) => p.id));
}

function availableModels(providers: ProviderConfig[]) {
  const authed = authorizedProviderIds(providers);
  return ALL_MODELS.filter((m) => authed.has(m.provider));
}

function activeModelLabel(providers: ProviderConfig[]) {
  const p = providers.find((x) => x.enabled);
  if (!p) {
    const avail = availableModels(providers);
    return avail.length > 0 ? avail[0].label : "No model";
  }
  return labelForModelId(p.model);
}

function activeModelId(providers: ProviderConfig[]) {
  return providers.find((x) => x.enabled)?.model ?? "";
}

const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result is "data:<mediaType>;base64,<data>" — strip the prefix
      const result = reader.result as string;
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function fileToImageAttachment(file: File): Promise<ImageAttachment | null> {
  if (!ACCEPTED_IMAGE_TYPES.has(file.type)) return null;
  if (file.size > MAX_IMAGE_BYTES) return null;
  const data = await fileToBase64(file);
  return { data, mediaType: file.type as ImageMediaType, name: file.name || undefined };
}



/* ── Markdown renderer ── */

function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-3 last:mb-0 leading-[1.7]">{children}</p>,
        h1: ({ children }) => <h1 className="mb-2 mt-5 text-[17px] font-bold text-[var(--text-primary)]">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-4 text-[15px] font-semibold text-[var(--text-primary)]">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-[14px] font-semibold text-[var(--text-primary)]">{children}</h3>,
        h4: ({ children }) => <h4 className="mb-1 mt-2 text-[13px] font-semibold text-[var(--text-primary)]">{children}</h4>,
        ul: ({ children }) => <ul className="mb-3 ml-5 list-disc space-y-1">{children}</ul>,
        ol: ({ children }) => <ol className="mb-3 ml-5 list-decimal space-y-1">{children}</ol>,
        li: ({ children }) => <li className="leading-[1.65]">{children}</li>,
        a: ({ href, children }) => (
          <a href={href} className="text-blue-400 underline decoration-blue-400/30 hover:decoration-blue-400" target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
        blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-[var(--border-active)] pl-3 text-[var(--text-muted)]">{children}</blockquote>,
        strong: ({ children }) => <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>,
        em: ({ children }) => <em className="text-[var(--text-secondary)]">{children}</em>,
        hr: () => <hr className="my-4 border-[var(--border)]" />,
        pre: ({ children }) => (
          <div className="group/code relative my-3 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-code)]">
            <pre className="overflow-x-auto p-3.5 text-[12.5px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[12.5px]">
              {children}
            </pre>
          </div>
        ),
        code: ({ className, children }) => {
          const lang = className?.replace("language-", "");
          if (lang || className) {
            const code = String(children).replace(/\n$/, "");
            let highlighted = code;
            try {
              if (lang && hljs.getLanguage(lang)) {
                highlighted = hljs.highlight(code, { language: lang }).value;
              } else {
                highlighted = hljs.highlightAuto(code).value;
              }
            } catch { /* use raw */ }
            return (
              <code
                className="font-mono"
                dangerouslySetInnerHTML={{ __html: highlighted }}
              />
            );
          }
          return <code className="rounded bg-[var(--bg-user-bubble)] px-1.5 py-0.5 text-[12px] font-mono text-[var(--text-primary)]">{children}</code>;
        },
        table: ({ children }) => (
          <div className="my-3 overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border border-[var(--border-strong)] bg-[var(--bg-card)] px-3 py-1.5 text-left text-[12px] font-medium text-[var(--text-heading)]">{children}</th>,
        td: ({ children }) => <td className="border border-[var(--border)] px-3 py-1.5">{children}</td>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

/* ── Tool message component ── */

function ToolMessage({ msg }: { msg: ThreadMessage }) {
  const [expanded, setExpanded] = useState(false);
  const name = msg.metadata?.toolName || "tool";
  const detail = msg.metadata?.toolDetail || name;
  const pending = msg.metadata?.pending === true;
  const result = msg.content;
  const isLong = result.length > 200;

  const dotColor = pending
    ? "bg-amber-400/80 animate-pulse"
    : name === "write_file" || name === "edit_file"
      ? "bg-emerald-500/70"
      : name === "run_command"
        ? "bg-amber-400/70"
        : name === "glob" || name === "grep"
          ? "bg-purple-400/70"
          : "bg-blue-400/70";

  return (
    <div className={`rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] ${pending ? "opacity-80" : ""}`}>
      <button
        onClick={() => !pending && setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left"
      >
        <div className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-muted)]">
          {pending ? `${detail}...` : detail}
        </span>
        {!pending && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
            className={`shrink-0 text-[var(--text-dimmer)] transition-transform ${expanded ? "rotate-180" : ""}`}
          >
            <path d="M2 3.5l3 3 3-3z" />
          </svg>
        )}
      </button>
      {!pending && (expanded || !isLong) && result && (
        <div className="border-t border-[var(--border-subtle)] px-3.5 py-2.5">
          {(name === "edit_file") && result.startsWith("Replaced") ? (
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-500/70">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              {result}
            </div>
          ) : (
            <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[var(--text-dim)]">
              {isLong && !expanded ? result.slice(0, 200) + "..." : result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Task message component ── */

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function TaskMessage({ msg, onClickDetail }: { msg: ThreadMessage; onClickDetail?: (msg: ThreadMessage) => void }) {
  const [expanded, setExpanded] = useState(false);
  const pending = msg.metadata?.pending === true;
  const taskType = msg.metadata?.taskType || "general";
  const description = msg.metadata?.taskDescription || msg.metadata?.toolDetail || "Task";
  const duration = msg.metadata?.taskDurationMs;
  const trail = msg.metadata?.taskTrail || [];
  const lastTrail = trail.length > 0 ? trail[trail.length - 1] : null;
  const result = msg.content;
  const isLong = result.length > 300;

  const typeBadge = taskType === "explore"
    ? { label: "explore", color: "text-cyan-400 border-cyan-400/30 bg-cyan-400/5" }
    : { label: "general", color: "text-orange-400 border-orange-400/30 bg-orange-400/5" };

  const statusDot = pending
    ? "bg-amber-400/80 animate-pulse"
    : "bg-emerald-500/70";

  return (
    <div className={`rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] ${pending ? "opacity-90" : ""}`}>
      {/* Task header - clickable for sidebar detail */}
      <button
        onClick={() => onClickDetail?.(msg)}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition hover:bg-[var(--bg-card)] rounded-t-lg"
      >
        <div className={`h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-dim)]">
          <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
        </svg>
        <span className="min-w-0 flex-1 text-[12.5px] font-medium text-[var(--text-label)]">
          {pending ? `${description}...` : description}
        </span>
        <span className={`rounded border px-1.5 py-px text-[9px] font-medium ${typeBadge.color}`}>
          {typeBadge.label}
        </span>
        {!pending && duration !== undefined && (
          <span className="text-[10px] text-[var(--text-dimmer)]">{formatDuration(duration)}</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="shrink-0 text-[var(--text-dimmest)]">
          <path d="M3 1l4.5 4.5L3 10" />
        </svg>
      </button>

      {/* Last trail entry - shows what's happening now */}
      {pending && lastTrail && (
        <div className="mx-4 border-t border-[var(--border-subtle)] py-1.5">
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-dim)]">
            <div className={`h-1 w-1 rounded-full ${lastTrail.type === "tool" ? "bg-blue-400/70" : "bg-[var(--text-dim)]"}`} />
            <span className="truncate">{lastTrail.summary}</span>
          </div>
        </div>
      )}

      {/* Result */}
      {!pending && result && (
        <>
          <div className="mx-4 h-px bg-[var(--bg-user-bubble)]" />
          <div className="px-4 py-2.5">
            {isLong && !expanded ? (
              <>
                <div className="text-[12px] leading-relaxed text-[var(--text-muted)]">
                  <Markdown content={result.slice(0, 300) + "..."} />
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
                  className="mt-1 text-[11px] text-[var(--text-dim)] transition hover:text-[var(--text-muted)]"
                >
                  Show full result
                </button>
              </>
            ) : (
              <div className="max-h-[400px] overflow-auto text-[12px] leading-relaxed text-[var(--text-muted)]">
                <Markdown content={result} />
              </div>
            )}
            {expanded && isLong && (
              <button
                onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
                className="mt-1 text-[11px] text-[var(--text-dim)] transition hover:text-[var(--text-muted)]"
              >
                Collapse
              </button>
            )}
          </div>
        </>
      )}

      {/* Pending indicator (when no trail yet) */}
      {pending && !lastTrail && (
        <div className="px-4 pb-2.5">
          <div className="flex items-center gap-1.5">
            <div className="flex gap-[3px]">
              <div className="h-1 w-1 animate-bounce rounded-full bg-[var(--text-dimmer)]" style={{ animationDelay: "0ms" }} />
              <div className="h-1 w-1 animate-bounce rounded-full bg-[var(--text-dimmer)]" style={{ animationDelay: "150ms" }} />
              <div className="h-1 w-1 animate-bounce rounded-full bg-[var(--text-dimmer)]" style={{ animationDelay: "300ms" }} />
            </div>
            <span className="text-[10px] text-[var(--text-dimmer)]">Sub-agent working...</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── icons ── */

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" className={`transition-transform ${open ? "rotate-180" : ""}`}>
      <path d="M1 2.5l3 3 3-3z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 12V2m0 0L3 6m4-4l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
      <rect x="1.5" y="1.5" width="9" height="9" rx="2" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function UnlockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
  );
}

function GitBranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1.5 14a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2 2l6 6M8 2l-6 6" />
    </svg>
  );
}

/* ── File tree component ── */

function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const colorMap: Record<string, string> = {
    ts: "text-blue-400", tsx: "text-blue-400", js: "text-yellow-400", jsx: "text-yellow-400",
    py: "text-green-400", rs: "text-orange-400", go: "text-cyan-400", java: "text-red-400",
    css: "text-purple-400", html: "text-orange-400", json: "text-yellow-500", md: "text-[var(--text-muted)]",
    yml: "text-pink-400", yaml: "text-pink-400", toml: "text-[var(--text-muted)]",
  };
  const color = colorMap[ext] || "text-[var(--text-dim)]";
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${color}`}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-muted)]">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-dim)]">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FileTreeNode({ entry, depth = 0, parentPath = "", onFileClick }: { entry: FileTreeEntry; depth?: number; parentPath?: string; onFileClick?: (path: string) => void }) {
  const [open, setOpen] = useState(depth < 1);
  const currentPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.type === "dir") {
    return (
      <div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded px-1 py-[2px] text-left text-[11px] text-[var(--text-muted)] transition hover:bg-[var(--bg-card)]"
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          <svg width="6" height="6" viewBox="0 0 6 6" fill="currentColor" className={`shrink-0 text-[var(--text-dim)] transition-transform ${open ? "rotate-90" : ""}`}><path d="M1.5 0.5l3 2.5-3 2.5z" /></svg>
          <FolderIcon open={open} />
          <span className="truncate">{entry.name}</span>
        </button>
        {open && entry.children && (
          <div>
            {entry.children.map((child) => (
              <FileTreeNode key={child.name} entry={child} depth={depth + 1} parentPath={currentPath} onFileClick={onFileClick} />
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <button
      onClick={() => onFileClick?.(currentPath)}
      className="flex w-full items-center gap-1.5 rounded px-1 py-[2px] text-left text-[11px] text-[var(--text-muted)] transition hover:bg-[var(--bg-card)] hover:text-[var(--text-label)]"
      style={{ paddingLeft: `${depth * 12 + 16}px` }}
    >
      <FileIcon name={entry.name} />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

function FileTreePanel({ projectPath, onFileClick }: { projectPath: string; onFileClick?: (path: string) => void }) {
  const [tree, setTree] = useState<FileTreeEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    window.sncode.getFileTree(projectPath, 4).then((entries) => {
      setTree(entries);
      setLoading(false);
    });
  }, [projectPath]);

  if (loading) return <div className="px-3 py-2 text-[10px] text-[var(--text-dimmer)]">Loading...</div>;
  if (tree.length === 0) return <div className="px-3 py-2 text-[10px] text-[var(--text-dimmer)]">Empty project</div>;

  return (
    <div className="max-h-[240px] overflow-auto px-1 py-1">
      {tree.map((entry) => (
        <FileTreeNode key={entry.name} entry={entry} depth={0} onFileClick={onFileClick} />
      ))}
    </div>
  );
}

/* ── Search overlay ── */

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function SearchBar({ messages, onClose, onHighlight }: { messages: ThreadMessage[]; onClose: () => void; onHighlight: (q: string) => void }) {
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.toLowerCase().includes(q))
      .map((m) => {
        const idx = m.content.toLowerCase().indexOf(q);
        const start = Math.max(0, idx - 40);
        const end = Math.min(m.content.length, idx + query.length + 40);
        const snippet = (start > 0 ? "..." : "") + m.content.slice(start, end) + (end < m.content.length ? "..." : "");
        return { id: m.id, role: m.role, snippet, time: m.createdAt };
      });
  }, [query, messages]);

  // Update highlight whenever query changes
  useEffect(() => { onHighlight(query); }, [query, onHighlight]);

  const navigateResult = (dir: number) => {
    if (results.length === 0) return;
    const next = (matchIndex + dir + results.length) % results.length;
    setMatchIndex(next);
    const el = document.getElementById(`msg-${results[next].id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="border-b border-[var(--border)] bg-[var(--bg-card)] px-4 py-2">
      <div className="flex items-center gap-2">
        <SearchIcon />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setMatchIndex(0); }}
          placeholder="Search messages..."
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-dimmest)]"
          onKeyDown={(e) => {
            if (e.key === "Escape") { onHighlight(""); onClose(); }
            if (e.key === "Enter" && !e.shiftKey) navigateResult(1);
            if (e.key === "Enter" && e.shiftKey) navigateResult(-1);
          }}
        />
        {query.trim() && results.length > 0 && (
          <span className="shrink-0 text-[11px] text-[var(--text-dim)]">{matchIndex + 1}/{results.length}</span>
        )}
        <button onClick={() => navigateResult(-1)} className="text-[var(--text-dim)] transition hover:text-[var(--text-muted)]" title="Previous">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M5 2L1.5 6h7z" /></svg>
        </button>
        <button onClick={() => navigateResult(1)} className="text-[var(--text-dim)] transition hover:text-[var(--text-muted)]" title="Next">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M5 8L1.5 4h7z" /></svg>
        </button>
        <button onClick={() => { onHighlight(""); onClose(); }} className="text-[var(--text-dim)] transition hover:text-[var(--text-muted)]"><XIcon /></button>
      </div>
    </div>
  );
}

/** Highlight search matches in text */
function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="rounded bg-amber-400/30 text-amber-200 px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

/* ── Diff viewer component ── */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function DiffViewer({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLen = Math.max(oldLines.length, newLines.length);
  const lines: Array<{ type: "same" | "removed" | "added"; content: string }> = [];

  // Simple diff: line-by-line comparison
  let oi = 0, ni = 0;
  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      lines.push({ type: "same", content: oldLines[oi] });
      oi++; ni++;
    } else if (oi < oldLines.length && (ni >= newLines.length || !newLines.slice(ni, ni + 3).includes(oldLines[oi]))) {
      lines.push({ type: "removed", content: oldLines[oi] });
      oi++;
    } else if (ni < newLines.length) {
      lines.push({ type: "added", content: newLines[ni] });
      ni++;
    }
  }

  // Only show context around changes (3 lines before/after)
  const diffLines: typeof lines = [];
  const changeIndices = new Set<number>();
  lines.forEach((line, i) => { if (line.type !== "same") changeIndices.add(i); });
  lines.forEach((_, i) => {
    for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
      if (changeIndices.has(j)) { changeIndices.add(i); break; }
    }
  });

  let lastShown = -1;
  for (let i = 0; i < lines.length; i++) {
    if (changeIndices.has(i) || lines[i].type !== "same") {
      if (lastShown >= 0 && i > lastShown + 1) {
        diffLines.push({ type: "same", content: `@@ ... @@` });
      }
      diffLines.push(lines[i]);
      lastShown = i;
    }
  }
  void maxLen;

  return (
    <div className="max-h-[300px] overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-code)] font-mono text-[11px]">
      {diffLines.map((line, i) => (
        <div
          key={i}
          className={`px-3 py-0.5 ${
            line.type === "removed" ? "bg-red-500/10 text-red-400/80" :
            line.type === "added" ? "bg-emerald-500/10 text-emerald-400/80" :
            line.content.startsWith("@@") ? "text-[var(--text-dim)] italic" : "text-[var(--text-dim)]"
          }`}
        >
          <span className="mr-2 inline-block w-3 text-[var(--text-dimmer)]">
            {line.type === "removed" ? "-" : line.type === "added" ? "+" : " "}
          </span>
          {line.content}
        </div>
      ))}
    </div>
  );
}

/* ── Right Sidebar Components ── */

function RightSidebarFileView({ filePath, content, onClose }: { filePath: string; content: string; onClose: () => void }) {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const isError = content.startsWith("Error:");
  let highlighted = content;
  if (!isError) {
    try {
      if (ext && hljs.getLanguage(ext)) {
        highlighted = hljs.highlight(content, { language: ext }).value;
      } else {
        highlighted = hljs.highlightAuto(content).value;
      }
    } catch { /* use raw */ }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <FileIcon name={filePath} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-label)]">{filePath}</span>
        <button onClick={onClose} className="text-[var(--text-dim)] transition hover:text-[var(--text-muted)]"><XIcon /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {isError ? (
          <div className="p-4 text-[12px] text-red-400">{content}</div>
        ) : (
          <pre className="p-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            <code dangerouslySetInnerHTML={{ __html: highlighted }} />
          </pre>
        )}
      </div>
    </div>
  );
}

/** Build a tree of changed files grouped by directory */
function buildDiffTree(diffs: GitDiffEntry[]): Array<{ dir: string; files: GitDiffEntry[] }> {
  const dirMap = new Map<string, GitDiffEntry[]>();
  for (const d of diffs) {
    const slash = d.file.lastIndexOf("/");
    const dir = slash >= 0 ? d.file.slice(0, slash) : ".";
    if (!dirMap.has(dir)) dirMap.set(dir, []);
    dirMap.get(dir)!.push(d);
  }
  // Sort dirs: root first, then alphabetical
  return Array.from(dirMap.entries())
    .sort(([a], [b]) => { if (a === ".") return -1; if (b === ".") return 1; return a.localeCompare(b); })
    .map(([dir, files]) => ({ dir, files: files.sort((a, b) => a.file.localeCompare(b.file)) }));
}

function DiffStatusBadge({ status }: { status: string }) {
  const cfg = status === "added" || status === "untracked"
    ? { letter: "A", bg: "bg-emerald-500/15", text: "text-emerald-400", border: "border-emerald-500/20" }
    : status === "deleted"
      ? { letter: "D", bg: "bg-red-500/15", text: "text-red-400", border: "border-red-500/20" }
      : status === "renamed"
        ? { letter: "R", bg: "bg-blue-500/15", text: "text-blue-400", border: "border-blue-500/20" }
        : { letter: "M", bg: "bg-amber-500/15", text: "text-amber-400", border: "border-amber-500/20" };
  return (
    <span className={`inline-flex h-[16px] w-[16px] items-center justify-center rounded border text-[9px] font-bold ${cfg.bg} ${cfg.text} ${cfg.border}`}>
      {cfg.letter}
    </span>
  );
}

/** Parse diff hunk header like @@ -10,6 +12,8 @@ to extract line numbers */
function parseDiffLines(diff: string): Array<{ type: "header" | "add" | "remove" | "context" | "meta"; content: string; oldLine?: number; newLine?: number }> {
  const lines = diff.split("\n");
  const result: Array<{ type: "header" | "add" | "remove" | "context" | "meta"; content: string; oldLine?: number; newLine?: number }> = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
        result.push({ type: "header", content: match[3]?.trim() || "" });
      }
    } else if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
      // Skip meta lines
    } else if (line.startsWith("+")) {
      result.push({ type: "add", content: line.slice(1), newLine });
      newLine++;
    } else if (line.startsWith("-")) {
      result.push({ type: "remove", content: line.slice(1), oldLine });
      oldLine++;
    } else {
      result.push({ type: "context", content: line.startsWith(" ") ? line.slice(1) : line, oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }
  return result;
}

function RightSidebarDiffView({ diffs, onClose }: { diffs: GitDiffEntry[]; onClose: () => void }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(diffs[0]?.file ?? null);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const activeDiff = diffs.find((d) => d.file === selectedFile);
  const tree = useMemo(() => buildDiffTree(diffs), [diffs]);

  const toggleDir = (dir: string) => {
    setCollapsedDirs((prev) => { const next = new Set(prev); if (next.has(dir)) next.delete(dir); else next.add(dir); return next; });
  };

  const fileName = (path: string) => { const i = path.lastIndexOf("/"); return i >= 0 ? path.slice(i + 1) : path; };

  const diffLines = useMemo(() => activeDiff?.diff ? parseDiffLines(activeDiff.diff) : [], [activeDiff]);

  // Count additions/deletions
  const addCount = diffs.filter((d) => d.status === "added" || d.status === "untracked").length;
  const modCount = diffs.filter((d) => d.status === "modified").length;
  const delCount = diffs.filter((d) => d.status === "deleted").length;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-muted)]">
          <path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span className="min-w-0 flex-1 text-[12px] font-medium text-[var(--text-secondary)]">Changes</span>
        <div className="flex items-center gap-1.5 text-[10px]">
          {modCount > 0 && <span className="text-amber-400">{modCount}M</span>}
          {addCount > 0 && <span className="text-emerald-400">+{addCount}</span>}
          {delCount > 0 && <span className="text-red-400">-{delCount}</span>}
        </div>
        <button onClick={onClose} className="text-[var(--text-dim)] transition hover:text-[var(--text-muted)]"><XIcon /></button>
      </div>

      {diffs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[var(--text-dimmest)]">
            <path d="M9 11l3 3L22 4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[12px] text-[var(--text-dim)]">Working tree clean</span>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* File tree */}
          <div className="shrink-0 overflow-auto border-b border-[var(--border-subtle)]" style={{ maxHeight: "40%" }}>
            {tree.map(({ dir, files }) => (
              <div key={dir}>
                {/* Directory header */}
                {dir !== "." && (
                  <button
                    onClick={() => toggleDir(dir)}
                    className="flex w-full items-center gap-1.5 px-2.5 py-[5px] text-left text-[10px] text-[var(--text-dim)] transition hover:bg-[var(--bg-card)]"
                  >
                    <svg width="6" height="6" viewBox="0 0 6 6" fill="currentColor" className={`shrink-0 text-[var(--text-dimmer)] transition-transform ${collapsedDirs.has(dir) ? "" : "rotate-90"}`}>
                      <path d="M1.5 0.5l3 2.5-3 2.5z" />
                    </svg>
                    <FolderIcon open={!collapsedDirs.has(dir)} />
                    <span className="truncate font-medium">{dir}</span>
                    <span className="ml-auto text-[9px] text-[var(--text-dimmer)]">{files.length}</span>
                  </button>
                )}
                {/* Files in this directory */}
                {!collapsedDirs.has(dir) && files.map((d) => (
                  <button
                    key={d.file}
                    onClick={() => setSelectedFile(d.file)}
                    className={`flex w-full items-center gap-2 py-[4px] text-left text-[11px] transition ${
                      dir === "." ? "px-2.5" : "pl-7 pr-2.5"
                    } ${d.file === selectedFile ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:bg-[var(--bg-card)] hover:text-[var(--text-secondary)]"}`}
                  >
                    <DiffStatusBadge status={d.status} />
                    <FileIcon name={fileName(d.file)} />
                    <span className="min-w-0 truncate">{fileName(d.file)}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* Diff content */}
          <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg-input)]">
            {activeDiff ? (
              <>
                {/* File header bar */}
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5">
                  <FileIcon name={fileName(activeDiff.file)} />
                  <span className="min-w-0 truncate text-[11px] text-[var(--text-label)]">{activeDiff.file}</span>
                  <DiffStatusBadge status={activeDiff.status} />
                </div>
                {/* Diff lines */}
                {diffLines.length > 0 ? (
                  <div className="font-mono text-[11px] leading-[18px]">
                    {diffLines.map((line, i) => {
                      if (line.type === "header") {
                        return (
                          <div key={i} className="flex items-center border-y border-[var(--border-subtle)] bg-[var(--bg-diff-header)]/60 px-3 py-1 text-[10px] text-blue-400/60 italic">
                            <span>{line.content || "..."}</span>
                          </div>
                        );
                      }
                      const bgCls = line.type === "add" ? "bg-emerald-500/8" : line.type === "remove" ? "bg-red-500/8" : "";
                      const textCls = line.type === "add" ? "text-emerald-300/80" : line.type === "remove" ? "text-red-300/80" : "text-[var(--text-dim)]";
                      const gutterCls = line.type === "add" ? "text-emerald-500/40" : line.type === "remove" ? "text-red-500/40" : "text-[var(--text-dimmest)]";
                      const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
                      const markerCls = line.type === "add" ? "text-emerald-400/60" : line.type === "remove" ? "text-red-400/60" : "text-transparent";
                      return (
                        <div key={i} className={`flex ${bgCls}`}>
                          <span className={`w-[38px] shrink-0 select-none border-r border-[var(--border-subtle)] pr-1 text-right text-[10px] leading-[18px] ${gutterCls}`}>
                            {line.type !== "add" ? line.oldLine : ""}
                          </span>
                          <span className={`w-[38px] shrink-0 select-none border-r border-[var(--border-subtle)] pr-1 text-right text-[10px] leading-[18px] ${gutterCls}`}>
                            {line.type !== "remove" ? line.newLine : ""}
                          </span>
                          <span className={`w-4 shrink-0 select-none text-center ${markerCls}`}>{marker}</span>
                          <span className={`min-w-0 flex-1 whitespace-pre-wrap break-all pr-2 ${textCls}`}>{line.content || " "}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="p-4 text-center text-[11px] text-[var(--text-dim)]">
                    {activeDiff.status === "untracked" ? (
                      <pre className="whitespace-pre-wrap text-left text-[var(--text-dim)]">{activeDiff.diff || "(empty file)"}</pre>
                    ) : (
                      "No diff available"
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-[12px] text-[var(--text-dimmer)]">Select a file to view changes</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RightSidebarSubAgent({ msg, onClose }: { msg: ThreadMessage; onClose: () => void }) {
  const pending = msg.metadata?.pending === true;
  const taskType = msg.metadata?.taskType || "general";
  const description = msg.metadata?.taskDescription || msg.metadata?.toolDetail || "Task";
  const duration = msg.metadata?.taskDurationMs;
  const trail = msg.metadata?.taskTrail || [];
  const result = msg.content;

  const typeBadge = taskType === "explore"
    ? { label: "explore", color: "text-cyan-400 border-cyan-400/30 bg-cyan-400/5" }
    : { label: "general", color: "text-orange-400 border-orange-400/30 bg-orange-400/5" };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <div className={`h-2 w-2 shrink-0 rounded-full ${pending ? "bg-amber-400/80 animate-pulse" : "bg-emerald-500/70"}`} />
        <span className="min-w-0 flex-1 text-[12px] font-medium text-[var(--text-label)]">{description}</span>
        <span className={`rounded border px-1.5 py-px text-[9px] font-medium ${typeBadge.color}`}>{typeBadge.label}</span>
        <button onClick={onClose} className="text-[var(--text-dim)] transition hover:text-[var(--text-muted)]"><XIcon /></button>
      </div>

      {/* Trail */}
      {trail.length > 0 && (
        <div className="border-b border-[var(--border-subtle)] px-3 py-2">
          <div className="text-[10px] font-medium text-[var(--text-dim)] mb-1.5">Activity Trail</div>
          <div className="space-y-1 max-h-[200px] overflow-auto">
            {trail.map((entry, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <div className={`h-1 w-1 rounded-full ${entry.type === "tool" ? "bg-blue-400/70" : "bg-[var(--text-dim)]"}`} />
                <span className="text-[var(--text-muted)] truncate">{entry.summary}</span>
                <span className="ml-auto shrink-0 text-[9px] text-[var(--text-dimmest)]">{new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Status */}
      <div className="px-3 py-2 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-[var(--text-dim)]">Status:</span>
          <span className={pending ? "text-amber-400" : "text-emerald-400"}>{pending ? "Running" : "Completed"}</span>
          {!pending && duration !== undefined && (
            <span className="ml-auto text-[10px] text-[var(--text-dimmer)]">{formatDuration(duration)}</span>
          )}
        </div>
      </div>

      {/* Result */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {pending ? (
          <div className="flex items-center gap-2">
            <div className="flex gap-[3px]">
              <div className="h-1 w-1 animate-bounce rounded-full bg-[var(--text-dimmer)]" style={{ animationDelay: "0ms" }} />
              <div className="h-1 w-1 animate-bounce rounded-full bg-[var(--text-dimmer)]" style={{ animationDelay: "150ms" }} />
              <div className="h-1 w-1 animate-bounce rounded-full bg-[var(--text-dimmer)]" style={{ animationDelay: "300ms" }} />
            </div>
            <span className="text-[11px] text-[var(--text-dimmer)]">Sub-agent working...</span>
          </div>
        ) : result ? (
          <div className="text-[12px] leading-relaxed text-[var(--text-muted)]">
            <Markdown content={result} />
          </div>
        ) : (
          <div className="text-[12px] text-[var(--text-dim)]">No result yet</div>
        )}
      </div>
    </div>
  );
}

/* ── Todo UI Component ── */

function TodoPanel({ todos, onToggle, onRemove, onAdd }: {
  todos: TodoItem[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (content: string) => void;
}) {
  const [input, setInput] = useState("");
  if (todos.length === 0 && !input) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;

  return (
    <div className="mb-2 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] overflow-hidden">
      {/* Header with progress */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border-subtle)]">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-dim)]">
          <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
        <span className="text-[11px] font-medium text-[var(--text-muted)]">Tasks</span>
        {total > 0 && (
          <span className="text-[10px] text-[var(--text-dim)]">{completed}/{total}</span>
        )}
        {total > 0 && (
          <div className="ml-auto h-1 w-16 rounded-full bg-[var(--bg-user-bubble)]">
            <div className="h-1 rounded-full bg-emerald-500/60 transition-all" style={{ width: `${(completed / total) * 100}%` }} />
          </div>
        )}
      </div>

      {/* Todo items */}
      <div className="max-h-[120px] overflow-auto">
        {todos.map((todo) => (
          <div key={todo.id} className="flex items-center gap-2 px-3 py-1 hover:bg-[var(--bg-card)] group">
            <button onClick={() => onToggle(todo.id)} className="shrink-0">
              {todo.status === "completed" ? (
                <svg width="12" height="12" viewBox="0 0 12 12" className="text-emerald-500/70"><rect x="0.5" y="0.5" width="11" height="11" rx="2" fill="currentColor" stroke="currentColor" /><path d="M3 6l2 2 4-4" stroke="var(--check-mark)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12" className="text-[var(--text-dimmer)]"><rect x="0.5" y="0.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" /></svg>
              )}
            </button>
            <span className={`flex-1 text-[11px] ${todo.status === "completed" ? "text-[var(--text-dim)] line-through" : "text-[var(--text-label)]"}`}>{todo.content}</span>
            <button onClick={() => onRemove(todo.id)} className="hidden text-[var(--text-dimmer)] transition hover:text-red-400 group-hover:block shrink-0">
              <XIcon />
            </button>
          </div>
        ))}
      </div>

      {/* Add todo input */}
      <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] px-3 py-1.5">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) {
              onAdd(input.trim());
              setInput("");
            }
          }}
          placeholder="Add a task..."
          className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--text-label)] outline-none placeholder:text-[var(--text-dimmest)]"
        />
        {input.trim() && (
          <button onClick={() => { onAdd(input.trim()); setInput(""); }} className="text-[10px] text-[var(--text-dim)] hover:text-[var(--text-muted)]">Add</button>
        )}
      </div>
    </div>
  );
}

/* ── Thinking Level Picker ── */

function ThinkingLevelPicker({ level, provider, onChange }: { level: string; provider: string; onChange: (level: ThinkingLevel) => void }) {
  const [open, setOpen] = useState(false);

  // Anthropic caps at "high", Codex can go to "xhigh"
  const levels: Array<{ id: string; label: string; maxProvider?: string }> = [
    { id: "none", label: "Off" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Med" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "X-High", maxProvider: "codex" },
  ];

  const available = levels.filter((l) => !l.maxProvider || l.maxProvider === provider);
  const current = levels.find((l) => l.id === level) ?? levels[0];

  const levelColor = level === "none" ? "text-[var(--text-dim)]" :
    level === "low" ? "text-blue-400/80" :
    level === "medium" ? "text-amber-400/80" :
    level === "high" ? "text-orange-400/80" :
    "text-red-400/80";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded-md px-2 py-1 text-[12px] transition hover:bg-[var(--bg-active)] hover:text-[var(--text-muted)] ${levelColor}`}
        title="Thinking / reasoning level"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
          <line x1="9" y1="21" x2="15" y2="21" />
        </svg>
        {current.label}
        <ChevronIcon open={open} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-1 w-36 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] py-1 shadow-xl shadow-black/40">
            {available.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => { onChange(l.id as ThinkingLevel); setOpen(false); }}
                className={`flex w-full items-center justify-between px-3 py-[6px] text-left text-[12px] transition hover:bg-[var(--bg-active)] ${l.id === level ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}
              >
                <span>{l.label}</span>
                {l.id !== "none" && (
                  <span className={`text-[9px] ${
                    l.id === "low" ? "text-blue-400/60" :
                    l.id === "medium" ? "text-amber-400/60" :
                    l.id === "high" ? "text-orange-400/60" :
                    "text-red-400/60"
                  }`}>
                    {l.id === "xhigh" ? "Codex only" : ""}
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Onboarding ── */

type OnboardingStep = "welcome" | "provider" | "auth" | "apikey" | "subscription" | "complete";
type OnboardingAuthMode = "apikey" | "subscription";

function OnboardingModal({
  onSaveCredential,
  onComplete,
}: {
  onSaveCredential: (providerId: string, credential: string) => Promise<void>;
  onComplete: () => void;
}) {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>("anthropic");
  const [authMode, setAuthMode] = useState<OnboardingAuthMode>("subscription");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // OAuth states
  const [oauthCode, setOauthCode] = useState("");
  const [oauthWaiting, setOauthWaiting] = useState(false);
  const [codexDevice, setCodexDevice] = useState<{ userCode: string; deviceAuthId: string } | null>(null);

  async function handleSaveKey() {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError("");
    try {
      await onSaveCredential(selectedProvider, apiKey.trim());
      setStep("complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save credential");
    } finally {
      setSaving(false);
    }
  }

  async function handleAnthropicOAuth() {
    setError("");
    try {
      await window.sncode.oauthAnthropicStart();
      setOauthWaiting(true);
    } catch {
      setError("Failed to start sign-in flow");
    }
  }

  async function handleAnthropicExchange() {
    if (!oauthCode.trim()) return;
    setSaving(true);
    setError("");
    try {
      await window.sncode.oauthAnthropicExchange(oauthCode.trim());
      setStep("complete");
    } catch {
      setError("Invalid authorization code. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleCodexOAuth() {
    setError("");
    try {
      const result = await window.sncode.oauthCodexStart();
      setCodexDevice({ userCode: result.userCode, deviceAuthId: result.deviceAuthId });
      // Start polling in background
      window.sncode.oauthCodexPoll({ deviceAuthId: result.deviceAuthId, userCode: result.userCode })
        .then(() => { setStep("complete"); setCodexDevice(null); })
        .catch(() => { setError("Authorization failed or timed out."); setCodexDevice(null); });
    } catch {
      setError("Failed to start device authorization");
    }
  }

  const providerLabel = selectedProvider === "anthropic" ? "Anthropic" : "OpenAI";
  const subscriptionLabel = selectedProvider === "anthropic" ? "Claude Pro / Max" : "ChatGPT Plus / Pro";

  return (
    <div className="flex h-screen items-center justify-center bg-[var(--bg-base)]">
      <div className="w-[460px] rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-8 shadow-2xl shadow-black/40">

        {/* Step: Welcome */}
        {step === "welcome" && (
          <div className="text-center">
            <div className="mb-1 text-[28px] font-bold tracking-tight">
              <span className="text-[var(--brand-sn)]">Sn</span><span className="text-[var(--brand-code)]">Code</span>
            </div>
            <p className="mb-6 text-[13px] text-[var(--text-dim)]">AI-powered coding agent for your desktop</p>

            <div className="mb-8 space-y-3 text-left">
              <div className="flex items-start gap-3 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 py-3">
                <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--bg-user-bubble)] text-[var(--text-muted)]">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                </div>
                <div>
                  <div className="text-[13px] font-medium text-[var(--text-heading)]">Powerful AI agent</div>
                  <div className="text-[11px] text-[var(--text-dim)]">Read, write, edit files, run commands, and more</div>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 py-3">
                <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--bg-user-bubble)] text-[var(--text-muted)]">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                </div>
                <div>
                  <div className="text-[13px] font-medium text-[var(--text-heading)]">Multi-model support</div>
                  <div className="text-[11px] text-[var(--text-dim)]">Claude (Anthropic) and Codex (OpenAI) models</div>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-surface)] px-4 py-3">
                <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--bg-user-bubble)] text-[var(--text-muted)]">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                </div>
                <div>
                  <div className="text-[13px] font-medium text-[var(--text-heading)]">Secure by default</div>
                  <div className="text-[11px] text-[var(--text-dim)]">Credentials stored in your OS keychain</div>
                </div>
              </div>
            </div>

            <button
              onClick={() => setStep("provider")}
              className="w-full rounded-xl bg-[var(--bg-accent)] px-4 py-2.5 text-[13px] font-medium text-[var(--text-on-accent)] transition hover:bg-[var(--bg-accent-hover)]"
            >
              Get started
            </button>
            <button
              onClick={onComplete}
              className="mt-3 w-full rounded-xl px-4 py-2 text-[12px] text-[var(--text-dim)] transition hover:text-[var(--text-muted)]"
            >
              Skip for now
            </button>
          </div>
        )}

        {/* Step: Pick provider */}
        {step === "provider" && (
          <div>
            <button onClick={() => setStep("welcome")} className="mb-4 flex items-center gap-1 text-[12px] text-[var(--text-dim)] transition hover:text-[var(--text-muted)]">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M7 1L3 5l4 4z"/></svg>
              Back
            </button>
            <h2 className="mb-1 text-[16px] font-semibold text-[var(--text-primary)]">Choose a provider</h2>
            <p className="mb-5 text-[12px] text-[var(--text-dim)]">Select which AI provider you want to use. You can add more later in Settings.</p>

            <div className="mb-6 space-y-2">
              <button
                onClick={() => setSelectedProvider("anthropic")}
                className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition ${
                  selectedProvider === "anthropic"
                    ? "border-[var(--border-active)] bg-[var(--bg-elevated)]"
                    : "border-[var(--border-strong)] bg-[var(--bg-surface)] hover:border-[var(--border-active)]"
                }`}
              >
                <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${selectedProvider === "anthropic" ? "bg-[var(--bg-stop)] text-white" : "bg-[var(--bg-user-bubble)] text-[var(--text-muted)]"}`}>
                  <span className="text-[14px] font-bold">A</span>
                </div>
                <div className="flex-1">
                  <div className="text-[13px] font-medium text-[var(--text-heading)]">Anthropic</div>
                  <div className="text-[11px] text-[var(--text-dim)]">Claude Opus, Sonnet, and Haiku models</div>
                </div>
                {selectedProvider === "anthropic" && (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5"/><path d="M4 7l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                )}
              </button>
              <button
                onClick={() => setSelectedProvider("codex")}
                className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition ${
                  selectedProvider === "codex"
                    ? "border-[var(--border-active)] bg-[var(--bg-elevated)]"
                    : "border-[var(--border-strong)] bg-[var(--bg-surface)] hover:border-[var(--border-active)]"
                }`}
              >
                <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${selectedProvider === "codex" ? "bg-[var(--bg-stop)] text-white" : "bg-[var(--bg-user-bubble)] text-[var(--text-muted)]"}`}>
                  <span className="text-[14px] font-bold">O</span>
                </div>
                <div className="flex-1">
                  <div className="text-[13px] font-medium text-[var(--text-heading)]">OpenAI</div>
                  <div className="text-[11px] text-[var(--text-dim)]">Codex 5.3 and Codex Mini models</div>
                </div>
                {selectedProvider === "codex" && (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5"/><path d="M4 7l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                )}
              </button>
            </div>

            <button
              onClick={() => setStep("auth")}
              className="w-full rounded-xl bg-[var(--bg-accent)] px-4 py-2.5 text-[13px] font-medium text-[var(--text-on-accent)] transition hover:bg-[var(--bg-accent-hover)]"
            >
              Continue
            </button>
          </div>
        )}

        {/* Step: Choose auth mode */}
        {step === "auth" && (
          <div>
            <button onClick={() => setStep("provider")} className="mb-4 flex items-center gap-1 text-[12px] text-[var(--text-dim)] transition hover:text-[var(--text-muted)]">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M7 1L3 5l4 4z"/></svg>
              Back
            </button>
            <h2 className="mb-1 text-[16px] font-semibold text-[var(--text-primary)]">How do you want to sign in?</h2>
            <p className="mb-5 text-[12px] text-[var(--text-dim)]">Choose how to authenticate with {providerLabel}.</p>

            <div className="mb-6 space-y-2">
              <button
                onClick={() => setAuthMode("subscription")}
                className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3.5 text-left transition ${
                  authMode === "subscription"
                    ? "border-[var(--border-active)] bg-[var(--bg-elevated)]"
                    : "border-[var(--border-strong)] bg-[var(--bg-surface)] hover:border-[var(--border-active)]"
                }`}
              >
                <div className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${authMode === "subscription" ? "bg-[var(--bg-stop)] text-white" : "bg-[var(--bg-user-bubble)] text-[var(--text-muted)]"}`}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                </div>
                <div className="flex-1">
                  <div className="text-[13px] font-medium text-[var(--text-heading)]">Sign in with subscription</div>
                  <div className="text-[11px] text-[var(--text-dim)]">Use your {subscriptionLabel} subscription</div>
                </div>
                {authMode === "subscription" && (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="mt-0.5"><circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5"/><path d="M4 7l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                )}
              </button>
              <button
                onClick={() => setAuthMode("apikey")}
                className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3.5 text-left transition ${
                  authMode === "apikey"
                    ? "border-[var(--border-active)] bg-[var(--bg-elevated)]"
                    : "border-[var(--border-strong)] bg-[var(--bg-surface)] hover:border-[var(--border-active)]"
                }`}
              >
                <div className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${authMode === "apikey" ? "bg-[var(--bg-stop)] text-white" : "bg-[var(--bg-user-bubble)] text-[var(--text-muted)]"}`}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                </div>
                <div className="flex-1">
                  <div className="text-[13px] font-medium text-[var(--text-heading)]">API key</div>
                  <div className="text-[11px] text-[var(--text-dim)]">Paste an API key from the developer console</div>
                </div>
                {authMode === "apikey" && (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="mt-0.5"><circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5"/><path d="M4 7l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                )}
              </button>
            </div>

            <button
              onClick={() => setStep(authMode === "apikey" ? "apikey" : "subscription")}
              className="w-full rounded-xl bg-[var(--bg-accent)] px-4 py-2.5 text-[13px] font-medium text-[var(--text-on-accent)] transition hover:bg-[var(--bg-accent-hover)]"
            >
              Continue
            </button>
          </div>
        )}

        {/* Step: Subscription OAuth */}
        {step === "subscription" && (
          <div>
            <button onClick={() => { setStep("auth"); setOauthWaiting(false); setOauthCode(""); setCodexDevice(null); setError(""); }} className="mb-4 flex items-center gap-1 text-[12px] text-[var(--text-dim)] transition hover:text-[var(--text-muted)]">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M7 1L3 5l4 4z"/></svg>
              Back
            </button>
            <h2 className="mb-1 text-[16px] font-semibold text-[var(--text-primary)]">
              Sign in with {subscriptionLabel}
            </h2>

            {selectedProvider === "anthropic" ? (
              /* Anthropic: PKCE code flow */
              <div>
                {!oauthWaiting ? (
                  <>
                    <p className="mb-5 text-[12px] text-[var(--text-dim)]">
                      Sign in with your Claude account. A browser window will open for you to authorize SnCode.
                    </p>
                    {error && <p className="mb-3 text-[11px] text-red-400">{error}</p>}
                    <button
                      onClick={handleAnthropicOAuth}
                      className="w-full rounded-xl bg-[var(--bg-accent)] px-4 py-2.5 text-[13px] font-medium text-[var(--text-on-accent)] transition hover:bg-[var(--bg-accent-hover)]"
                    >
                      Sign in with Claude
                    </button>
                  </>
                ) : (
                  <>
                    <p className="mb-4 text-[12px] text-[var(--text-dim)]">
                      Complete sign-in in your browser, then paste the authorization code below.
                    </p>
                    {error && <p className="mb-3 text-[11px] text-red-400">{error}</p>}
                    <div className="mb-4 flex gap-2">
                      <input
                        type="text"
                        value={oauthCode}
                        onChange={(e) => { setOauthCode(e.target.value); setError(""); }}
                        onKeyDown={(e) => { if (e.key === "Enter" && oauthCode.trim()) void handleAnthropicExchange(); }}
                        placeholder="Paste authorization code..."
                        autoFocus
                        className="min-w-0 flex-1 rounded-lg border border-[var(--border-active)] bg-[var(--bg-base)] px-3 py-2.5 font-mono text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-dimmest)] focus:border-[var(--text-dim)]"
                      />
                      <button
                        onClick={handleAnthropicExchange}
                        disabled={!oauthCode.trim() || saving}
                        className="shrink-0 rounded-lg bg-[var(--bg-accent)] px-4 py-2.5 text-[12px] font-medium text-[var(--text-on-accent)] transition hover:bg-[var(--bg-accent-hover)] disabled:opacity-30"
                      >
                        {saving ? "..." : "Confirm"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              /* Codex: Device code flow */
              <div>
                {!codexDevice ? (
                  <>
                    <p className="mb-5 text-[12px] text-[var(--text-dim)]">
                      Sign in with your ChatGPT account. A browser window will open for you to authorize SnCode.
                    </p>
                    {error && <p className="mb-3 text-[11px] text-red-400">{error}</p>}
                    <button
                      onClick={handleCodexOAuth}
                      className="w-full rounded-xl bg-[var(--bg-accent)] px-4 py-2.5 text-[13px] font-medium text-[var(--text-on-accent)] transition hover:bg-[var(--bg-accent-hover)]"
                    >
                      Sign in with ChatGPT
                    </button>
                  </>
                ) : (
                  <>
                    <p className="mb-4 text-[12px] text-[var(--text-dim)]">
                      Enter this code on the page that opened in your browser:
                    </p>
                    <div className="mb-4 flex items-center justify-center rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] py-4">
                      <span className="font-mono text-[22px] font-bold tracking-[0.3em] text-[var(--text-primary)]">{codexDevice.userCode}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 animate-pulse rounded-full bg-amber-400/80" />
                      <span className="text-[12px] text-[var(--text-dim)]">Waiting for authorization...</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step: Enter API key */}
        {step === "apikey" && (
          <div>
            <button onClick={() => setStep("auth")} className="mb-4 flex items-center gap-1 text-[12px] text-[var(--text-dim)] transition hover:text-[var(--text-muted)]">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M7 1L3 5l4 4z"/></svg>
              Back
            </button>
            <h2 className="mb-1 text-[16px] font-semibold text-[var(--text-primary)]">
              Enter your {providerLabel} API key
            </h2>
            <p className="mb-4 text-[12px] text-[var(--text-dim)]">
              Your key is stored securely in your OS keychain and never sent anywhere except to {providerLabel}.
            </p>

            <div className="mb-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter" && apiKey.trim()) void handleSaveKey(); }}
                placeholder={selectedProvider === "anthropic" ? "sk-ant-..." : "sk-..."}
                className="w-full rounded-lg border border-[var(--border-active)] bg-[var(--bg-base)] px-3.5 py-2.5 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-dimmest)] focus:border-[var(--text-dim)]"
                autoFocus
              />
            </div>

            {error && (
              <p className="mb-2 text-[11px] text-red-400">{error}</p>
            )}

            <a
              href="#"
              onClick={(e) => { e.preventDefault(); void window.sncode.openExternal(API_KEY_URLS[selectedProvider] || ""); }}
              className="mb-5 inline-block text-[11px] text-[var(--text-dim)] underline decoration-[var(--text-dimmest)] transition hover:text-[var(--text-muted)]"
            >
              Get an API key from {selectedProvider === "anthropic" ? "console.anthropic.com" : "platform.openai.com"}
            </a>

            <button
              onClick={handleSaveKey}
              disabled={!apiKey.trim() || saving}
              className="w-full rounded-xl bg-[var(--bg-accent)] px-4 py-2.5 text-[13px] font-medium text-[var(--text-on-accent)] transition hover:bg-[var(--bg-accent-hover)] disabled:opacity-30"
            >
              {saving ? "Saving..." : "Save & continue"}
            </button>
          </div>
        )}

        {/* Step: Complete */}
        {step === "complete" && (
          <div className="text-center">
            <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-emerald-500/10">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5"/>
              </svg>
            </div>
            <h2 className="mb-1 text-[16px] font-semibold text-[var(--text-primary)]">You&apos;re all set!</h2>
            <p className="mb-6 text-[13px] text-[var(--text-dim)]">
              {providerLabel} has been configured. You can add more providers anytime from Settings.
            </p>

            <button
              onClick={onComplete}
              className="w-full rounded-xl bg-[var(--bg-accent)] px-4 py-2.5 text-[13px] font-medium text-[var(--text-on-accent)] transition hover:bg-[var(--bg-accent-hover)]"
            >
              Start coding
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── App ── */

export default function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [selProjectId, setSelProjectId] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [selThreadId, setSelThreadId] = useState<string | null>(null);
  const [msgInput, setMsgInput] = useState("");
  const [statusText, setStatusText] = useState("Idle");
  const [runningThreads, setRunningThreads] = useState<Set<string>>(new Set());
  const [booting, setBooting] = useState(true);
  const [streamChunk, setStreamChunk] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; threadId: string } | null>(null);
  const [showFileTree, setShowFileTree] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [permission, setPermission] = useState<PermissionMode>("full");
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [gitBranches, setGitBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState("");
  const [gitStatus, setGitStatus] = useState<GitStatusInfo>({ changes: 0, staged: 0, isRepo: false });
  // Right sidebar state
  const [rightSidebar, setRightSidebar] = useState<{
    type: "file" | "diff" | "subagent";
    filePath?: string;
    fileContent?: string;
    diffs?: GitDiffEntry[];
    taskMsg?: ThreadMessage;
  } | null>(null);
  // Git actions dropdown
  const [showGitActions, setShowGitActions] = useState(false);
  const [gitActionFeedback, setGitActionFeedback] = useState("");
  // Commit modal
  const [showCommitModal, setShowCommitModal] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  // Search highlight in messages
  const [searchHighlight, setSearchHighlight] = useState("");
  // Todo system
  const [todos, setTodos] = useState<TodoItem[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  // Derive isBusy for the currently selected thread
  const isBusy = selThreadId ? runningThreads.has(selThreadId) : false;
  const theme = state.settings.theme || "dark";

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const selProject = useMemo(() => state.projects.find((p) => p.id === selProjectId) ?? null, [state.projects, selProjectId]);
  const selThread = useMemo(() => state.threads.find((t) => t.id === selThreadId) ?? null, [state.threads, selThreadId]);
  const threadMessages = useMemo(() => state.messages.filter((m) => m.threadId === selThreadId), [state.messages, selThreadId]);

  /* ── effects ── */

  useEffect(() => {
    window.sncode.getState().then((next) => {
      setState(next);
      const p = next.projects[0];
      if (p) {
        setSelProjectId(p.id);
        setExpandedProjects(new Set([p.id]));
        const t = next.threads.find((th) => th.projectId === p.id);
        if (t) setSelThreadId(t.id);
      }
      setBooting(false);
    });
  }, []);

  // Agent events — status tracked globally, chunks/messages only for selected thread
  useEffect(() => {
    const off1 = window.sncode.on("agent:status", (e) => {
      // Always update the global running set regardless of selected thread
      setRunningThreads((prev) => {
        const next = new Set(prev);
        if (e.status === "running") next.add(e.threadId);
        else next.delete(e.threadId);
        return next;
      });
      // Only update UI text for the selected thread
      if (e.threadId === selThreadId) {
        setStatusText(e.detail);
        if (e.status !== "running") {
          setStreamChunk("");
          // Final refresh to reconcile state (thread title, messages, etc.)
          void refresh();
        }
      }
    });
    const off2 = window.sncode.on("agent:chunk", (e) => {
      if (e.threadId !== selThreadId) return;
      setStreamChunk((prev) => prev + e.chunk);
    });
    const off3 = window.sncode.on("agent:tool", () => {
      // Tool presence is now shown via pending tool messages — no separate indicator needed
    });
    // Real-time message insertion / update (intermediate text + tool results)
    const off4 = window.sncode.on("agent:message", (e) => {
      if (e.threadId !== selThreadId) return;
      setState((prev) => {
        const existingIdx = prev.messages.findIndex((m) => m.id === e.message.id);
        if (existingIdx >= 0) {
          // Update existing message (e.g. pending tool → completed)
          const updated = [...prev.messages];
          updated[existingIdx] = e.message;
          return { ...prev, messages: updated };
        }
        // Append new message
        return { ...prev, messages: [...prev.messages, e.message] };
      });
      // Clear streaming preview — the streamed text is now a stored message
      setStreamChunk("");
    });
    return () => { off1(); off2(); off3(); off4(); };
  }, [selThreadId]);

  // When switching threads: clear stale stream state and refresh messages from store
  useEffect(() => {
    setStreamChunk("");
    setStatusText(selThreadId && runningThreads.has(selThreadId) ? "Running" : "Idle");
    // Refresh to load any messages stored while we were on a different thread
    void refresh();
  }, [selThreadId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selProject) {
      setGitBranches([]);
      setCurrentBranch("");
      setGitStatus({ changes: 0, staged: 0, isRepo: false });
      return;
    }
    window.sncode.getGitBranches(selProject.folderPath).then((r) => { setGitBranches(r.branches); setCurrentBranch(r.current); });
    window.sncode.getGitStatus(selProject.folderPath).then(setGitStatus);
  }, [selProject]);

  useEffect(() => {
    const hasEnabled = state.providers.some((p) => p.enabled);
    if (hasEnabled) return;
    const avail = availableModels(state.providers);
    if (avail.length > 0) void pickModel(avail[0].id);
  }, [state.providers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Smart auto-scroll: only scroll to bottom if user is near the bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [threadMessages, streamChunk]);

  // Track scroll position to determine if user is near bottom
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const threshold = 120; // px from bottom
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  useEffect(() => {
    if (!isBusy && selProject) {
      window.sncode.getGitStatus(selProject.folderPath).then(setGitStatus);
    }
  }, [isBusy, selProject]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const ctrlOrCmd = e.ctrlKey || e.metaKey;
      if (ctrlOrCmd && e.key === "n") {
        e.preventDefault();
        if (selProject) void addThread(selProject);
      }
      if (ctrlOrCmd && e.key === "w") {
        e.preventDefault();
        if (selThreadId) void deleteThread(selThreadId);
      }
      if (ctrlOrCmd && e.key === "f") {
        e.preventDefault();
        setShowSearch((v) => !v);
      }
      if (ctrlOrCmd && e.key === "b") {
        e.preventDefault();
        setShowFileTree((v) => !v);
      }
      if (ctrlOrCmd && e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
      }
      if (e.key === "Escape") {
        if (showSearch) { setShowSearch(false); setSearchHighlight(""); }
        if (contextMenu) setContextMenu(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selProject, selThreadId, showSearch, contextMenu]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── actions ── */

  async function refresh() {
    const s = await window.sncode.getState();
    setState(s);
    return s;
  }

  async function addProject() {
    const folder = await window.sncode.pickFolder();
    if (!folder) return;
    const name = folder.split(/[\\/]/).pop() || "Project";
    const proj = await window.sncode.createProject({ name, folderPath: folder });
    await window.sncode.createThread({ projectId: proj.id, title: "New thread" });
    const next = await refresh();
    setSelProjectId(proj.id);
    setExpandedProjects((prev) => new Set(prev).add(proj.id));
    setSelThreadId(next.threads.find((th) => th.projectId === proj.id)?.id ?? null);
  }

  async function addThread(project: Project) {
    const t = await window.sncode.createThread({ projectId: project.id, title: "New thread" });
    await refresh();
    setSelThreadId(t.id);
  }

  async function deleteThread(threadId: string) {
    const next = await window.sncode.deleteThread(threadId);
    setState(next);
    if (selThreadId === threadId) {
      const remaining = next.threads.filter((t) => t.projectId === selProjectId);
      setSelThreadId(remaining[0]?.id ?? null);
    }
  }

  async function updateProvider(provider: ProviderConfig, updates: Partial<ProviderConfig>) {
    const providers = await window.sncode.updateProvider({ id: provider.id, enabled: updates.enabled, authMode: updates.authMode, model: updates.model });
    setState((prev) => ({ ...prev, providers }));
  }

  async function saveCredential(providerId: string, credential: string) {
    const providers = await window.sncode.setProviderCredential({ id: providerId as ProviderConfig["id"], credential });
    setState((prev) => ({ ...prev, providers }));
  }

  async function pickModel(modelId: string) {
    setShowModelPicker(false);
    const targetProvider = providerForModelId(modelId);
    if (!targetProvider) return;
    for (const p of state.providers) {
      if (p.id === targetProvider) await updateProvider(p, { enabled: true, model: modelId });
      else if (p.enabled) await updateProvider(p, { enabled: false });
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const hasText = msgInput.trim().length > 0;
    const hasImages = pendingImages.length > 0;
    if (!selThreadId || (!hasText && !hasImages) || isBusy) return;
    const content = msgInput.trim();
    const images = pendingImages.length > 0 ? [...pendingImages] : undefined;
    setMsgInput("");
    setPendingImages([]);
    setRunningThreads((prev) => new Set(prev).add(selThreadId));
    setStatusText("Running");
    setStreamChunk("");
    // Snap to bottom when user sends a message
    isNearBottomRef.current = true;
    try {
      const next = await window.sncode.sendMessage({ threadId: selThreadId, content, images });
      setState(next);
    } catch {
      setRunningThreads((prev) => { const next = new Set(prev); next.delete(selThreadId!); return next; });
      setStatusText("Error sending message");
    }
  }

  async function cancel() {
    if (!selThreadId) return;
    await window.sncode.cancelRun(selThreadId);
  }

  async function openFileInSidebar(relativePath: string) {
    if (!selProject) return;
    const content = await window.sncode.readFileContent(selProject.folderPath, relativePath);
    setRightSidebar({ type: "file", filePath: relativePath, fileContent: content });
  }

  async function openDiffInSidebar() {
    if (!selProject) return;
    const diffs = await window.sncode.getGitDiff(selProject.folderPath);
    setRightSidebar({ type: "diff", diffs });
  }

  async function handleGitAction(action: string, args?: Record<string, string>) {
    if (!selProject) return;
    setGitActionFeedback("...");
    const result = await window.sncode.gitAction(selProject.folderPath, action, args);
    setGitActionFeedback(result.message);
    setTimeout(() => setGitActionFeedback(""), 3000);
    setShowGitActions(false);
    // Refresh git status
    window.sncode.getGitStatus(selProject.folderPath).then(setGitStatus);
    window.sncode.getGitBranches(selProject.folderPath).then((r) => { setGitBranches(r.branches); setCurrentBranch(r.current); });
  }

  function openSubAgentInSidebar(msg: ThreadMessage) {
    setRightSidebar({ type: "subagent", taskMsg: msg });
  }

  // Todo system
  function addTodo(content: string) {
    setTodos((prev) => [...prev, { id: Date.now().toString(), content, status: "pending" }]);
  }
  function toggleTodo(id: string) {
    setTodos((prev) => prev.map((t) => t.id === id ? { ...t, status: t.status === "completed" ? "pending" : "completed" } : t));
  }
  function removeTodo(id: string) {
    setTodos((prev) => prev.filter((t) => t.id !== id));
  }

  async function updateSettings(updates: Partial<AgentSettings>) {
    const settings = await window.sncode.updateSettings(updates);
    setState((prev) => ({ ...prev, settings }));
  }

  const addImages = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files);
    const attachments: ImageAttachment[] = [];
    for (const file of arr) {
      const att = await fileToImageAttachment(file);
      if (att) attachments.push(att);
    }
    if (attachments.length > 0) {
      setPendingImages((prev) => [...prev, ...attachments].slice(0, 10));
    }
  }, []);

  function removeImage(idx: number) {
    setPendingImages((prev) => prev.filter((_, i) => i !== idx));
  }

  /* ── boot ── */

  if (booting) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg-base)]">
        <div className="text-center">
          <div className="mb-2 text-lg font-semibold"><span className="text-[var(--brand-sn)]">Sn</span><span className="text-[var(--brand-code)]">Code</span></div>
          <div className="text-[12px] text-[var(--text-dimmer)]">Loading...</div>
        </div>
      </div>
    );
  }

  /* ── onboarding ── */

  const anyProviderAuthed = state.providers.some((p) => p.credentialSet);
  const needsOnboarding = !state.settings.onboardingComplete && !anyProviderAuthed;

  if (needsOnboarding) {
    return (
      <OnboardingModal
        onSaveCredential={saveCredential}
        onComplete={async () => {
          await updateSettings({ onboardingComplete: true });
          void refresh();
        }}
      />
    );
  }

  /* ── render ── */

  return (
    <div className="flex h-screen text-[var(--text-primary)]" style={{ background: "var(--bg-base)" }}>

      {/* ─── Sidebar ─── */}
      <aside className="flex w-[260px] shrink-0 flex-col">
        <div className="drag-region flex h-12 shrink-0 items-center px-4 pt-1">
          <div className="no-drag flex items-center gap-1.5">
            <span className="text-[14px] font-bold tracking-tight"><span className="text-[var(--brand-sn)]">Sn</span><span className="text-[var(--brand-code)]">Code</span></span>
          </div>
          <button onClick={() => setShowSettings(true)} className="no-drag ml-auto grid h-7 w-7 place-items-center rounded-lg text-[var(--text-dim)] transition hover:bg-[var(--bg-elevated)] hover:text-[var(--text-muted)]" title="Settings"><GearIcon /></button>
        </div>

        <div className="px-3 pb-1.5">
          <button onClick={() => selProject && addThread(selProject)} disabled={!selProject} className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-card)] px-3 py-2 text-left text-[13px] text-[var(--text-muted)] transition hover:border-[var(--border-active)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-label)] disabled:opacity-30">+ New thread</button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
          {state.projects.map((project) => {
            const threads = state.threads.filter((t) => t.projectId === project.id);
            const expanded = expandedProjects.has(project.id);
            return (
              <div key={project.id} className="mb-0.5">
                <button
                  onClick={() => {
                    setExpandedProjects((prev) => {
                      const next = new Set(prev);
                      if (next.has(project.id)) next.delete(project.id);
                      else next.add(project.id);
                      return next;
                    });
                    setSelProjectId(project.id);
                  }}
                  className="group flex w-full items-center gap-1.5 rounded-lg px-2.5 py-[6px] text-left transition hover:bg-[var(--bg-card)]"
                >
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor" className={`shrink-0 text-[var(--text-dimmer)] transition-transform ${expanded ? "rotate-90" : ""}`}><path d="M3 1l4 4-4 4z" /></svg>
                  <span className="flex-1 truncate text-[13px] font-medium text-[var(--text-label)]">{project.name}</span>
                  <span className="text-[11px] text-[var(--text-dimmer)]">{threads.length}</span>
                </button>
                {expanded && (
                  <div className="ml-3 space-y-px border-l border-[var(--border)] pl-1.5">
                    {threads.map((thread) => {
                      const active = thread.id === selThreadId;
                      const msgs = state.messages.filter((m) => m.threadId === thread.id);
                      const last = msgs[msgs.length - 1];
                      return (
                        <div key={thread.id} className="group relative">
                          <button
                            onClick={() => { setSelProjectId(project.id); setSelThreadId(thread.id); }}
                            onContextMenu={(ev) => {
                              ev.preventDefault();
                              setContextMenu({ x: ev.clientX, y: ev.clientY, threadId: thread.id });
                            }}
                            className={`flex w-full items-center justify-between rounded-lg px-2.5 py-[6px] pr-7 text-left text-[13px] transition ${active ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:bg-[var(--bg-card)] hover:text-[var(--text-label)]"}`}
                          >
                            <span className="flex min-w-0 items-center gap-1.5">
                              {runningThreads.has(thread.id) && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />}
                              <span className="min-w-0 truncate">{thread.title}</span>
                            </span>
                            <span className="shrink-0 text-[10px] text-[var(--text-dimmer)] group-hover:hidden">{last ? timeAgo(last.createdAt) : ""}</span>
                          </button>
                          <button onClick={(ev) => { ev.stopPropagation(); void deleteThread(thread.id); }} className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded-md p-1 text-[var(--text-dim)] transition hover:bg-[var(--bg-active)] hover:text-red-400 group-hover:block" title="Delete thread"><TrashIcon /></button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* File tree panel */}
        {showFileTree && selProject && (
          <div className="border-t border-[var(--border-subtle)]">
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="text-[11px] font-medium text-[var(--text-dim)]">Files</span>
              <button onClick={() => setShowFileTree(false)} className="text-[var(--text-dim)] transition hover:text-[var(--text-muted)]"><XIcon /></button>
            </div>
            <FileTreePanel projectPath={selProject.folderPath} onFileClick={openFileInSidebar} />
          </div>
        )}

        <div className="border-t border-[var(--border-subtle)] p-3">
          <div className="flex gap-2">
            <button onClick={addProject} className="flex-1 rounded-lg px-3 py-2 text-left text-[13px] text-[var(--text-dim)] transition hover:bg-[var(--bg-card)] hover:text-[var(--text-muted)]">+ Add project</button>
            {selProject && (
              <button onClick={() => setShowFileTree((v) => !v)} className={`grid h-8 w-8 place-items-center rounded-lg transition ${showFileTree ? "bg-[var(--bg-elevated)] text-[var(--text-muted)]" : "text-[var(--text-dim)] hover:bg-[var(--bg-card)] hover:text-[var(--text-muted)]"}`} title="Toggle file tree (Ctrl+B)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
              </button>
            )}
          </div>
        </div>

        {/* Thread context menu */}
        {contextMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} onContextMenu={(ev) => { ev.preventDefault(); setContextMenu(null); }} />
            <div
              className="fixed z-50 min-w-[140px] overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] py-1 shadow-xl shadow-black/50"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <button
                onClick={() => { void deleteThread(contextMenu.threadId); setContextMenu(null); }}
                className="flex w-full items-center gap-2 px-3 py-[6px] text-left text-[12px] text-red-400 transition hover:bg-[var(--bg-active)]"
              >
                <TrashIcon />
                Delete thread
              </button>
            </div>
          </>
        )}
      </aside>

      {/* ─── Main content (floating card) ─── */}
      <main className="flex min-h-0 flex-1 flex-col py-2 pr-2">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl" style={{ border: "1px solid var(--border)", background: "var(--bg-card)" }}>

          {/* Top bar */}
          <div className="drag-region flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border)] px-4">
            <div className="no-drag flex min-w-0 flex-1 items-center gap-2">
              {isBusy && <div className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" />}
              <span className="truncate text-[13px] font-medium text-[var(--text-heading)]">{selThread?.title ?? "Select a thread"}</span>
              {selProject && <span className="shrink-0 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-px text-[10px] text-[var(--text-dim)]">{selProject.name}</span>}
            </div>
            <div className="no-drag flex shrink-0 items-center gap-1.5">
              <button onClick={() => setShowSearch((v) => !v)} className="grid h-7 w-7 place-items-center rounded-md text-[var(--text-dim)] transition hover:bg-[var(--bg-user-bubble)] hover:text-[var(--text-muted)]" title="Search (Ctrl+F)"><SearchIcon /></button>

              {selProject && gitStatus.isRepo ? (
                <>
                  {/* Change indicators */}
                  {(gitStatus.changes > 0 || gitStatus.staged > 0) && (
                    <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]">
                      <span className="text-amber-400">{gitStatus.changes}M</span>
                      {gitStatus.staged > 0 && <span className="text-emerald-400">+{gitStatus.staged}</span>}
                    </span>
                  )}

                  {/* Branch selector */}
                  <div className="relative">
                    <button onClick={() => setShowBranchDropdown((v) => !v)} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--text-dim)] transition hover:bg-[var(--bg-user-bubble)] hover:text-[var(--text-muted)]">
                      <GitBranchIcon /><span className="max-w-[100px] truncate">{currentBranch || "main"}</span><ChevronIcon open={showBranchDropdown} />
                    </button>
                    {showBranchDropdown && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setShowBranchDropdown(false)} />
                        <div className="absolute right-0 top-full z-20 mt-1 max-h-48 w-44 overflow-auto rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] py-1 shadow-xl shadow-black/40">
                          {gitBranches.map((branch) => (
                            <button
                              key={branch}
                              onClick={() => { void handleGitAction("checkout", { branch }); setShowBranchDropdown(false); }}
                              className={`flex w-full items-center px-3 py-[5px] text-left text-[11px] transition hover:bg-[var(--bg-active)] ${branch === currentBranch ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}
                            >
                              {branch === currentBranch && <span className="mr-1.5 text-emerald-400">*</span>}
                              {branch}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Diff button */}
                  <button onClick={openDiffInSidebar} className="grid h-7 w-7 place-items-center rounded-md text-[var(--text-dim)] transition hover:bg-[var(--bg-user-bubble)] hover:text-[var(--text-muted)]" title="View changes">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3v18M3 12h18" />
                    </svg>
                  </button>

                  {/* Git actions dropdown */}
                  <div className="relative">
                    <button onClick={() => setShowGitActions((v) => !v)} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--text-dim)] transition hover:bg-[var(--bg-user-bubble)] hover:text-[var(--text-muted)]">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" />
                      </svg>
                    </button>
                    {showGitActions && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setShowGitActions(false)} />
                        <div className="absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] py-1 shadow-xl shadow-black/40">
                          <button onClick={() => { setShowCommitModal(true); setShowGitActions(false); }} className="flex w-full items-center gap-2 px-3 py-[6px] text-left text-[12px] text-[var(--text-label)] transition hover:bg-[var(--bg-active)]">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4" /><line x1="1.05" y1="12" x2="7" y2="12" /><line x1="17.01" y1="12" x2="22.96" y2="12" /></svg>
                            Commit
                          </button>
                          <button onClick={() => handleGitAction("pull")} className="flex w-full items-center gap-2 px-3 py-[6px] text-left text-[12px] text-[var(--text-label)] transition hover:bg-[var(--bg-active)]">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="8 17 12 21 16 17" /><line x1="12" y1="12" x2="12" y2="21" /><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29" /></svg>
                            Pull
                          </button>
                          <button onClick={() => handleGitAction("push")} className="flex w-full items-center gap-2 px-3 py-[6px] text-left text-[12px] text-[var(--text-label)] transition hover:bg-[var(--bg-active)]">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 7 12 3 8 7" /><line x1="12" y1="3" x2="12" y2="15" /><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29" /></svg>
                            Push
                          </button>
                          <div className="mx-2 my-1 h-px bg-[var(--bg-active)]" />
                          <button onClick={() => handleGitAction("stash")} className="flex w-full items-center gap-2 px-3 py-[6px] text-left text-[12px] text-[var(--text-muted)] transition hover:bg-[var(--bg-active)]">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /></svg>
                            Stash
                          </button>
                          <button onClick={() => handleGitAction("stash-pop")} className="flex w-full items-center gap-2 px-3 py-[6px] text-left text-[12px] text-[var(--text-muted)] transition hover:bg-[var(--bg-active)]">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="7.5 4.21 12 6.81 16.5 4.21" /></svg>
                            Stash Pop
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </>
              ) : selProject ? (
                /* No repo - show init button */
                <button
                  onClick={() => handleGitAction("init")}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-[var(--text-dim)] transition hover:bg-[var(--bg-user-bubble)] hover:text-[var(--text-muted)]"
                  title="Initialize git repository"
                >
                  <GitBranchIcon />
                  <span>Init repo</span>
                </button>
              ) : null}

              {/* Git action feedback toast */}
              {gitActionFeedback && (
                <span className="rounded-md bg-[var(--bg-active)] px-2 py-0.5 text-[10px] text-[var(--text-label)] animate-pulse">{gitActionFeedback}</span>
              )}
            </div>
          </div>

          {/* Search bar */}
          {showSearch && <SearchBar messages={threadMessages} onClose={() => setShowSearch(false)} onHighlight={setSearchHighlight} />}

          {/* Messages */}
          <div ref={scrollContainerRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-auto">
            <div className="mx-auto max-w-[820px] px-5 py-5">
              {threadMessages.length === 0 && !streamChunk ? (
                <div className="mt-32 text-center">
                  <div className="mb-3 text-[22px] font-semibold text-[var(--text-heading)]">What are you building?</div>
                  <p className="text-[13px] text-[var(--text-dim)]">Ask anything about your project — or start with a suggestion.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {threadMessages.map((msg) => {
                    const isUser = msg.role === "user";
                    const isTool = msg.role === "tool";
                    const isError = msg.metadata?.isError;
                    return (
                      <div key={msg.id} id={`msg-${msg.id}`}>
                        {isTool && msg.metadata?.isTask ? (
                          <TaskMessage msg={msg} onClickDetail={openSubAgentInSidebar} />
                        ) : isTool ? (
                          <ToolMessage msg={msg} />
                        ) : isUser ? (
                          <div className="flex justify-end">
                            <div className="max-w-[80%]">
                              <div className="rounded-2xl rounded-br-sm bg-[var(--bg-user-bubble)] px-4 py-2.5">
                                {msg.images && msg.images.length > 0 && (
                                  <div className="mb-2 flex flex-wrap gap-2">
                                    {msg.images.map((img, i) => (
                                      <img
                                        key={i}
                                        src={`data:${img.mediaType};base64,${img.data}`}
                                        alt={img.name || "Attachment"}
                                        className="max-h-[200px] max-w-full rounded-lg border border-[var(--border-active)] object-contain"
                                      />
                                    ))}
                                  </div>
                                )}
                                {msg.content && (
                                  <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-[var(--text-bright)]">
                                    {searchHighlight ? <HighlightText text={msg.content} query={searchHighlight} /> : msg.content}
                                  </pre>
                                )}
                              </div>
                              <div className="mt-0.5 text-right text-[10px] text-[var(--text-dimmest)]">
                                {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div className={`text-[13px] ${isError ? "text-red-400/90" : "text-[var(--text-secondary)]"}`}>
                              <Markdown content={msg.content} />
                            </div>
                            <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[var(--text-dimmest)]">
                              <span>{new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                              {(msg.metadata?.inputTokens || msg.metadata?.outputTokens) && (
                                <span className="text-[var(--text-dimmest)]" title={`Input: ${msg.metadata.inputTokens?.toLocaleString() ?? 0} | Output: ${msg.metadata.outputTokens?.toLocaleString() ?? 0}`}>
                                  {((msg.metadata.inputTokens ?? 0) + (msg.metadata.outputTokens ?? 0)).toLocaleString()} tokens
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Streaming preview */}
                  {streamChunk && (
                    <div className="text-[13px] text-[var(--text-secondary)]">
                      <Markdown content={streamChunk} />
                      <span className="inline-block animate-pulse text-[var(--text-dimmer)]">|</span>
                    </div>
                  )}

                  {/* Loading dots */}
                  {isBusy && !streamChunk && (
                    <div className="flex items-center gap-2 py-1">
                      <div className="flex gap-[3px]">
                        <div className="h-1 w-1 animate-bounce rounded-full bg-[var(--text-dimmer)]" style={{ animationDelay: "0ms" }} />
                        <div className="h-1 w-1 animate-bounce rounded-full bg-[var(--text-dimmer)]" style={{ animationDelay: "150ms" }} />
                        <div className="h-1 w-1 animate-bounce rounded-full bg-[var(--text-dimmer)]" style={{ animationDelay: "300ms" }} />
                      </div>
                      <span className="text-[11px] text-[var(--text-dimmer)]">{statusText}</span>
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>
          </div>

          {/* Todo panel + Composer */}
          <div className="shrink-0 px-4 pb-4 pt-1">
            <div className="mx-auto max-w-[820px]">
              <TodoPanel todos={todos} onToggle={toggleTodo} onRemove={removeTodo} onAdd={addTodo} />
            </div>
            <form onSubmit={send} className="mx-auto max-w-[820px]">
              <div
                className={`rounded-xl border bg-[var(--bg-elevated)] transition-colors focus-within:border-[var(--border-active)] ${dragOver ? "border-blue-500/50 bg-[var(--bg-drag-highlight)]" : "border-[var(--border)]"}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (e.dataTransfer.files.length > 0) {
                    await addImages(e.dataTransfer.files);
                  }
                }}
              >
                {/* Image previews */}
                {pendingImages.length > 0 && (
                  <div className="flex flex-wrap gap-2 px-3.5 pt-2.5">
                    {pendingImages.map((img, i) => (
                      <div key={i} className="group relative">
                        <img
                          src={`data:${img.mediaType};base64,${img.data}`}
                          alt={img.name || "Attachment"}
                          className="h-16 w-16 rounded-lg border border-[var(--border-active)] object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => removeImage(i)}
                          className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-[var(--bg-stop)] text-[var(--text-muted)] transition hover:bg-red-500 hover:text-white group-hover:flex"
                        >
                          <XIcon />
                        </button>
                        {img.name && (
                          <div className="absolute inset-x-0 bottom-0 truncate rounded-b-lg bg-black/60 px-1 py-0.5 text-[9px] text-[var(--text-muted)]">{img.name}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <textarea
                  value={msgInput}
                  onChange={(e) => setMsgInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(e); } }}
                  onPaste={async (e) => {
                    const items = e.clipboardData.items;
                    const imageFiles: File[] = [];
                    for (let i = 0; i < items.length; i++) {
                      const item = items[i];
                      if (item.type.startsWith("image/")) {
                        const file = item.getAsFile();
                        if (file) imageFiles.push(file);
                      }
                    }
                    if (imageFiles.length > 0) {
                      e.preventDefault();
                      await addImages(imageFiles);
                    }
                  }}
                  placeholder={pendingImages.length > 0 ? "Add a message or just send the image..." : "Type your message here..."}
                  rows={2}
                  className="w-full resize-none bg-transparent px-4 pt-3 pb-1.5 text-[13px] leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-dimmest)]"
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) void addImages(e.target.files);
                    e.target.value = "";
                  }}
                />
                <div className="flex items-center px-3 pb-2.5">
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="grid h-7 w-7 place-items-center rounded-md text-[var(--text-dim)] transition hover:bg-[var(--bg-active)] hover:text-[var(--text-muted)]" title="Attach image">
                    <PaperclipIcon />
                  </button>
                  <div className="mx-1 h-3.5 w-px bg-[var(--bg-active)]" />
                  <div className="relative">
                    <button type="button" onClick={() => setShowModelPicker((v) => !v)} className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-[var(--text-dim)] transition hover:bg-[var(--bg-active)] hover:text-[var(--text-muted)]">
                      {activeModelLabel(state.providers)}<ChevronIcon open={showModelPicker} />
                    </button>
                    {showModelPicker && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setShowModelPicker(false)} />
                        <div className="absolute bottom-full left-0 z-20 mb-1 w-48 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] py-1 shadow-xl shadow-black/40">
                          {availableModels(state.providers).length === 0 ? (
                            <div className="px-3 py-2 text-[11px] text-[var(--text-dimmer)]">No providers authorized</div>
                          ) : (
                            availableModels(state.providers).map((m) => (
                              <button key={m.id} type="button" onClick={() => pickModel(m.id)} className={`flex w-full items-center justify-between px-3 py-[6px] text-left text-[12px] transition hover:bg-[var(--bg-active)] ${m.id === activeModelId(state.providers) ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}>
                                <span>{m.label}</span><span className="text-[10px] text-[var(--text-dimmer)]">{m.provider === "anthropic" ? "Anthropic" : "OpenAI"}</span>
                              </button>
                            ))
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="mx-1 h-3.5 w-px bg-[var(--bg-active)]" />
                  <button type="button" onClick={() => setPermission((p) => (p === "full" ? "approve" : "full"))} className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-[var(--text-dim)] transition hover:bg-[var(--bg-active)] hover:text-[var(--text-muted)]">
                    {permission === "full" ? <UnlockIcon /> : <LockIcon />}
                    {permission === "full" ? "Full access" : "Ask first"}
                  </button>
                  <div className="mx-1 h-3.5 w-px bg-[var(--bg-active)]" />
                  <ThinkingLevelPicker
                    level={state.settings.thinkingLevel || "none"}
                    provider={state.providers.find((p) => p.enabled)?.id ?? "anthropic"}
                    onChange={(level) => { void updateSettings({ thinkingLevel: level }); }}
                  />
                  <div className="ml-auto">
                    {isBusy ? (
                      <button type="button" onClick={cancel} className="grid h-8 w-8 place-items-center rounded-full bg-[var(--bg-stop)] text-[var(--text-primary)] transition hover:bg-[var(--bg-stop-hover)]" title="Stop"><StopIcon /></button>
                    ) : (
                      <button type="submit" disabled={!selThreadId || (!msgInput.trim() && pendingImages.length === 0)} className="grid h-8 w-8 place-items-center rounded-full bg-[var(--bg-accent)] text-[var(--text-on-accent)] transition hover:bg-[var(--bg-accent-hover)] disabled:opacity-20"><SendIcon /></button>
                    )}
                  </div>
                </div>
              </div>
            </form>
          </div>
        </div>
      </main>

      {/* ─── Right Sidebar ─── */}
      {rightSidebar && (
        <div className="flex w-[380px] shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          {rightSidebar.type === "file" && rightSidebar.filePath && (
            <RightSidebarFileView
              filePath={rightSidebar.filePath}
              content={rightSidebar.fileContent || ""}
              onClose={() => setRightSidebar(null)}
            />
          )}
          {rightSidebar.type === "diff" && (
            <RightSidebarDiffView
              diffs={rightSidebar.diffs || []}
              onClose={() => setRightSidebar(null)}
            />
          )}
          {rightSidebar.type === "subagent" && rightSidebar.taskMsg && (
            <RightSidebarSubAgent
              msg={rightSidebar.taskMsg}
              onClose={() => setRightSidebar(null)}
            />
          )}
        </div>
      )}

      {/* ─── Commit modal ─── */}
      {showCommitModal && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setShowCommitModal(false)} />
          <div className="fixed left-1/2 top-1/2 z-50 w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-5 shadow-2xl">
            <h3 className="mb-3 text-[14px] font-medium text-[var(--text-primary)]">Commit Changes</h3>
            <input
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder="Commit message..."
              className="mb-3 w-full rounded-lg border border-[var(--border-active)] bg-[var(--bg-base)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-dimmest)] focus:border-[var(--text-dim)]"
              onKeyDown={(e) => {
                if (e.key === "Enter" && commitMsg.trim()) {
                  void handleGitAction("commit", { message: commitMsg.trim() });
                  setShowCommitModal(false);
                  setCommitMsg("");
                }
              }}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowCommitModal(false)} className="rounded-lg px-3 py-1.5 text-[12px] text-[var(--text-muted)] transition hover:bg-[var(--bg-active)]">Cancel</button>
              <button
                onClick={() => {
                  if (commitMsg.trim()) {
                    void handleGitAction("commit", { message: commitMsg.trim() });
                    setShowCommitModal(false);
                    setCommitMsg("");
                  }
                }}
                disabled={!commitMsg.trim()}
                className="rounded-lg bg-[var(--bg-stop)] px-3 py-1.5 text-[12px] text-[var(--text-primary)] transition hover:bg-[var(--bg-stop-hover)] disabled:opacity-30"
              >
                Commit
              </button>
            </div>
          </div>
        </>
      )}

      {showSettings && (
        <SettingsModal providers={state.providers} settings={state.settings} projectId={selProjectId} projectPath={selProject?.folderPath ?? null} onClose={() => setShowSettings(false)} onUpdateProvider={updateProvider} onSaveCredential={saveCredential} onUpdateSettings={updateSettings} onClearAllData={async () => { const s = await window.sncode.clearAllData(); setState(s); setSelProjectId(null); setSelThreadId(null); setExpandedProjects(new Set()); setShowSettings(false); }} />
      )}
    </div>
  );
}
