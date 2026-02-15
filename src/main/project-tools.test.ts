import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTextFile, writeTextFile, editFile, listFiles, globFiles, grepFiles } from "./project-tools";

const tempDirs: string[] = [];

function createTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sncode-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("project-tools", () => {
  it("writes and reads files inside project root", () => {
    const project = createTempProject();
    writeTextFile(project, "src/index.ts", "export const x = 1;\n");
    const content = readTextFile(project, "src/index.ts");
    expect(content).toContain("x = 1");
  });

  it("blocks path escape", () => {
    const project = createTempProject();
    expect(() => writeTextFile(project, "../escape.txt", "bad")).toThrowError();
  });

  it("lists files and directories", () => {
    const project = createTempProject();
    writeTextFile(project, "file1.txt", "a");
    writeTextFile(project, "file2.txt", "b");
    fs.mkdirSync(path.join(project, "subdir"));
    const entries = listFiles(project, ".");
    const names = entries.map((e) => e.name);
    expect(names).toContain("file1.txt");
    expect(names).toContain("file2.txt");
    expect(names).toContain("subdir");
    const subdir = entries.find((e) => e.name === "subdir");
    expect(subdir?.type).toBe("dir");
  });

  it("edit_file replaces exact string", () => {
    const project = createTempProject();
    writeTextFile(project, "hello.ts", "const greeting = 'hello';\n");
    const result = editFile(project, "hello.ts", "'hello'", "'world'");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Replaced 1 occurrence");
    const content = readTextFile(project, "hello.ts");
    expect(content).toContain("'world'");
    expect(content).not.toContain("'hello'");
  });

  it("edit_file throws when old string not found", () => {
    const project = createTempProject();
    writeTextFile(project, "test.ts", "const x = 1;\n");
    expect(() => editFile(project, "test.ts", "const y = 2", "const z = 3")).toThrowError(
      "oldString not found"
    );
  });

  it("edit_file throws on ambiguous match unless replaceAll", () => {
    const project = createTempProject();
    writeTextFile(project, "dup.ts", "aaa\naaa\n");
    expect(() => editFile(project, "dup.ts", "aaa", "bbb")).toThrowError("found 2 times");
    const result = editFile(project, "dup.ts", "aaa", "bbb", true);
    expect(result.ok).toBe(true);
    const content = readTextFile(project, "dup.ts");
    expect(content).toBe("bbb\nbbb\n");
  });

  it("glob finds files by pattern", () => {
    const project = createTempProject();
    writeTextFile(project, "src/a.ts", "a");
    writeTextFile(project, "src/b.tsx", "b");
    writeTextFile(project, "src/c.js", "c");
    const result = globFiles(project, "**/*.ts");
    expect(result.matches).toContain("src/a.ts");
    expect(result.matches).not.toContain("src/b.tsx"); // .ts not .tsx
    expect(result.matches).not.toContain("src/c.js");
  });

  it("glob finds tsx files", () => {
    const project = createTempProject();
    writeTextFile(project, "App.tsx", "app");
    writeTextFile(project, "utils.ts", "utils");
    const result = globFiles(project, "**/*.tsx");
    expect(result.matches).toContain("App.tsx");
    expect(result.matches).not.toContain("utils.ts");
  });

  it("grep finds content matches", () => {
    const project = createTempProject();
    writeTextFile(project, "a.ts", "function foo() {\n  return 42;\n}\n");
    writeTextFile(project, "b.ts", "const bar = 'hello';\n");
    const result = grepFiles(project, "function");
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].file).toBe("a.ts");
    expect(result.matches[0].line).toBe(1);
    expect(result.matches[0].content).toContain("function foo");
  });

  it("grep filters by include pattern", () => {
    const project = createTempProject();
    writeTextFile(project, "code.ts", "test content here\n");
    writeTextFile(project, "readme.md", "test content here too\n");
    const result = grepFiles(project, "test content", { include: "*.ts" });
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].file).toBe("code.ts");
  });

  it("readTextFile rejects files exceeding max size", () => {
    const project = createTempProject();
    const largePath = path.join(project, "large.txt");
    // Create a file slightly over 300KB
    fs.writeFileSync(largePath, "x".repeat(300_001), "utf8");
    expect(() => readTextFile(project, "large.txt")).toThrowError("File too large");
  });

  it("readTextFile rejects directories", () => {
    const project = createTempProject();
    fs.mkdirSync(path.join(project, "subdir"));
    expect(() => readTextFile(project, "subdir")).toThrowError("Target is not a file");
  });
});
