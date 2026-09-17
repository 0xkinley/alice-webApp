# Provider Acquisition Probe Deployment Review

Status: Revised design review complete; implementation, deployment, public enablement, and provider-account use are not authorized by this document.

Date: 2026-09-17

## Decision

If the empirical provider-acquisition test is approved for hosted execution, deploy the diagnostic probe as a separate, temporary CloudFormation stack named `alice-acquisition-probe` in `eu-central-1`.

Do not add the probe to `alice-private-alpha`, reuse its runtime image, database, buckets, users, OAuth clients, URLs, roles, or secrets, or deploy the Milestone 06.5 migration feature. The probe remains synthetic-only and diagnostic-only. Its one tool writes a captured test argument to disposable evidence storage; it cannot change Alice trusted state or a provider project.

This review recommends proceeding to implementation only after the product owner separately approves this design. A later implementation review must occur before any AWS mutation. A further explicit approval is required before public enablement or adding the URL to ChatGPT or Claude.

## Fixed diagnostic contract

The hosted probe must use this revised contract:

- one tool: `submit_acquisition_evidence`;
- exact title: `Submit acquisition evidence`;
- exact neutral description: `Submit diagnostic acquisition evidence for this test.`;
- exact input schema: `{ "type": "object", "additionalProperties": true }`;
- exact annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, and `openWorldHint: false`;
- exact pre-validation JSON-RPC argument snapshot plus one parsed duplicate for scoring;
- one successful evidence submission per randomly generated 256-bit session URL;
- synthetic fixture data only;
- fixed hosted TTL of 24 hours, with immediate operator deletion after scoring;
- no Alice user, project, migration, artifact, file, accepted-state, or database dependency;
- no provider password, cookie, session credential, hidden token, or account-wide export.

The exact tool name, title, neutral description, unrestricted schema, and annotations must remain identical for the Ambient, Active retrieval, and User-mediated legs. Only the saved user prompt and the defined user actions differ. The previous description, `Send all information currently available for this diagnostic acquisition test.`, is rejected because it independently instructs the model to maximize acquisition and would contaminate the Ambient control.

The existing local prototype still contains that rejected description. This design review does not authorize changing or using the prototype; replacing the description and its assertion is part of a later approved implementation.

The Lambda-hosted request ceiling must be lower than the local 8 MiB ceiling. AWS documents a 6 MB maximum for synchronous Lambda invocation, so implementation should reject requests above 5 MiB before parsing and verify the complete fixture remains well below that limit.

Any change to the tool name, description, schema, captured fields, prompts, fixture inventory, scoring, or TTL requires another review before use.

## Proposed isolated resources

The temporary stack should contain only:

1. A dedicated private, nonversioned S3 bucket with separate `artifacts/`, `sessions/`, and `records/` prefixes. Enable S3-managed encryption, bucket-owner-enforced ownership, block all public access, and deny insecure transport. Do not enable Object Lock. Retention lifecycle applies only to `sessions/` and `records/`.
2. A bucket policy enforcing transport and conditional evidence writes.
3. A dedicated CloudWatch log group with one-day retention.
4. A dedicated Lambda execution role.
5. One ARM64 ZIP Lambda using the managed `nodejs24.x` runtime, with 256 MB memory, a 30-second timeout, default 512 MB ephemeral storage, no VPC, and no Alice environment variables or secrets.
6. One buffered Lambda Function URL.
7. One public `lambda:InvokeFunctionUrl` permission, created only in the public-test stage.
8. One public `lambda:InvokeFunction` permission constrained with `lambda:InvokedViaFunctionUrl`, also created only in the public-test stage.

### Packaging decision

ECR and a container image are not justified for this diagnostic. The probe has no native binary, long-running process, custom operating-system library, custom certificate bundle, image-only runtime requirement, or package size that has been shown to exceed ZIP limits. AWS provides a supported Node.js 24 managed Lambda runtime, and the repository already includes `esbuild`.

An approved implementation should therefore:

- bundle one ESM Lambda handler and its pinned runtime dependencies with `esbuild`;
- produce one deterministic ZIP and SHA-256 manifest locally;
- create the private bucket first, then upload the ZIP to an immutable content-addressed `artifacts/<sha256>.zip` key;
- deploy the Lambda from that exact S3 object and record the resulting Lambda code SHA-256;
- grant the runtime role no access to `artifacts/`;
- delete the ZIP object with the evidence objects during final teardown.

The implementation must adapt Function URL requests to the official MCP SDK's web-standard stateless transport rather than hand-writing a partial MCP protocol. If that small adapter cannot be made correct and testable in a ZIP, the design returns for review; it does not silently add a container.

No API Gateway, custom domain, NAT gateway, VPC endpoint, database, KMS customer key, Secrets Manager secret, queue, always-on compute, or production resource is justified for this bounded test.

## Access and storage boundary

### Public request boundary

The public stage would use Function URL `AuthType: NONE` only if the exact provider surface can attach an anonymous remote MCP server. AWS states that this mode performs no Lambda authentication and that anyone with the Function URL can invoke it. The capability token in `/mcp/<token>` is therefore the session credential, not a claim that the base URL is private.

Required controls:

- generate every token from 256 random bits and display the full session URL only once;
- store only `SHA-256(token)` under `sessions/`, never the token or full URL;
- never place the token in Git, CloudFormation parameters or outputs, logs, reports, screenshots, shell history, or evidence records;
- return the same non-disclosing response for unknown, expired, and already-used tokens;
- expose no public list, read, score, delete, session-create, or administration endpoint;
- log only content-free request identifiers, response class, duration, and byte count;
- verify before public enablement that the runtime adapter and error paths do not log URL paths, request bodies, headers, or tool arguments;
- set reserved concurrency to a small bounded value and add a strict request-size rejection;
- remove both public permission resources as the first safe-stop action.

Possession of a full unused session URL allows its one evidence submission to be consumed. That is an accepted, tightly bounded risk only because the fixture is synthetic, the URL is short-lived and single-use, and the function cannot read evidence or mutate Alice. It is not an appropriate authentication model for the Alice product.

### Lambda role

The runtime role may:

- read exact objects below `sessions/`;
- create exact objects below `records/`;
- write content-free logs to its one log group.

It may not list the bucket, create or change sessions, read records, delete objects, access any production bucket, assume another role, invoke another function, access a database, or use Alice or provider credentials.

Evidence creation must use S3 `PutObject` with `If-None-Match: *`. S3 conditional writes reject an existing key instead of overwriting it, so the first concurrent submission wins and later attempts fail. The bucket policy should require the conditional-write header on `records/`.

### Operator boundary

Session creation, record retrieval, scoring, sanitization, and deletion remain operator-only actions performed with a separately authorized AWS identity, preferably from CloudShell. They are not Lambda routes. Operator commands must address exact session and record keys without bucket-wide export.

## Retention and deletion

Application behavior is authoritative for usability: reject a session at its exact 24-hour expiry even if its S3 objects still exist.

Configure a two-day lifecycle expiration on both prefixes only as a backstop. S3 lifecycle is not an exact TTL: AWS rounds age-based expiration to midnight UTC on the next day and performs deletion asynchronously. Therefore:

1. After each run, retrieve the exact record, score it, create a sanitized result, and delete the exact session and record objects.
2. Confirm both exact keys return not found.
3. After each provider phase, confirm no unreviewed records remain before disabling public access.
4. At experiment completion, remove both public Lambda permissions, delete the exact deployment ZIP and all session/record objects, delete the stack, and verify the Lambda, Function URL, role, log group, bucket, and resource-based permissions no longer exist.
5. Treat the lifecycle rule and one-day log retention as failure backstops, not proof of immediate erasure.

The stack must be removed within seven days of creation. A public test window should last no more than four hours for each provider.

## Staged deployment and stop points

Every stage uses a reviewed CloudFormation change set. A stage may advance only when its evidence is recorded and the working tree still matches the reviewed commit.

```text
Reviewed source and template
          |
          v
Stage A — private foundation
private S3 + policy + log group + role
          |
          | verify policies/lifecycle, upload exact hashed ZIP
          v
Stage B — private runtime
Node.js 24 ARM64 ZIP + Lambda + Function URL,
no public invoke permissions
          |
          | local/AWS protocol and content-free-log checks
          v
Stage C — bounded public compatibility check
add both Function URL public permissions
          |
          +--> registration, discovery, schema, authentication,
          |    plan/action, confirmation, or invocation failure
          |       -> classify exact mechanism failure,
          |          remove both permissions, stop
          |
          +--> host accepts and can invoke exact tool contract
                  -> explicit approval before fixture runs
                           |
                           v
ChatGPT: 3 legs x 3 fresh trials
          |
          v
safe-stop public permissions + inspect/delete exact evidence
          |
          v
Claude: restore permissions, 3 legs x 3 fresh trials
          |
          v
safe-stop -> score -> sanitize -> delete -> destroy stack
```

The public permissions are distinct resources because AWS requires both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` for new Function URLs. The second permission must be constrained to invocation through the Function URL. Merely setting `AuthType: NONE` is not enough to make the URL callable.

## Provider compatibility gate

Official OpenAI guidance recommends connecting an HTTPS MCP server in ChatGPT developer mode and adding OAuth only when user-specific data or writes require it. The permitted official OpenAI sources reviewed for this document do not establish which exact ChatGPT plans can invoke this write-like diagnostic tool. Anthropic documents remote custom connectors across Free, Pro, Max, Team, and Enterprise, with OAuth client configuration optional when adding a connector, but that still does not prove the exact target Claude account and surface will accept this contract.

The first bounded live action for each provider is therefore a compatibility check, not a data-acquisition result:

- record whether the exact account and surface can register the HTTPS MCP URL;
- record whether tool discovery succeeds;
- record the server-advertised and host-displayed tool name, title, description, schema, action classification, and confirmation requirement separately;
- record whether the host preserves, transforms, or rejects the unrestricted object schema;
- attempt one synthetic compatibility invocation and record whether it is allowed on the exact plan and surface;
- classify a failure as registration, OAuth/authentication, account-plan, read/write-action, metadata, schema, user-confirmation, invocation, transport, or other host restriction;
- make no project claim from a health check or tool discovery alone;
- if any compatibility branch fails, immediately remove public permissions and stop. Do not add OAuth speculatively, reuse Alice OAuth, or alter the tool to bypass a plan or action restriction.

Record the compatibility observation in this form without including the secret URL:

| Surface | Value |
| --- | --- |
| Server-advertised name/title | Exact values |
| Host-displayed name/title | Exact values or not displayed |
| Server-advertised description | Exact neutral description |
| Host-displayed description | Exact value or not displayed |
| Host action classification | Read, write, unknown, or not displayed |
| Confirmation required | Yes, no, or not reached |
| Schema handling | Unrestricted, transformed, rejected, or not displayed |
| Invocation outcome | Success or exact classified failure |

A registration, discovery, schema, plan, action, authentication, confirmation, or invocation failure proves only that this diagnostic mechanism is incompatible with the tested host configuration. It does not prove the host lacks project context or that acquisition itself is unsupported. Acquisition results may be classified only after the tool is successfully invoked and evidence capture is independently verified.

Only after that compatibility evidence and a separate go-ahead may the synthetic project fixture be created or the 18 planned evidence submissions be run.

## Execution limits and cost guardrail

The complete experiment is bounded to:

- two providers, ChatGPT first and Claude second;
- three acquisition legs per provider;
- three fresh trials per leg;
- at most 18 successful evidence submissions, plus normal MCP discovery/protocol calls;
- one synthetic project per provider and no unrelated history;
- 24-hour session expiry, four-hour maximum public window per provider, and seven-day maximum stack lifetime;
- a $1 experiment stop ceiling within the existing $5 AWS budget.

With no always-on compute, database, VPC, NAT, API Gateway, ECR, or custom domain, expected Lambda, S3, and log charges for this volume should be pennies and likely below $0.10. This is a planning estimate, not a billing guarantee. Stop before provider trials if the change set adds an unreviewed paid service, and stop the experiment if AWS actual or forecast cost attributable to the probe approaches $1.

## Evidence receipt versus host-visible success

Single-use storage remains correct for contamination control, but two outcomes must be recorded independently for every attempted trial:

1. `evidence_captured`: whether the exact record exists in S3 with a valid receipt timestamp, argument hash, and session identity;
2. `provider_observed_success`: whether the provider surface displayed or otherwise confirmed a successful tool response (`yes`, `no`, or `unknown`).

If the first write succeeds but the response is lost and the provider retries, the second call may receive `already used`. Score the captured record normally, mark `evidence_captured=yes`, record the host-visible response separately, and do not count that transport/response loss as an acquisition-content failure. Never overwrite the first record or run an automatic second evidence submission under the same trial identity.

## Implementation acceptance gates

Implementation is not ready for a deployment review until tests prove:

- the hosted adapter advertises the exact one-tool contract;
- the neutral tool metadata remains byte-for-byte constant across all three acquisition legs;
- the ZIP is deterministic, content-addressed, below Lambda package limits, and its deployed code hash matches the reviewed artifact;
- request bodies above 5 MiB are rejected before JSON parsing;
- token generation, digest lookup, exact expiry, and non-disclosing errors;
- one-call behavior under concurrent submissions using a conditional S3 write;
- no path, header, body, argument, token, or evidence content appears in application logs;
- the Lambda role cannot list storage, read records, create sessions, delete objects, or access production resources;
- expired sessions are unusable before lifecycle deletion;
- operator-only exact-key create, retrieve, score, delete, and verify-missing commands;
- separate recording of evidence capture and provider-observed success, including the lost-response/retry case;
- both public permission resources can be added and removed without replacing the private foundation;
- a safe-stop leaves the Function URL returning 403;
- stack teardown leaves no probe resources or evidence;
- local formatting, linting, typechecking, secret scanning, focused tests, fast tests, and production builds still pass;
- the production Docker context and `alice-private-alpha` template remain unaffected.

## Approval boundaries

This document authorizes no mutation. The remaining approvals are deliberately separate:

1. approve implementation of the neutral description, S3-backed diagnostic adapter, operator commands, deterministic ZIP, template, outcome fields, and tests;
2. review the resulting diff, IAM policies, change set, immutable ZIP/code hashes, tests, cost estimate, and cleanup commands;
3. approve creation of the private AWS foundation;
4. approve bounded public compatibility testing;
5. after compatibility succeeds, approve creation of synthetic provider projects and execution of the empirical trials.

At every boundary, `Host-generated does not mean alice.-verified` remains controlling. Probe output is evidence about one tested host configuration; it is not trusted Alice state and is not automatically a migration design.

## References

- [AWS Lambda Function URL access control](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)
- [AWS Lambda synchronous invocation payload limit](https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html)
- [Amazon S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
- [Amazon S3 conditional-write policy enforcement](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html)
- [Amazon S3 lifecycle timing and asynchronous deletion](https://docs.aws.amazon.com/AmazonS3/latest/userguide/troubleshoot-lifecycle.html)
- [AWS Lambda Node.js managed runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html)
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/)
- [Amazon S3 pricing](https://aws.amazon.com/s3/pricing/)
- [OpenAI: Bring your app to ChatGPT](https://learn.chatgpt.com/zh-Hans/use-cases/chatgpt-apps)
- [Anthropic: Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
