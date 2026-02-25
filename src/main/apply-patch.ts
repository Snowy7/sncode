import fs from "node:fs";
import path from "node:path";

type PatchAction =
  | { type: "add"; filePath: string; content: string }
  | { type: "delete"; filePath: string }
  | { type: "update"; filePath: string; moveTo?: string; hunks: Hunk[] };

type Hunk = {
  header?: string;
  oldLines: string[];
  newLines: string[];
};

type FileBackup = {
  exists: boolean;
  content?: Buffer;
};

const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";
const UPDATE_PREFIX = "*** Update File: ";
const ADD_PREFIX = "*** Add File: ";
const DELETE_PREFIX = "*** Delete File: ";
const MOVE_TO_PREFIX = "*** Move to: ";
const END_OF_FILE_LINE = "*** End of File";

function isInsidePath(rootPath: string, candidatePath: string) {
  const rel = path.relative(rootPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeRealpath(target: string) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return fs.realpathSync(target);
  }
}

function resolveInsideProject(projectRoot: string, targetPath: string, mode: "read" | "write" = "read"): string {
  const normalizedRoot = safeRealpath(path.resolve(projectRoot));
  const resolved = path.resolve(projectRoot, targetPath || ".");
  if (!isInsidePath(normalizedRoot, resolved)) {
    throw new Error(`Path escapes project root: ${targetPath}`);
  }

  const existingPath = mode === "write" ? path.dirname(resolved) : resolved;
  if (fs.existsSync(existingPath)) {
    const canonical = safeRealpath(existingPath);
    if (!isInsidePath(normalizedRoot, canonical)) {
      throw new Error(`Path escapes project root via symlink: ${targetPath}`);
    }
  }

  return resolved;
}

function parseHunks(lines: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      current = { header: line, oldLines: [], newLines: [] };
      hunks.push(current);
      continue;
    }
    if (line === END_OF_FILE_LINE) {
      continue;
    }
    const prefix = line[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-") {
      throw new Error(`Invalid patch line in update block: ${line}`);
    }
    if (!current) {
      current = { oldLines: [], newLines: [] };
      hunks.push(current);
    }
    const text = line.slice(1);
    if (prefix === " " || prefix === "-") current.oldLines.push(text);
    if (prefix === " " || prefix === "+") current.newLines.push(text);
  }

  return hunks;
}

function parsePatch(patchText: string): PatchAction[] {
  const normalized = patchText.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines[0] !== PATCH_BEGIN) throw new Error("Patch must start with '*** Begin Patch'");

  const actions: PatchAction[] = [];
  let i = 1;

  while (i < lines.length) {
    const line = lines[i];
    if (line === PATCH_END) return actions;

    if (line.startsWith(ADD_PREFIX)) {
      const filePath = line.slice(ADD_PREFIX.length).trim();
      if (!filePath) throw new Error("Add File requires a path");
      i += 1;
      const contentLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith("*** ")) {
        if (!lines[i].startsWith("+")) throw new Error(`Add File line must start with '+': ${lines[i]}`);
        contentLines.push(lines[i].slice(1));
        i += 1;
      }
      actions.push({ type: "add", filePath, content: contentLines.join("\n") });
      continue;
    }

    if (line.startsWith(DELETE_PREFIX)) {
      const filePath = line.slice(DELETE_PREFIX.length).trim();
      if (!filePath) throw new Error("Delete File requires a path");
      actions.push({ type: "delete", filePath });
      i += 1;
      continue;
    }

    if (line.startsWith(UPDATE_PREFIX)) {
      const filePath = line.slice(UPDATE_PREFIX.length).trim();
      if (!filePath) throw new Error("Update File requires a path");
      i += 1;

      let moveTo: string | undefined;
      if (i < lines.length && lines[i].startsWith(MOVE_TO_PREFIX)) {
        moveTo = lines[i].slice(MOVE_TO_PREFIX.length).trim();
        if (!moveTo) throw new Error("Move to requires a destination path");
        i += 1;
      }

      const updateLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith("*** ")) {
        updateLines.push(lines[i]);
        i += 1;
      }
      const hunks = parseHunks(updateLines);
      actions.push({ type: "update", filePath, moveTo, hunks });
      continue;
    }

    throw new Error(`Unknown patch section: ${line}`);
  }

  throw new Error("Patch missing '*** End Patch'");
}

function parseOldStartFromHeader(header?: string): number | null {
  if (!header) return null;
  const match = header.match(/^@@\s*-(\d+)(?:,\d+)?\s+\+\d+(?:,\d+)?\s*@@/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function findSequence(haystack: string[], needle: string[], startIndex: number): number {
  if (needle.length === 0) return Math.max(0, Math.min(startIndex, haystack.length));
  for (let i = Math.max(0, startIndex); i <= haystack.length - needle.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function applyHunksToText(original: string, hunks: Hunk[]): string {
  const hadTrailingNewline = original.endsWith("\n");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const normalized = original.replace(/\r\n/g, "\n");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  if (hadTrailingNewline && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  let cursor = 0;
  for (const hunk of hunks) {
    const preferredStart = parseOldStartFromHeader(hunk.header);
    let idx = -1;

    if (preferredStart !== null) {
      idx = findSequence(lines, hunk.oldLines, Math.max(0, preferredStart - 1));
    }
    if (idx < 0) idx = findSequence(lines, hunk.oldLines, cursor);
    if (idx < 0) idx = findSequence(lines, hunk.oldLines, 0);
    if (idx < 0) {
      const snippet = hunk.oldLines.slice(0, 3).join("\\n");
      throw new Error(`Failed to apply hunk. Could not find expected lines: ${snippet}`);
    }

    lines.splice(idx, hunk.oldLines.length, ...hunk.newLines);
    cursor = idx + hunk.newLines.length;
  }

  let output = lines.join("\n");
  if (hadTrailingNewline && output.length > 0) output += "\n";
  if (hadTrailingNewline && output.length === 0) output = "\n";
  if (eol === "\r\n") output = output.replace(/\n/g, "\r\n");
  return output;
}

function backupFile(backups: Map<string, FileBackup>, absPath: string) {
  if (backups.has(absPath)) return;
  if (!fs.existsSync(absPath)) {
    backups.set(absPath, { exists: false });
    return;
  }
  backups.set(absPath, { exists: true, content: fs.readFileSync(absPath) });
}

function restoreBackups(backups: Map<string, FileBackup>) {
  for (const [absPath, backup] of backups) {
    try {
      if (backup.exists) {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, backup.content ?? Buffer.alloc(0));
      } else if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
      }
    } catch {
      // best effort rollback
    }
  }
}

export function applyPatch(projectRoot: string, patchText: string): { filesChanged: string[]; message: string } {
  if (!patchText.trim()) throw new Error("patch is required");
  const actions = parsePatch(patchText);
  const backups = new Map<string, FileBackup>();
  const filesChanged = new Set<string>();

  try {
    for (const action of actions) {
      if (action.type === "add") {
        const absPath = resolveInsideProject(projectRoot, action.filePath, "write");
        backupFile(backups, absPath);
        if (fs.existsSync(absPath)) throw new Error(`Cannot add file that already exists: ${action.filePath}`);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, action.content, "utf8");
        filesChanged.add(action.filePath);
        continue;
      }

      if (action.type === "delete") {
        const absPath = resolveInsideProject(projectRoot, action.filePath, "write");
        backupFile(backups, absPath);
        if (!fs.existsSync(absPath)) throw new Error(`Cannot delete missing file: ${action.filePath}`);
        if (!fs.statSync(absPath).isFile()) throw new Error(`Delete target is not a file: ${action.filePath}`);
        fs.unlinkSync(absPath);
        filesChanged.add(action.filePath);
        continue;
      }

      const srcAbsPath = resolveInsideProject(projectRoot, action.filePath, "write");
      backupFile(backups, srcAbsPath);
      if (!fs.existsSync(srcAbsPath)) throw new Error(`Cannot update missing file: ${action.filePath}`);
      if (!fs.statSync(srcAbsPath).isFile()) throw new Error(`Update target is not a file: ${action.filePath}`);

      const original = fs.readFileSync(srcAbsPath, "utf8");
      const nextContent = applyHunksToText(original, action.hunks);

      if (action.moveTo && action.moveTo !== action.filePath) {
        const dstAbsPath = resolveInsideProject(projectRoot, action.moveTo, "write");
        backupFile(backups, dstAbsPath);
        fs.mkdirSync(path.dirname(dstAbsPath), { recursive: true });
        fs.writeFileSync(dstAbsPath, nextContent, "utf8");
        fs.unlinkSync(srcAbsPath);
        filesChanged.add(action.filePath);
        filesChanged.add(action.moveTo);
      } else {
        fs.writeFileSync(srcAbsPath, nextContent, "utf8");
        filesChanged.add(action.filePath);
      }
    }
  } catch (err) {
    restoreBackups(backups);
    throw err;
  }

  const files = [...filesChanged];
  return {
    filesChanged: files,
    message: files.length > 0
      ? `Applied patch successfully to ${files.length} file${files.length === 1 ? "" : "s"}:\n${files.join("\n")}`
      : "Patch contained no file changes.",
  };
}
