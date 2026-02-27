/**
 * CLI installer – registers the `sncode` command in the user's ~/.local/bin
 * directory so the app can be launched from any terminal.
 *
 * Supported platforms:
 *   macOS  – shell script in ~/.local/bin/sncode, ~/.local/bin added to
 *            .zshrc / .bashrc / .profile as needed.
 *   Linux  – same as macOS.
 *   Windows – batch script in %USERPROFILE%\.local\bin\sncode.cmd, the
 *             directory is added to the current user's PATH via the registry.
 *
 * The script is (re-)written on every packaged app launch so it always points
 * to the current executable location.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { app } from "electron";

const CLI_NAME = "sncode";

function getBinDir(): string {
  return path.join(os.homedir(), ".local", "bin");
}

function getScriptPath(): string {
  const ext = process.platform === "win32" ? ".cmd" : "";
  return path.join(getBinDir(), CLI_NAME + ext);
}

function writeUnixScript(execPath: string, scriptPath: string): void {
  // Single-quote the path; escape any embedded single quotes as '\''
  const escaped = execPath.replace(/'/g, "'\\''");
  const content = `#!/bin/sh\nexec '${escaped}' "$@"\n`;
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, content, { mode: 0o755 });
}

function writeWindowsScript(execPath: string, scriptPath: string): void {
  // Escape % characters so cmd.exe does not expand them as env-var references
  const escaped = execPath.replace(/%/g, "%%");
  // 'start ""' launches the GUI app detached; the leading "" is the window title
  const content = `@echo off\r\nstart "" "${escaped}" %*\r\n`;
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, content);
}

/** Append an export line to the given shell RC file if not already present. */
function appendToRcFile(rcPath: string, binDir: string): void {
  const exportLine = `\n# Added by SnCode\nexport PATH="$PATH:${binDir}"\n`;
  try {
    const content = fs.readFileSync(rcPath, "utf-8");
    if (!content.includes(binDir)) {
      fs.appendFileSync(rcPath, exportLine);
    }
  } catch {
    // File doesn't exist or isn't readable – skip
  }
}

function ensureUnixPath(binDir: string): void {
  const home = os.homedir();

  // Touch the most common shell RC files that exist
  const candidates = [".zshrc", ".bashrc", ".profile"];
  let updated = false;
  for (const rc of candidates) {
    const rcPath = path.join(home, rc);
    if (fs.existsSync(rcPath)) {
      appendToRcFile(rcPath, binDir);
      updated = true;
    }
  }

  // If none of the standard RC files exist, create .profile
  if (!updated) {
    const profilePath = path.join(home, ".profile");
    fs.writeFileSync(
      profilePath,
      `# Added by SnCode\nexport PATH="$PATH:${binDir}"\n`,
    );
  }
}

function ensureWindowsPath(binDir: string): void {
  try {
    // Read the current user PATH from the registry
    const queryOutput = execFileSync(
      "reg",
      ["query", "HKCU\\Environment", "/v", "PATH"],
      { encoding: "utf8" },
    );

    const match = queryOutput.match(/PATH\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i);
    const currentPath = match ? match[1].trim() : "";

    const dirs = currentPath.split(";").map((d) => d.trim()).filter(Boolean);
    const alreadyPresent = dirs.some(
      (d) => path.resolve(d) === path.resolve(binDir),
    );

    if (!alreadyPresent) {
      const newPath = currentPath ? `${currentPath};${binDir}` : binDir;
      execFileSync("reg", [
        "add",
        "HKCU\\Environment",
        "/v",
        "PATH",
        "/t",
        "REG_EXPAND_SZ",
        "/d",
        newPath,
        "/f",
      ]);
    }
  } catch {
    // Registry access may be unavailable; silently continue
  }
}

/**
 * Write (or overwrite) the `sncode` launcher script in ~/.local/bin and ensure
 * that directory is on the user's PATH.  Runs only in the packaged app.
 */
export function registerCliCommand(): void {
  if (!app.isPackaged) return;

  try {
    const execPath = process.execPath;
    const scriptPath = getScriptPath();
    const binDir = getBinDir();

    if (process.platform === "win32") {
      writeWindowsScript(execPath, scriptPath);
      ensureWindowsPath(binDir);
    } else {
      writeUnixScript(execPath, scriptPath);
      ensureUnixPath(binDir);
    }
  } catch {
    // Never crash the app because of CLI registration failures
  }
}
