import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatch } from "./apply-patch";

const tempDirs: string[] = [];

function createTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sncode-patch-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("applyPatch", () => {
  it("applies add/update/delete actions", () => {
    const project = createTempProject();
    fs.writeFileSync(path.join(project, "a.txt"), "hello\nworld\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Add File: b.txt",
      "+line one",
      "+line two",
      "*** Update File: a.txt",
      "@@",
      "-hello",
      "+hi",
      " world",
      "*** Delete File: b.txt",
      "*** End Patch",
      "",
    ].join("\n");

    const result = applyPatch(project, patch);
    expect(result.filesChanged.length).toBe(2);
    expect(fs.readFileSync(path.join(project, "a.txt"), "utf8")).toBe("hi\nworld\n");
    expect(fs.existsSync(path.join(project, "b.txt"))).toBe(false);
  });

  it("supports move-to updates", () => {
    const project = createTempProject();
    fs.writeFileSync(path.join(project, "src.txt"), "alpha\nbeta\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: src.txt",
      "*** Move to: dst.txt",
      "@@",
      " alpha",
      "-beta",
      "+gamma",
      "*** End Patch",
      "",
    ].join("\n");

    applyPatch(project, patch);
    expect(fs.existsSync(path.join(project, "src.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(project, "dst.txt"), "utf8")).toBe("alpha\ngamma\n");
  });

  it("rolls back all file changes if a later hunk fails", () => {
    const project = createTempProject();
    fs.writeFileSync(path.join(project, "a.txt"), "one\ntwo\n", "utf8");
    fs.writeFileSync(path.join(project, "b.txt"), "x\ny\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-one",
      "+ONE",
      " two",
      "*** Update File: b.txt",
      "@@",
      "-missing",
      "+z",
      "*** End Patch",
      "",
    ].join("\n");

    expect(() => applyPatch(project, patch)).toThrowError();
    expect(fs.readFileSync(path.join(project, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(fs.readFileSync(path.join(project, "b.txt"), "utf8")).toBe("x\ny\n");
  });
});
