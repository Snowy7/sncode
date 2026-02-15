import { z } from "zod";

export const providerIdSchema = z.enum(["anthropic", "codex"]);
export const authModeSchema = z.enum(["apiKey", "subscriptionToken"]);

export const newProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  folderPath: z.string().trim().min(1)
});

export const newThreadInputSchema = z.object({
  projectId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(160)
});

export const imageAttachmentSchema = z.object({
  data: z.string().min(1),
  mediaType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  name: z.string().optional()
});

export const sendMessageInputSchema = z.object({
  threadId: z.string().trim().min(1),
  content: z.string().max(12000),
  images: z.array(imageAttachmentSchema).max(10).optional()
}).refine(
  (data) => data.content.trim().length > 0 || (data.images && data.images.length > 0),
  { message: "Message must have text or at least one image" }
);

export const providerUpdateInputSchema = z.object({
  id: providerIdSchema,
  enabled: z.boolean().optional(),
  authMode: authModeSchema.optional(),
  model: z.string().trim().min(1).max(120).optional()
});

export const providerCredentialInputSchema = z.object({
  id: providerIdSchema,
  credential: z.string().trim().min(1).max(4000)
});

export const agentSettingsSchema = z.object({
  maxTokens: z.number().int().min(256).max(128000).optional(),
  maxToolSteps: z.number().int().min(1).max(100).optional(),
  subAgentModel: z.string().max(120).optional(),
  subAgentMaxTokens: z.number().int().min(256).max(128000).optional(),
  subAgentMaxToolSteps: z.number().int().min(1).max(50).optional(),
  maxConcurrentTasks: z.number().int().min(1).max(10).optional(),
  theme: z.enum(["dark", "light"]).optional(),
  thinkingLevel: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
  onboardingComplete: z.boolean().optional(),
});
