import { z } from "zod";

export const captureValidationLimits = Object.freeze({
  projectIdCharacters: 200,
  summaryCharacters: 1_000,
  candidateClaims: 20,
  stateKeyCharacters: 200,
  candidateSummaryCharacters: 500,
  sourceNoteCharacters: 4_000,
  sourceContextCharacters: 12_000,
  idempotencyKeyCharacters: 128,
  valueBytes: 8 * 1_024,
  valueDepth: 8,
  valueNodes: 256,
  payloadBytes: 32 * 1_024,
});

export const consumptionContractVersion = "2.0";

export const consumptionValidationLimits = Object.freeze({
  taskCharacters: 2_000,
  contextBudgetMinimumBytes: 2_000,
  contextBudgetMaximumBytes: 32_000,
  contextBudgetDefaultBytes: 16_000,
});

const boundedIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const stateKeyPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function inspectJsonValue(value) {
  const pending = [{ depth: 1, value }];
  let nodes = 0;
  let maximumDepth = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    maximumDepth = Math.max(maximumDepth, current.depth);
    if (nodes > captureValidationLimits.valueNodes) break;
    if (current.depth > captureValidationLimits.valueDepth) break;

    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ depth: current.depth + 1, value: child });
    } else if (current.value && typeof current.value === "object") {
      for (const child of Object.values(current.value)) {
        pending.push({ depth: current.depth + 1, value: child });
      }
    }
  }

  return {
    bytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
    depth: maximumDepth,
    nodes,
  };
}

export const projectIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(captureValidationLimits.projectIdCharacters)
  .regex(boundedIdentifierPattern)
  .describe("Project identifier returned by list_projects");

export const contextIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(captureValidationLimits.projectIdCharacters)
  .regex(boundedIdentifierPattern)
  .describe("Work-context identifier selected in alice.");

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  brief: z.string().trim().min(1).max(4_000),
});

export const createWorkContextSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(2_000),
    visibility: z.enum(["all_members", "selected_members", "personal"]).default("all_members"),
  })
  .strict();

export const candidateClaimSchema = z
  .object({
    state_key: z
      .string()
      .trim()
      .min(1)
      .max(captureValidationLimits.stateKeyCharacters)
      .regex(stateKeyPattern)
      .describe("Stable lowercase project-state key proposed by this candidate"),
    value: z.json().superRefine((value, context) => {
      const inspected = inspectJsonValue(value);
      if (inspected.bytes > captureValidationLimits.valueBytes) {
        context.addIssue({
          code: "custom",
          message: `Candidate value exceeds ${captureValidationLimits.valueBytes} UTF-8 bytes.`,
        });
      }
      if (inspected.depth > captureValidationLimits.valueDepth) {
        context.addIssue({
          code: "custom",
          message: `Candidate value exceeds a JSON depth of ${captureValidationLimits.valueDepth}.`,
        });
      }
      if (inspected.nodes > captureValidationLimits.valueNodes) {
        context.addIssue({
          code: "custom",
          message: `Candidate value exceeds ${captureValidationLimits.valueNodes} JSON nodes.`,
        });
      }
    }),
    summary: z.string().trim().min(1).max(captureValidationLimits.candidateSummaryCharacters),
  })
  .strict();

export const saveProjectUpdateSchema = z
  .object({
    project_id: projectIdSchema.optional(),
    context_id: contextIdSchema.optional(),
    summary: z.string().trim().min(1).max(captureValidationLimits.summaryCharacters),
    candidate_claims: z
      .array(candidateClaimSchema)
      .min(1)
      .max(captureValidationLimits.candidateClaims),
    source_note: z
      .string()
      .trim()
      .min(1)
      .max(captureValidationLimits.sourceNoteCharacters)
      .optional(),
    source_context: z
      .string()
      .trim()
      .min(1)
      .max(captureValidationLimits.sourceContextCharacters)
      .describe("Only the bounded source excerpt the user explicitly asked to save")
      .optional(),
    idempotency_key: z
      .string()
      .trim()
      .min(8)
      .max(captureValidationLimits.idempotencyKeyCharacters)
      .regex(boundedIdentifierPattern)
      .describe("Stable retry key for this explicit save operation"),
  })
  .strict()
  .superRefine((payload, context) => {
    const stateKeys = new Set();
    payload.candidate_claims.forEach((claim, index) => {
      if (stateKeys.has(claim.state_key)) {
        context.addIssue({
          code: "custom",
          message: "Each state_key may appear only once in a save request.",
          path: ["candidate_claims", index, "state_key"],
        });
      }
      stateKeys.add(claim.state_key);
    });

    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > captureValidationLimits.payloadBytes) {
      context.addIssue({
        code: "custom",
        message: `Validated capture payload exceeds ${captureValidationLimits.payloadBytes} UTF-8 bytes.`,
      });
    }
  });

export const listProjectsSchema = z.object({}).strict();

export const getProjectContextSchema = z
  .object({
    project_id: projectIdSchema,
    context_id: contextIdSchema.optional(),
    task: z
      .string()
      .trim()
      .min(1)
      .max(consumptionValidationLimits.taskCharacters)
      .describe("Current task used for deterministic context selection"),
    context_budget: z
      .number()
      .int()
      .min(consumptionValidationLimits.contextBudgetMinimumBytes)
      .max(consumptionValidationLimits.contextBudgetMaximumBytes)
      .optional()
      .default(consumptionValidationLimits.contextBudgetDefaultBytes)
      .describe("Maximum UTF-8 bytes in the returned structured context package"),
  })
  .strict();

export const getActiveContextSchema = getProjectContextSchema
  .omit({ project_id: true, context_id: true })
  .strict();

const projectIdentitySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    brief: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

const workContextIdentitySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    visibility: z.enum(["all_members", "selected_members", "personal"]),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

const activeTargetSchema = z
  .object({
    connection_id: z.string(),
    surface: z.string(),
    project_id: z.string(),
    project_name: z.string(),
    context_id: z.string(),
    context_name: z.string(),
    context_description: z.string(),
    visibility: z.enum(["all_members", "selected_members", "personal"]),
    selection_version: z.string(),
    selected_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

const acceptedProvenanceSchema = z
  .object({
    accepted_state_id: z.string(),
    candidate_id: z.string(),
    evidence_id: z.string(),
    evidence_payload_hash: z.string(),
    evidence_captured_at: z.string(),
  })
  .strict();

const acceptedContextItemSchema = z
  .object({
    state_key: z.string(),
    summary: z.string(),
    value: z.json(),
    version: z.number().int().positive(),
    accepted_at: z.string(),
    provenance: acceptedProvenanceSchema,
  })
  .strict();

export const listProjectsOutputSchema = z
  .object({
    contract_version: z.literal(consumptionContractVersion),
    projects: z.array(
      projectIdentitySchema
        .extend({
          accepted_state_count: z.number().int().nonnegative(),
          accepted_state_updated_at: z.string().nullable(),
          contexts: z.array(workContextIdentitySchema),
        })
        .strict(),
    ),
    active_target: activeTargetSchema.nullable(),
  })
  .strict();

export const getProjectContextOutputSchema = z
  .object({
    contract_version: z.literal(consumptionContractVersion),
    project: projectIdentitySchema,
    context: workContextIdentitySchema
      .pick({ id: true, name: true, description: true, visibility: true, updated_at: true })
      .extend({ includes_project_wide: z.literal(true) })
      .strict(),
    task: z.string(),
    accepted_decisions: z.array(acceptedContextItemSchema),
    open_questions: z.array(
      acceptedContextItemSchema
        .extend({
          status: z.literal("open"),
        })
        .strict(),
    ),
    artifacts: z.array(
      acceptedContextItemSchema
        .extend({
          handling: z.literal("reference_only"),
        })
        .strict(),
    ),
    unresolved_conflicts: z.array(
      z
        .object({
          state_key: z.string(),
          status: z.literal("unresolved"),
          trusted_current: z
            .object({
              version: z.number().int().positive(),
              provenance: acceptedProvenanceSchema,
            })
            .strict(),
          unreviewed_alternatives: z.array(
            z
              .object({
                candidate_id: z.string(),
                evidence_id: z.string(),
                evidence_payload_hash: z.string(),
                evidence_captured_at: z.string(),
                review_status: z.literal("pending"),
              })
              .strict(),
          ),
          notice: z.string(),
        })
        .strict(),
    ),
    package: z
      .object({
        version: z.string(),
        selection_strategy: z.literal("deterministic_full_text_v2"),
        freshness: z
          .object({
            project_updated_at: z.string(),
            context_updated_at: z.string(),
            accepted_state_as_of: z.string().nullable(),
            evidence_as_of: z.string().nullable(),
            state_as_of: z.string(),
          })
          .strict(),
        budget: z
          .object({
            unit: z.literal("utf8_bytes"),
            limit: z.number().int().positive(),
            used: z.number().int().nonnegative(),
          })
          .strict(),
        omissions: z
          .object({
            total: z.number().int().nonnegative(),
            accepted_decisions: z.number().int().nonnegative(),
            open_questions: z.number().int().nonnegative(),
            artifacts: z.number().int().nonnegative(),
            unresolved_conflicts: z.number().int().nonnegative(),
            reason: z.enum(["none", "budget_exhausted"]),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
