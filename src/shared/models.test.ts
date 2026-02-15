import { describe, expect, it } from "vitest";
import { ALL_MODELS, labelForModelId, providerForModelId, smallestAvailableModelId } from "./models";

describe("models", () => {
  it("has at least one model", () => {
    expect(ALL_MODELS.length).toBeGreaterThan(0);
  });

  it("labelForModelId returns correct label", () => {
    expect(labelForModelId("claude-opus-4-6")).toBe("Opus 4.6");
    expect(labelForModelId("claude-haiku-4-5")).toBe("Haiku 4.5");
  });

  it("labelForModelId returns id for unknown model", () => {
    expect(labelForModelId("unknown-model")).toBe("unknown-model");
  });

  it("providerForModelId returns correct provider", () => {
    expect(providerForModelId("claude-opus-4-6")).toBe("anthropic");
    expect(providerForModelId("codex-5.3")).toBe("codex");
  });

  it("providerForModelId returns null for unknown model", () => {
    expect(providerForModelId("unknown")).toBeNull();
  });

  it("smallestAvailableModelId returns haiku when anthropic authorized", () => {
    const result = smallestAvailableModelId(new Set(["anthropic"]));
    expect(result).toBe("claude-haiku-4-5");
  });

  it("smallestAvailableModelId returns codex-mini when only codex authorized", () => {
    const result = smallestAvailableModelId(new Set(["codex"]));
    expect(result).toBe("codex-5.1-mini");
  });

  it("smallestAvailableModelId returns haiku when both authorized", () => {
    const result = smallestAvailableModelId(new Set(["anthropic", "codex"]));
    expect(result).toBe("claude-haiku-4-5");
  });

  it("smallestAvailableModelId returns null when none authorized", () => {
    const result = smallestAvailableModelId(new Set());
    expect(result).toBeNull();
  });
});
