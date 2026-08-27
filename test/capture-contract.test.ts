import assert from "node:assert/strict";
import { test } from "node:test";
import { captureValidationLimits, saveProjectUpdateSchema } from "@alice/schemas";

const basePayload = {
  project_id: "project_switchboard_launch",
  summary: "Save one launch decision",
  candidate_claims: [
    {
      state_key: "launch.monthly_price_usd",
      value: 24,
      summary: "Monthly launch price",
    },
  ],
  source_note: "Explicitly supplied by the user",
  source_context: "The user selected this exact source excerpt.",
  idempotency_key: "capture-contract-001",
};

function errorMessages(payload) {
  const result = saveProjectUpdateSchema.safeParse(payload);
  assert.equal(result.success, false);
  return result.error.issues.map(({ message }) => message).join("\n");
}

test("accepts the finalized bounded save_project_update contract", () => {
  const parsed = saveProjectUpdateSchema.parse(basePayload);
  assert.deepEqual(parsed, basePayload);
  assert.deepEqual(captureValidationLimits, {
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
});

test("rejects ambiguous, unknown, and unsafe capture fields", () => {
  assert.match(
    errorMessages({
      ...basePayload,
      candidate_claims: [
        ...basePayload.candidate_claims,
        { ...basePayload.candidate_claims[0], value: 29 },
      ],
    }),
    /state_key may appear only once/,
  );
  assert.match(errorMessages({ ...basePayload, accept: true }), /Unrecognized key/);
  assert.match(
    errorMessages({ ...basePayload, idempotency_key: "unsafe retry key" }),
    /Invalid string/,
  );
});

test("enforces candidate JSON byte, depth, and node limits", () => {
  assert.match(
    errorMessages({
      ...basePayload,
      candidate_claims: [
        {
          ...basePayload.candidate_claims[0],
          value: "x".repeat(captureValidationLimits.valueBytes),
        },
      ],
    }),
    /exceeds 8192 UTF-8 bytes/,
  );

  let nestedValue: unknown = "leaf";
  for (let index = 0; index < captureValidationLimits.valueDepth; index += 1) {
    nestedValue = [nestedValue];
  }
  assert.match(
    errorMessages({
      ...basePayload,
      candidate_claims: [{ ...basePayload.candidate_claims[0], value: nestedValue }],
    }),
    /exceeds a JSON depth of 8/,
  );

  assert.match(
    errorMessages({
      ...basePayload,
      candidate_claims: [
        {
          ...basePayload.candidate_claims[0],
          value: Array.from({ length: captureValidationLimits.valueNodes }, () => null),
        },
      ],
    }),
    /exceeds 256 JSON nodes/,
  );
});

test("enforces the complete validated payload limit independently of field limits", () => {
  const candidate_claims = Array.from({ length: 3 }, (_, index) => ({
    state_key: `large.value_${index}`,
    value: "x".repeat(8_000),
    summary: `Bounded value ${index}`,
  }));
  assert.match(
    errorMessages({
      ...basePayload,
      candidate_claims,
      source_context: "y".repeat(captureValidationLimits.sourceContextCharacters),
    }),
    /payload exceeds 32768 UTF-8 bytes/,
  );
});
