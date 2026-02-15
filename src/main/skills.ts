import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import { Skill, SkillContent, SkillSource } from "../shared/types";

/* ── Skill directory locations ── */

/** SnCode's own skills directory (user-installed skills) */
function sncodeSkillsDir(): string {
  return path.join(app.getPath("userData"), "skills");
}

/** Claude Code / OpenCode skill directories */
function claudeCodeSkillDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".config", "opencode", "skills"),
    path.join(home, ".agents", "skills"),
    // Also check Windows-style AppData locations
    ...(process.platform === "win32"
      ? [
          path.join(home, "AppData", "Roaming", "opencode", "skills"),
          path.join(home, ".config", "claude-code", "skills"),
        ]
      : []),
  ];
}

/** Project-local skills directory */
function projectSkillsDir(projectRoot: string): string {
  return path.join(projectRoot, ".sncode", "skills");
}

/* ── Skill parsing ── */

/**
 * Parse a skill.json metadata file.
 * Returns { name, description } or null if not found / invalid.
 */
function parseSkillJson(dirPath: string): { name?: string; description?: string } | null {
  const jsonPath = path.join(dirPath, "skill.json");
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const raw = fs.readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Parse SKILL.md to extract name and description if no skill.json exists.
 * - Name: first H1 line (# Title), or directory name
 * - Description: first non-empty, non-heading paragraph
 */
function parseSkillMd(content: string, dirName: string): { name: string; description: string } {
  const lines = content.split("\n");
  let name = dirName;
  let description = "";

  for (const line of lines) {
    const trimmed = line.trim();
    // First H1 becomes the name
    if (!name || name === dirName) {
      const h1Match = trimmed.match(/^#\s+(.+)/);
      if (h1Match) {
        name = h1Match[1].trim();
        continue;
      }
    }
    // First non-empty, non-heading line becomes description
    if (!description && trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
      description = trimmed.slice(0, 200);
      break;
    }
  }

  // Humanize directory name as fallback
  if (name === dirName) {
    name = dirName
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return { name, description: description || `Skill: ${name}` };
}

/**
 * Scan a single directory for skill subdirectories.
 * Each subdirectory must contain a SKILL.md file.
 */
function scanDir(baseDir: string, source: SkillSource): Skill[] {
  if (!fs.existsSync(baseDir)) return [];

  const skills: Skill[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirPath = path.join(baseDir, entry.name);
    const skillMdPath = path.join(dirPath, "SKILL.md");

    if (!fs.existsSync(skillMdPath)) continue;

    let content: string;
    try {
      content = fs.readFileSync(skillMdPath, "utf8");
    } catch {
      continue;
    }

    const jsonMeta = parseSkillJson(dirPath);
    const mdMeta = parseSkillMd(content, entry.name);

    const skill: Skill = {
      id: `${source}:${entry.name}`,
      name: jsonMeta?.name || mdMeta.name,
      description: jsonMeta?.description || mdMeta.description,
      source,
      filePath: skillMdPath,
      dirPath,
    };

    skills.push(skill);
  }

  return skills;
}

/* ── Public API ── */

/**
 * Discover all available skills from all sources.
 * @param projectRoot Optional project root to also scan project-local skills.
 */
export function discoverSkills(projectRoot?: string): Skill[] {
  const skills: Skill[] = [];
  const seen = new Set<string>();

  // 1. SnCode's own skills directory
  for (const skill of scanDir(sncodeSkillsDir(), "sncode")) {
    if (!seen.has(skill.id)) {
      seen.add(skill.id);
      skills.push(skill);
    }
  }

  // 2. Claude Code / OpenCode directories
  for (const dir of claudeCodeSkillDirs()) {
    for (const skill of scanDir(dir, "claude-code")) {
      // Dedupe by directory name (if same skill exists in multiple Claude Code dirs)
      if (!seen.has(skill.id)) {
        seen.add(skill.id);
        skills.push(skill);
      }
    }
  }

  // 3. Project-local skills
  if (projectRoot) {
    for (const skill of scanDir(projectSkillsDir(projectRoot), "project")) {
      if (!seen.has(skill.id)) {
        seen.add(skill.id);
        skills.push(skill);
      }
    }
  }

  return skills;
}

/**
 * Load the full content of a skill by its ID.
 */
export function loadSkillContent(skillId: string, projectRoot?: string): SkillContent | null {
  const skills = discoverSkills(projectRoot);
  const skill = skills.find((s) => s.id === skillId);
  if (!skill) return null;

  try {
    const content = fs.readFileSync(skill.filePath, "utf8");
    return { skill, content };
  } catch {
    return null;
  }
}

/**
 * Install a skill from a source directory into SnCode's skills dir.
 * The source directory must contain a SKILL.md file.
 * Returns the installed Skill, or null if the source is invalid.
 */
export function installSkill(sourcePath: string): Skill | null {
  const absSource = path.resolve(sourcePath);

  // Validate source
  if (!fs.existsSync(absSource) || !fs.statSync(absSource).isDirectory()) return null;
  const skillMdSource = path.join(absSource, "SKILL.md");
  if (!fs.existsSync(skillMdSource)) return null;

  const dirName = path.basename(absSource);
  const targetDir = path.join(sncodeSkillsDir(), dirName);

  // Copy recursively
  fs.mkdirSync(targetDir, { recursive: true });
  copyDirSync(absSource, targetDir);

  // Re-scan to return the installed skill
  const skills = scanDir(sncodeSkillsDir(), "sncode");
  return skills.find((s) => s.id === `sncode:${dirName}`) ?? null;
}

/**
 * Delete a skill from SnCode's skills directory.
 * Only skills with source "sncode" can be deleted.
 * Returns true if deleted, false if not found or not deletable.
 */
export function deleteSkill(skillId: string): boolean {
  if (!skillId.startsWith("sncode:")) return false;

  const dirName = skillId.slice("sncode:".length);
  const targetDir = path.join(sncodeSkillsDir(), dirName);

  if (!fs.existsSync(targetDir)) return false;

  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the SnCode skills directory path (for UI display / folder picker).
 */
export function getSkillsDir(): string {
  return sncodeSkillsDir();
}

/* ── Helpers ── */

function copyDirSync(src: string, dest: string) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
