import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import picomatch from "picomatch";

const MAX_FILE_BYTES = 300_000;

/* ── Platform / shell detection ── */

function detectShell(): { shell: string; shellName: string } {
  const platform = process.platform;
  if (platform === "win32") {
    // Prefer pwsh (PowerShell 7+) > powershell (5.1) > cmd
    const pwsh7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    if (fs.existsSync(pwsh7)) return { shell: pwsh7, shellName: "pwsh" };
    const pwsh5 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    if (fs.existsSync(pwsh5)) return { shell: pwsh5, shellName: "powershell" };
    return { shell: process.env.COMSPEC || "cmd.exe", shellName: "cmd" };
  }
  if (platform === "darwin") {
    return { shell: process.env.SHELL || "/bin/zsh", shellName: "zsh" };
  }
  return { shell: process.env.SHELL || "/bin/bash", shellName: "bash" };
}

const shellInfo = detectShell();

export interface EnvironmentInfo {
  platform: string;
  arch: string;
  shellName: string;
  shellPath: string;
  homeDir: string;
}

export function getEnvironmentInfo(): EnvironmentInfo {
  return {
    platform: process.platform,
    arch: process.arch,
    shellName: shellInfo.shellName,
    shellPath: shellInfo.shell,
    homeDir: os.homedir(),
  };
}

function resolveInsideProject(projectRoot: string, targetPath: string) {
  const resolved = path.resolve(projectRoot, targetPath || ".");
  const normalizedRoot = path.resolve(projectRoot);
  if (!resolved.startsWith(normalizedRoot)) {
    throw new Error("Path escapes project root");
  }
  return resolved;
}

export function listFiles(projectRoot: string, relativePath = ".") {
  const resolved = resolveInsideProject(projectRoot, relativePath);
  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith(".git"))
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : "file"
    }));
}

export function readTextFile(projectRoot: string, relativePath: string) {
  const resolved = resolveInsideProject(projectRoot, relativePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error("Target is not a file");
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File too large (${stat.size} bytes)`);
  }
  return fs.readFileSync(resolved, "utf8");
}

export function writeTextFile(projectRoot: string, relativePath: string, content: string) {
  const resolved = resolveInsideProject(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, "utf8");
  return { ok: true };
}

/* ── Directories that should be excluded from recursive search commands ── */

const HEAVY_DIRS = [
  "node_modules", ".git", ".next", ".nuxt", "dist", "build", ".output",
  "__pycache__", ".venv", "venv", ".tox", "vendor", ".bundle",
  "coverage", ".cache", ".turbo", ".parcel-cache"
];

/**
 * Auto-inject exclusion flags for grep/find/ripgrep commands to avoid
 * scanning heavy directories (node_modules, .git, dist, etc.) unless
 * the user explicitly targets them.
 */
function safeCommand(command: string): string {
  const trimmed = command.trim();

  // grep -r / grep -rn / grep --include etc.  (recursive grep)
  if (/^grep\b/.test(trimmed) && /\s-[A-Za-z]*r/.test(trimmed)) {
    // Only inject if the command doesn't already have --exclude-dir
    if (!trimmed.includes("--exclude-dir")) {
      const excludes = HEAVY_DIRS.map((d) => `--exclude-dir=${d}`).join(" ");
      // Insert excludes right after "grep"
      return trimmed.replace(/^grep/, `grep ${excludes}`);
    }
  }

  // ripgrep (rg) — already ignores .gitignore by default, but add safety
  if (/^rg\b/.test(trimmed)) {
    if (!trimmed.includes("--no-ignore") && !trimmed.includes("-uuu")) {
      // rg respects .gitignore by default, which covers node_modules.
      // But add explicit globs for dirs not in .gitignore just in case.
      if (!trimmed.includes("-g") && !trimmed.includes("--glob")) {
        const globs = HEAVY_DIRS.map((d) => `-g '!${d}'`).join(" ");
        return trimmed.replace(/^rg/, `rg ${globs}`);
      }
    }
  }

  // find command — recursive by nature
  if (/^find\b/.test(trimmed)) {
    if (!trimmed.includes("-prune") && !trimmed.includes("--exclude")) {
      const prunes = HEAVY_DIRS.map((d) => `-name ${d} -prune -o`).join(" ");
      // Insert after the path argument(s) — find <path> <prunes> <rest>
      // Simple heuristic: insert after "find ."  or "find <path>"
      return trimmed.replace(/^(find\s+\S+)/, `$1 \\( ${prunes} -true \\)`);
    }
  }

  return command;
}

export interface RunCommandOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export async function runCommand(
  projectRoot: string,
  command: string,
  options: RunCommandOptions = {}
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const { timeoutMs = 90_000, abortSignal } = options;
  const safeCmd = safeCommand(command);

  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    // Check if already aborted before spawning
    if (abortSignal?.aborted) {
      reject(new Error("Run cancelled"));
      return;
    }

    const child = spawn(safeCmd, {
      cwd: projectRoot,
      shell: shellInfo.shell,
      windowsHide: true,
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    function settle(result: { stdout: string; stderr: string; code: number | null } | null, error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    }

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      // Force kill after 2 seconds if SIGTERM didn't work
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 2000);
      settle(null, new Error("Command timed out"));
    }, timeoutMs);

    // Listen for abort signal to kill the child process
    function onAbort() {
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 2000);
      settle(null, new Error("Run cancelled"));
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 200_000) {
        stdout = `${stdout.slice(0, 200_000)}\n...truncated...`;
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 80_000) {
        stderr = `${stderr.slice(0, 80_000)}\n...truncated...`;
      }
    });

    child.on("error", (error) => {
      settle(null, error);
    });

    child.on("close", (code) => {
      settle({ stdout, stderr, code });
    });
  });
}

/* ── edit_file: exact string replacement ── */

export interface EditFileResult {
  ok: boolean;
  message: string;
}

export function editFile(
  projectRoot: string,
  relativePath: string,
  oldString: string,
  newString: string,
  replaceAll = false
): EditFileResult {
  if (oldString === newString) {
    throw new Error("oldString and newString must be different");
  }
  const resolved = resolveInsideProject(projectRoot, relativePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`File not found: ${relativePath}`);
  }

  const content = fs.readFileSync(resolved, "utf8");

  if (!content.includes(oldString)) {
    throw new Error("oldString not found in file. Make sure you read the file first and use the exact text including whitespace and indentation.");
  }

  if (!replaceAll) {
    // Count occurrences
    let count = 0;
    let idx = 0;
    while ((idx = content.indexOf(oldString, idx)) !== -1) {
      count++;
      idx += oldString.length;
    }
    if (count > 1) {
      throw new Error(
        `oldString found ${count} times in file. Provide more surrounding context to uniquely identify the target, or set replaceAll to true.`
      );
    }
  }

  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);

  fs.writeFileSync(resolved, updated, "utf8");

  const occurrences = replaceAll
    ? content.split(oldString).length - 1
    : 1;

  return {
    ok: true,
    message: `Replaced ${occurrences} occurrence${occurrences > 1 ? "s" : ""} in ${relativePath}`
  };
}

/* ── glob: find files by pattern ── */

const SKIP_DIRS = new Set(HEAVY_DIRS);

function walkDir(dir: string, rootDir: string, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // permission errors, etc.
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.name !== ".") continue; // skip hidden except "."

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      results.push(relPath + "/");
      walkDir(fullPath, rootDir, results);
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }
}

export interface GlobResult {
  matches: string[];
  truncated: boolean;
}

const MAX_GLOB_RESULTS = 500;

export function globFiles(projectRoot: string, pattern: string, searchPath = "."): GlobResult {
  const resolved = resolveInsideProject(projectRoot, searchPath);

  // Collect all files first
  const allPaths: string[] = [];
  walkDir(resolved, resolved, allPaths);

  // Match against pattern
  const isMatch = picomatch(pattern, { dot: false, bash: true });
  const matches: string[] = [];

  for (const p of allPaths) {
    if (isMatch(p)) {
      // Prefix with searchPath if not "."
      const display = searchPath === "." ? p : path.posix.join(searchPath, p);
      matches.push(display);
      if (matches.length >= MAX_GLOB_RESULTS) break;
    }
  }

  return {
    matches,
    truncated: matches.length >= MAX_GLOB_RESULTS
  };
}

/* ── grep: search file contents with regex ── */

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  fileCount: number;
  truncated: boolean;
}

const MAX_GREP_MATCHES = 200;
const MAX_GREP_LINE_LENGTH = 500;

export function grepFiles(
  projectRoot: string,
  pattern: string,
  options: { include?: string; searchPath?: string } = {}
): GrepResult {
  const { include, searchPath = "." } = options;
  const resolved = resolveInsideProject(projectRoot, searchPath);

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "g");
  } catch (e) {
    throw new Error(`Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Collect files
  const allPaths: string[] = [];
  walkDir(resolved, resolved, allPaths);

  // Filter to files only (not dirs ending with /)
  let filePaths = allPaths.filter((p) => !p.endsWith("/"));

  // Apply include filter if provided (e.g. "*.ts", "*.{ts,tsx}")
  if (include) {
    const includeMatch = picomatch(include, { dot: false, bash: true });
    filePaths = filePaths.filter((p) => includeMatch(path.basename(p)) || includeMatch(p));
  }

  const matches: GrepMatch[] = [];
  let fileCount = 0;

  for (const relPath of filePaths) {
    if (matches.length >= MAX_GREP_MATCHES) break;

    const fullPath = path.join(resolved, relPath);
    let content: string;
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_FILE_BYTES) continue; // skip huge files
      content = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }

    // Check if it looks like a binary file (has null bytes in first 8KB)
    if (content.slice(0, 8192).includes("\0")) continue;

    const lines = content.split("\n");
    let hasMatch = false;

    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        if (!hasMatch) {
          hasMatch = true;
          fileCount++;
        }
        const displayPath = searchPath === "." ? relPath : path.posix.join(searchPath, relPath);
        const lineContent = lines[i].length > MAX_GREP_LINE_LENGTH
          ? lines[i].slice(0, MAX_GREP_LINE_LENGTH) + "..."
          : lines[i];
        matches.push({ file: displayPath, line: i + 1, content: lineContent });
        if (matches.length >= MAX_GREP_MATCHES) break;
      }
    }
  }

  return {
    matches,
    fileCount,
    truncated: matches.length >= MAX_GREP_MATCHES
  };
}
