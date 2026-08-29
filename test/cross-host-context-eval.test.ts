import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const fixturePath = new URL("../evals/cross-host-context.json", import.meta.url);

test("cross-host evaluation uses the canonical fixture without manual restatement", () => {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  assert.equal(fixture.canonical_fixture, "docs/spike/round-trip-fixture.md");
  assert.deepEqual(new Set(fixture.cases.map(({ host }) => host)), new Set(["chatgpt", "claude"]));
  assert.deepEqual(
    fixture.cases.map(({ manually_restated_decision_ids }) => manually_restated_decision_ids),
    [[], []],
  );

  const output = execFileSync(
    process.execPath,
    ["--conditions=development", "scripts/evaluate-cross-host-context.mjs"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.match(output, /2\/2 canonical continuation traces/);
  assert.match(output, /Claude A-C, ChatGPT A-D/);
});
