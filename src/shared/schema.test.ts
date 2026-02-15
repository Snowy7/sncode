import { describe, expect, it } from "vitest";
import { newProjectInputSchema, newThreadInputSchema, sendMessageInputSchema, providerUpdateInputSchema, agentSettingsSchema } from "./schema";

describe("schema", () => {
  it("accepts valid project payload", () => {
    const payload = newProjectInputSchema.parse({
      name: "demo",
      folderPath: "C:/repo"
    });
    expect(payload.name).toBe("demo");
  });

  it("rejects empty project name", () => {
    expect(() =>
      newProjectInputSchema.parse({ name: "", folderPath: "C:/repo" })
    ).toThrowError();
  });

  it("rejects empty project folderPath", () => {
    expect(() =>
      newProjectInputSchema.parse({ name: "foo", folderPath: "" })
    ).toThrowError();
  });

  it("accepts valid thread input", () => {
    const payload = newThreadInputSchema.parse({
      projectId: "abc123",
      title: "Test thread"
    });
    expect(payload.title).toBe("Test thread");
  });

  it("rejects empty thread title", () => {
    expect(() =>
      newThreadInputSchema.parse({ projectId: "abc", title: "" })
    ).toThrowError();
  });

  it("rejects empty message content", () => {
    expect(() =>
      sendMessageInputSchema.parse({
        threadId: "abc",
        content: ""
      })
    ).toThrowError();
  });

  it("accepts message with images and no text", () => {
    const payload = sendMessageInputSchema.parse({
      threadId: "abc",
      content: "",
      images: [{ data: "abc123", mediaType: "image/png" }]
    });
    expect(payload.images?.length).toBe(1);
  });

  it("rejects message with invalid image media type", () => {
    expect(() =>
      sendMessageInputSchema.parse({
        threadId: "abc",
        content: "test",
        images: [{ data: "abc", mediaType: "image/bmp" }]
      })
    ).toThrowError();
  });

  it("accepts valid provider update", () => {
    const payload = providerUpdateInputSchema.parse({
      id: "anthropic",
      enabled: true,
      model: "claude-haiku-4-5"
    });
    expect(payload.id).toBe("anthropic");
    expect(payload.enabled).toBe(true);
  });

  it("rejects invalid provider id", () => {
    expect(() =>
      providerUpdateInputSchema.parse({ id: "invalid", enabled: true })
    ).toThrowError();
  });

  it("accepts valid agent settings", () => {
    const payload = agentSettingsSchema.parse({
      maxTokens: 8192,
      maxToolSteps: 10,
      subAgentModel: "claude-haiku-4-5",
      subAgentMaxTokens: 4096,
    });
    expect(payload.maxTokens).toBe(8192);
    expect(payload.subAgentMaxTokens).toBe(4096);
  });

  it("rejects out of range agent settings", () => {
    expect(() =>
      agentSettingsSchema.parse({ maxTokens: 100 })
    ).toThrowError(); // min is 256

    expect(() =>
      agentSettingsSchema.parse({ maxToolSteps: 200 })
    ).toThrowError(); // max is 100
  });
});
