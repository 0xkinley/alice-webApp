import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const fixturePath = new URL("../evals/private-alpha-capabilities.json", import.meta.url);
const matrixPath = new URL("../evals/host-surface-compatibility.json", import.meta.url);

test("private-alpha evaluation covers every required capability and exact host surface", () => {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  assert.equal(fixture.capabilities.length, 12);
  assert.deepEqual(
    new Set(
      fixture.cases
        .filter(({ expected_policy_result }) => expected_policy_result === "pass")
        .map(({ capability }) => capability),
    ),
    new Set(fixture.capabilities),
  );
  assert.deepEqual(
    new Set(fixture.cases.map(({ host }) => host)),
    new Set(["chatgpt", "claude", "provider-neutral", "cross-host"]),
  );
  assert.equal(matrix.surfaces.length, 7);
  assert.equal(matrix.invocation_denominator_contract, "evals/host-invocation-denominators.json");
  assert.equal(
    matrix.surfaces.every(
      ({ advertised, results }) =>
        advertised === false &&
        Object.keys(results).length === 7 &&
        Object.values(results).every((status) => status === "untested"),
    ),
    true,
  );

  const output = execFileSync(
    process.execPath,
    ["scripts/evaluate-private-alpha-capabilities.mjs"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.match(output, /27\/27 expected outcomes/);
  assert.match(output, /22 compliant traces, 5 correctly rejected traces/);
  assert.match(output, /7 surfaces, 49 explicit capability results, 0 advertised surfaces/);
});
