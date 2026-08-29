import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const fixturePath = new URL("../evals/capture-tool-selection.json", import.meta.url);

test("capture tool-selection evaluation covers compliant and incorrect host traces", () => {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const scenarios = new Set(fixture.cases.map(({ scenario }) => scenario));
  assert.equal(fixture.cases.length, 20);
  assert.deepEqual(
    new Set(fixture.cases.map(({ host }) => host)),
    new Set(["chatgpt", "claude", "provider-neutral"]),
  );
  for (const scenario of [
    "correct_explicit_save",
    "correct_no_save",
    "incorrect_false_positive",
    "incorrect_false_negative",
    "incorrect_forbidden_review",
    "incorrect_duplicate_save",
  ]) {
    assert.equal(scenarios.has(scenario), true);
  }
  assert.equal(
    fixture.cases.some(
      ({ explicit_save_requested, expected_policy_result }) =>
        explicit_save_requested && expected_policy_result === "pass",
    ),
    true,
  );
  assert.equal(
    fixture.cases.some(
      ({ explicit_save_requested, expected_policy_result }) =>
        !explicit_save_requested && expected_policy_result === "fail",
    ),
    true,
  );

  const output = execFileSync(process.execPath, ["scripts/evaluate-capture-tool-selection.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.match(output, /20\/20 expected outcomes/);
  assert.match(output, /10 compliant traces, 10 correctly rejected traces/);
});
