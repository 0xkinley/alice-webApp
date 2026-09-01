import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const contractPath = new URL("../evals/host-invocation-denominators.json", import.meta.url);

test("host invocation denominator stays explicit, per-surface, and content-free", () => {
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  assert.equal(contract.contract, "alice.host-invocation-denominator.v1");
  assert.deepEqual(contract.method.outcomes, ["successful_read", "failed_read", "no_call"]);
  assert.equal(contract.surface_denominators.length, 10);
  assert.equal(
    contract.surface_denominators.every(
      ({ status, live_run_id }) => status === "untested" && live_run_id === null,
    ),
    true,
  );

  const output = execFileSync(
    process.execPath,
    ["scripts/evaluate-host-invocation-denominators.mjs"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.match(output, /9\/9 expected outcomes/);
  assert.match(output, /2 valid cohort fixtures, 7 correctly rejected fixtures/);
  assert.match(output, /10 surfaces, 0 measurable, 10 untested/);
});
