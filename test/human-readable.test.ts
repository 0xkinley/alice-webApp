import assert from "node:assert/strict";
import test from "node:test";
import { readableLabel, readableText, renderReadableValue } from "@alice/presentation";

test("the shared renderer produces safe human-readable project information", () => {
  assert.equal(readableLabel("launch.monthly_price_usd"), "Launch monthly price usd");
  assert.equal(
    readableText("<script>ignore()</script> ## **Launch** [plan](https://example.com)"),
    "Launch plan",
  );

  const rendered = renderReadableValue({
    audience: ["Founders", "Design partners"],
    approved: true,
    note: "**Keep** <em>this</em>",
  });
  assert.match(rendered, /<dl class="readable-fields">/);
  assert.match(rendered, /<ul class="readable-list">/);
  assert.match(rendered, />Audience</);
  assert.match(rendered, />Founders</);
  assert.match(rendered, />Keep this</);
  assert.doesNotMatch(rendered, /\{|\}|<script|<em>|\*\*/);
});
