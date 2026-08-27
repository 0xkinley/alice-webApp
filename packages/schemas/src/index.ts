import { z } from "zod";

export const projectIdSchema = z
  .string()
  .min(1)
  .max(200)
  .describe("Project identifier returned by list_projects");

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  brief: z.string().trim().min(1).max(4_000),
});

export const candidateClaimSchema = z.object({
  state_key: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  value: z.json(),
  summary: z.string().min(1).max(500),
});

export const saveProjectUpdateSchema = z.object({
  project_id: projectIdSchema,
  summary: z.string().min(1).max(1_000),
  candidate_claims: z.array(candidateClaimSchema).min(1).max(20),
  source_note: z.string().max(4_000).optional(),
  idempotency_key: z.string().min(8).max(200),
});

export const getProjectContextSchema = z.object({
  project_id: projectIdSchema,
  task: z
    .string()
    .min(1)
    .max(2_000)
    .describe("The current task, used to describe the context package"),
  context_budget: z.number().int().min(256).max(8_000).optional().default(2_000),
});
