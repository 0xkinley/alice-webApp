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

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  brief: z.string().trim().min(1).max(4_000),
});

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
    project_id: projectIdSchema,
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

export const getProjectContextSchema = z.object({
  project_id: projectIdSchema,
  task: z
    .string()
    .min(1)
    .max(2_000)
    .describe("The current task, used to describe the context package"),
  context_budget: z.number().int().min(256).max(8_000).optional().default(2_000),
});
