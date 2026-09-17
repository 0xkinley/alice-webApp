# Provider Acquisition Probe Deployment Review

Status: Phase 1 local implementation complete and verified; Stages A and B created and verified privately on 2026-09-17; public enablement and provider-account use require later explicit approval.

Date: 2026-09-17

## Decision

If the empirical provider-acquisition test is approved for hosted execution, deploy the diagnostic probe as a separate, temporary CloudFormation stack named `alice-acquisition-probe` in `eu-central-1`.

Do not add the probe to `alice-private-alpha`, reuse its runtime image, database, buckets, users, OAuth clients, URLs, roles, or secrets, or deploy the Milestone 06.5 migration feature. The probe remains synthetic-only and diagnostic-only. Its one tool writes a captured test argument to disposable evidence storage; it cannot change Alice trusted state or a provider project.

The product owner approved Phase 1 local implementation and then the isolated Stage A and Stage B AWS mutations on 2026-09-17. Further explicit approvals are required before public enablement, adding the URL to ChatGPT or Claude, creating provider fixtures, or running provider trials.

## Fixed diagnostic contract

The hosted probe must use this revised contract:

- one tool: `submit_acquisition_evidence`;
- exact title: `Submit acquisition evidence`;
- exact neutral description: `Submit diagnostic acquisition evidence for this test.`;
- exact input schema: `{ "type": "object", "additionalProperties": true }`;
- exact annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, and `openWorldHint: false`;
- exact pre-validation JSON-RPC argument snapshot plus one parsed duplicate for scoring;
- Phase 1 allows one successful evidence submission per randomly generated 256-bit session URL;
- synthetic fixture data only;
- fixed hosted TTL of 24 hours, with immediate operator deletion after scoring;
- no Alice user, project, migration, artifact, file, accepted-state, or database dependency;
- no provider password, cookie, session credential, hidden token, or account-wide export.

The exact tool name, title, neutral description, unrestricted schema, and annotations must remain identical for the Ambient, Active retrieval, and User-mediated legs. Only the saved user prompt and the defined user actions differ. The previous description, `Send all information currently available for this diagnostic acquisition test.`, is rejected because it independently instructs the model to maximize acquisition and would contaminate the Ambient control.

The implemented local and Lambda adapters use the approved neutral description and fixed contract. Tests inspect the provider-visible `tools/list` result byte-for-byte for the name, title, description, schema, and annotations.

The Lambda-hosted request ceiling must be lower than the local 8 MiB ceiling. AWS documents a 6 MB maximum for synchronous Lambda invocation, so implementation should reject requests above 5 MiB before parsing and verify the complete fixture remains well below that limit.

Any change to the tool name, description, schema, captured fields, prompts, fixture inventory, scoring, or TTL requires another review before use.

## Call-count strategy

One-call packaging is the first measured condition, not the Alice product requirement.

### Phase 1 — single-call capability

The initial implementation and 18-run experiment remain single-call:

- one session accepts one successful evidence call;
- each Phase 1 prompt explicitly requests exactly one call;
- concurrent or later calls cannot overwrite the first record;
- a second-call attempt is recorded as a content-free outcome and does not turn missing markers into an acquisition failure;
- evidence capture, provider-visible success, response-loss retry, intentional additional-call attempt, and truncation are separate observations.

Phase 1 can conclude `one-call complete` or `one-call incomplete`. It cannot conclude that acquisition is unsupported solely from incomplete packaging.

### Phase 2 — bounded multi-call capability

A provider/surface/leg must enter Phase 2 when it attempts an additional call, indicates chunking or truncation, reaches the request ceiling, or produces any incomplete Phase 1 repetition whose gap could be caused by packaging rather than access.

Phase 2 is separately versioned and uses:

- the identical tool name, title, neutral description, unrestricted schema, and annotations;
- a leg-specific saved prompt that permits at most ten calls;
- three fresh repetitions for each triggered provider/surface/leg;
- at most ten append-only evidence records per session;
- a 5 MiB ceiling per call and 20 MiB cumulative ceiling per session;
- server-assigned monotonic sequence numbers and scoring both per call and over the receipt-ordered aggregate;
- duplicate-marker detection within and across calls;
- the same synthetic-only rule, 24-hour TTL, immediate exact-key deletion, and provider/account scoping.

Phase 2 can conclude `multi-call complete` or `partial after bounded multi-call`. A diagnostic-mechanism compatibility failure remains a separate result. `Acquisition unsupported` is not available as a conclusion until every triggered bounded multi-call test is complete.

The currently proposed implementation approval covers Phase 1 only. Phase 2 remains disabled and unimplemented until a trigger is observed. Because its experimental contract is fixed here, a trigger requires a focused implementation and test review, not another product-architecture exercise. The implementation must demonstrate an atomic ten-call/20-MiB cap and append-only sequence allocation without overwriting evidence before Phase 2 deployment.

## Proposed isolated resources

The temporary stack should contain only:

1. A dedicated private, nonversioned S3 bucket with separate `artifacts/`, `sessions/`, `records/`, and content-free `outcomes/` prefixes. Enable S3-managed encryption, bucket-owner-enforced ownership, block all public access, and deny insecure transport. Do not enable Object Lock. Retention lifecycle applies only to `sessions/`, `records/`, and `outcomes/`.
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
- use ordinary unreserved concurrency under the existing Frankfurt account-wide limit of 10 and add a strict request-size rejection; do not request a quota increase or provisioned concurrency for this bounded proof;
- remove both public permission resources as the first safe-stop action.

Possession of a full unused Phase 1 session URL allows its one evidence submission to be consumed. A future Phase 2 URL would allow only its bounded ten-call/20-MiB sequence. That is an accepted, tightly bounded risk only because the fixture is synthetic, the URL is short-lived, and the function cannot read evidence or mutate Alice. It is not an appropriate authentication model for the Alice product.

### Lambda role

The runtime role may:

- read exact token-digest objects below `sessions/by-token/`;
- create exact objects below `records/`;
- create content-free observations below `outcomes/`;
- write content-free logs to its one log group.

It may not list the bucket, create or change sessions, read records, delete objects, access any production bucket, assume another role, invoke another function, access a database, or use Alice or provider credentials.

Evidence creation must use S3 `PutObject` with `If-None-Match: *`. S3 conditional writes reject an existing key instead of overwriting it, so the first concurrent submission wins and later attempts fail. The bucket policy should require the conditional-write header on `records/`.

### Operator boundary

Session creation, record retrieval, scoring, sanitization, and deletion remain operator-only actions performed with a separately authorized AWS identity, preferably from CloudShell. They are not Lambda routes. Operator commands must address exact session and record keys without bucket-wide export.

## Retention and deletion

Application behavior is authoritative for usability: reject a session at its exact 24-hour expiry even if its S3 objects still exist.

Configure a two-day lifecycle expiration on session, record, and outcome prefixes only as a backstop. S3 lifecycle is not an exact TTL: AWS rounds age-based expiration to midnight UTC on the next day and performs deletion asynchronously. Therefore:

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

### Stage A execution receipt — 2026-09-17

The reviewed commit `ad9a9ac` was validated through the Frankfurt CloudFormation API and deployed only as Stage A in account `004669176288` through change set `stage-a-private-foundation-ad9a9ac`.

- Stack: `alice-acquisition-probe`
- Stack ID: `arn:aws:cloudformation:eu-central-1:004669176288:stack/alice-acquisition-probe/08b51fa0-b27d-11f1-8187-0affed9b4c3d`
- Creation time: `2026-09-17T09:49:11.261000+00:00`
- Status: `CREATE_COMPLETE`
- Parameters: `DeployRuntime=false`, `EnablePublicAccess=false`, `ArtifactKey=pending`, and `AllowedHost=pending.invalid`
- Created resources only: private `ProbeBucket`, `ProbeBucketPolicy`, `ProbeLogGroup`, and `ProbeExecutionRole`
- Bucket: `alice-acquisition-probe-004669176288-eu-central-1`; empty at verification; S3-managed `AES256`; bucket-owner enforced; all four public-access-block controls enabled; versioning absent; two-day rules scoped to `sessions/`, `records/`, and `outcomes/`
- Bucket policy: deny insecure transport and require `If-None-Match: *` for `records/*` and `outcomes/*`
- Role: logs create-stream/put-events only for the probe log group, `s3:GetObject` only for `sessions/by-token/*`, and conditional `s3:PutObject` only for `records/*` and `outcomes/*`; no list, delete, session creation, record read, artifact access, or production access
- Log group: `/aws/lambda/alice-acquisition-probe-runtime`, one-day retention, zero stored bytes at verification
- Confirmed absent: probe Lambda, Function URL, both public permissions, deployment ZIP, sessions, records, outcomes, provider configuration, and changes to `alice-private-alpha`

At the Stage A checkpoint the probe was not callable and no URL existed; uploading the content-addressed ZIP and creating Stage B still required the approval later recorded below.

### Stage B execution receipt — 2026-09-17

The product owner approved the private-runtime stage. The artifact was uploaded with `If-None-Match: *` and a signed SHA-256 checksum before each CloudFormation review. Public enablement remained false throughout.

- The first reviewed change set, `stage-b-private-runtime-c3da6768`, contained exactly two additions: `ProbeFunction` and `ProbeFunctionUrl`. Lambda rejected the two-execution reservation because the Frankfurt account limit is 10 and AWS requires at least 10 executions to remain unreserved. CloudFormation removed the partial resources and returned the four-resource foundation to `UPDATE_ROLLBACK_COMPLETE`.
- The bounded remediation omits only `ReservedConcurrentExecutions`, uses the existing account-wide limit of 10 as the aggregate cap, and requests neither a quota increase nor provisioned concurrency. Focused structural tests now require the reservation to remain absent. Change set `stage-b-private-runtime-unreserved-c3da6768` again contained exactly the two additions and reached `UPDATE_COMPLETE` at `2026-09-17T10:08:06.231000+00:00`.
- The first private direct invocation then exposed an ESM packaging error, `Dynamic require of "tty" is not supported`, before request handling. No session or evidence object existed. The deterministic builder now emits `index.cjs`, resolves dependencies through the Node/CommonJS condition, and a test loads the built bundle as Node would before accepting the ZIP.
- Corrected ZIP: 1,820,515 bytes; SHA-256 `bfbc0ee3339c1fc0043470ceecc6fe6041656ee3724e3fa1935c78d9e3ef3238`; S3 checksum `v7wO4zOcH8AENHDO7Mb+YEFlbuNyTj+hk1x42ePvMjg=`; exact key `artifacts/bfbc0ee3339c1fc0043470ceecc6fe6041656ee3724e3fa1935c78d9e3ef3238.zip`.
- Change set `stage-b-commonjs-runtime-bfbc0ee3` changed the function code without replacement; CloudFormation also marked the unchanged Function URL reference as a conditional dependent. The function is `Active` with `Successful` last-update state and its deployed `CodeSha256` exactly matches the uploaded checksum.
- A signed direct invocation of `/health` returned Lambda success and HTTP 200 with `service=alice-acquisition-probe`, `status=ok`, `alice_state_access=false`, and `call_mode=single-call-v1`.
- The stack has exactly six resources: the four Stage A resources, one Node.js 24 ARM64 Lambda, and one buffered Function URL. The URL retains `AuthType=NONE` for the future compatibility stage, but the function has no resource policy, CloudFormation has zero `AWS::Lambda::Permission` resources, and an unsigned external request returns HTTP 403.
- The bucket contains only the corrected content-addressed ZIP. The superseded broken ZIP was permanently deleted after the corrected function became active. There are zero `sessions/`, `records/`, or `outcomes/` objects. Eight one-day log events record only the packaging failure and platform metadata; inspection found no host, path, authorization, cookie, session, record, outcome, request-body, or tool-argument material.
- `AllowedHost` remains `pending.invalid`, `EnablePublicAccess=false`, and there is no ChatGPT/Claude configuration, synthetic provider fixture, trial, normal Alice-state access, or change to `alice-private-alpha`.
- The final local gate passes formatting, linting, application-plus-diagnostic typechecking, secret scanning, all four deterministic evaluations, all 189 fast tests, all 31 disposable PostgreSQL 17 tests, deterministic probe packaging, and both production builds. The disposable database container was removed.

Stage B proves only that the isolated private runtime loads and returns its health contract. It does not authorize Stage C, create a usable provider URL, or produce acquisition evidence.

### Stage C operator-protocol receipt — 2026-09-17

The product owner approved a bounded public compatibility window. This receipt covers only the public permission mechanics and an operator-driven MCP protocol check; no ChatGPT or Claude host was configured, so provider-host compatibility remains untested.

- Reviewed change set `stage-c-public-compatibility-0d0e49d` added only `ProbeFunctionPublicInvokePermission` and `ProbeFunctionUrlPublicPermission`, conditionally updated the Function URL dependency, and changed only the function environment without replacement. The stack reached `UPDATE_COMPLETE` at `2026-09-17T10:39:07.372000+00:00` with exactly eight resources.
- The live resource policy contained exactly two public statements: `lambda:InvokeFunctionUrl` constrained to `FunctionUrlAuthType=NONE`, and `lambda:InvokeFunction` constrained to `lambda:InvokedViaFunctionUrl=true`. `AllowedHost` matched the exact Function URL hostname, and the deployed code checksum remained `v7wO4zOcH8AENHDO7Mb+YEFlbuNyTj+hk1x42ePvMjg=`.
- An unsigned `/health` request returned HTTP 200 with `alice_state_access=false` and `call_mode=single-call-v1`.
- One operator-only synthetic session exercised MCP `initialize` and `tools/list` over the public URL. Both returned HTTP 200, protocol version `2025-06-18`, server `alice-acquisition-probe` version `1.0.0`, and the exact one-tool contract: `submit_acquisition_evidence`, neutral title/description, unrestricted object schema, and the reviewed non-read-only/non-destructive/non-idempotent/closed-world annotations.
- One tiny operator marker was submitted only to prove the invocation and storage path. The tool returned HTTP 200. Independent S3 inspection proved the parsed object, exact JSON, SHA-256, UTF-8 byte count, and session ID matched, and that the bearer token was absent from the record. Exactly two session objects and one record existed; no outcome object existed. This was not provider material, the generated fixture, or acquisition evidence about ChatGPT or Claude capability.
- The CloudWatch query returned zero events for the compatibility window, so no request body, session token, or tool arguments were present in logs at that checkpoint.
- After explicit deletion confirmation, the exact two session objects, one record, and temporary operator token file were permanently removed. All three objects returned missing and the `sessions/`, `records/`, and `outcomes/` prefixes were empty.
- Reviewed safe-stop change set `stage-c-safe-stop-0d0e49d` removed exactly the two public permission resources, restored `AllowedHost=pending.invalid`, and made only the expected Function URL dependency and non-replacement function-environment changes. The stack returned to `UPDATE_COMPLETE` at `2026-09-17T10:48:25.577000+00:00`.
- Final verification found exactly the six Stage B resources, no Lambda resource policy, `EnablePublicAccess=false`, `AllowedHost=pending.invalid` in both the parameter and function environment, external HTTP 403, the unchanged Lambda code checksum, no diagnostic objects, and only the corrected content-addressed ZIP in the bucket.

This receipt proves that the isolated Lambda can expose and execute the reviewed MCP contract during a bounded public window and can return to its private safe-stop state without retained diagnostic evidence. It does not prove that ChatGPT or Claude can register, display, authorize, confirm, or invoke the tool; it does not authorize fixture creation or any Phase 1 acquisition trial.

### Stage C ChatGPT-host compatibility receipt — 2026-09-17

The product owner separately approved one bounded ChatGPT developer-mode compatibility check. This check used only a two-field synthetic protocol marker; it did not create the provider fixture, read a ChatGPT project, or run an ambient, active-retrieval, or user-mediated acquisition trial.

- Reviewed change set `stage-c-chatgpt-compatibility-6b06dc3` restored the same two public Function URL permissions, changed only the expected Function URL dependency and non-replacement function environment, and left the deployed Lambda code checksum unchanged. The public window reached `UPDATE_COMPLETE` at `2026-09-17T10:54:38.149000+00:00`.
- The observed surface was ChatGPT web developer mode in a Work conversation on an account whose profile displayed `Pro`; region and host build were not exposed. ChatGPT accepted the secret path-scoped HTTPS MCP URL as a personal plugin using `No Auth`. Creation required the custom-server risk acknowledgement, and first use required a separate `Connect` consent.
- Registration and discovery succeeded. The server advertised `submit_acquisition_evidence` with title `Submit acquisition evidence`, the neutral diagnostic description, an unrestricted object schema, and non-read-only/non-destructive/non-idempotent/closed-world annotations. The plugin directory instead displayed the configured app name and description, developer `App developer`, category `Other`, and version `1.0.0`; it did not expose the raw tool name, schema, annotations, or a read/write classification. In chat, the host displayed `Used Alice acquisition compatibility probe` and the activity label `Submitting ChatGPT compatibility evidence`.
- The permission-gated first conversation did not resume the pending call after linking. Starting a fresh Work conversation from `Try in chat` and repeating the exact unchanged compatibility prompt produced one tool invocation. ChatGPT reported `Submitted exactly once` with record receipt `92c43ab6-0f6b-45a7-8f10-8714ac5b920c`.
- Independent S3 inspection found exactly one record for the one-call session and no outcome object. Its parsed arguments exactly matched the requested two-field object. ChatGPT reserialized the object with the two keys in the opposite order, so the captured exact JSON was not byte-identical to the prompt's textual object; the probe nevertheless preserved that exact 131-byte wire JSON and independently verified its SHA-256 and byte count. The session token was absent from the record, and the compatibility-window CloudWatch query returned zero events.
- After explicit confirmation, the temporary ChatGPT plugin was uninstalled, the two session objects and one record were permanently deleted, the temporary token/template files were absent, and all diagnostic prefixes were empty. No provider fixture, project material, ordinary Alice state, or `alice-private-alpha` resource was touched.
- Reviewed safe-stop change set `stage-c-chatgpt-safe-stop-6b06dc3` removed the two public permissions and restored the private guard. The stack returned to `UPDATE_COMPLETE` at `2026-09-17T13:27:24.494000+00:00` with exactly six resources, no Lambda resource policy, `EnablePublicAccess=false`, `AllowedHost=pending.invalid` in both the parameter and function environment, external HTTP 403, the unchanged code checksum `v7wO4zOcH8AENHDO7Mb+YEFlbuNyTj+hk1x42ePvMjg=`, zero diagnostic objects, and only the corrected content-addressed ZIP in the bucket.

This receipt proves that the exact ChatGPT Pro web developer-mode surface can register, authorize, select, and invoke the diagnostic MCP tool with an unrestricted object schema and no OAuth. It does not show what project information ChatGPT can acquire, whether any acquisition leg is complete or reliable, whether multi-call transfer is needed, or whether Claude is compatible. The empirical capability-test task therefore remains open and no migration acquisition path may be selected from this result.

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

Only after that compatibility evidence and a separate go-ahead may the synthetic project fixture be created or the 18 planned Phase 1 evidence submissions be run.

## Execution limits and cost guardrail

Phase 1 is bounded to:

- two providers, ChatGPT first and Claude second;
- three acquisition legs per provider;
- three fresh trials per leg;
- at most 18 successful evidence submissions, plus normal MCP discovery/protocol calls;
- one synthetic project per provider and no unrelated history;
- 24-hour session expiry, four-hour maximum public window per provider, and seven-day maximum stack lifetime;
- a $1 experiment stop ceiling within the existing $5 AWS budget.

If Phase 2 is triggered, each approved provider/surface/leg adds at most three sessions and 30 successful calls. Even if all six provider/leg combinations trigger, the overall multi-call ceiling is 18 sessions and 180 successful calls. Phase 2 does not raise the $1 cost stop, 24-hour session TTL, four-hour public window per approved provider phase, or seven-day stack-lifetime limit.

With no always-on compute, database, VPC, NAT, API Gateway, ECR, or custom domain, expected Lambda, S3, and log charges for this volume should be pennies and likely below $0.10. This is a planning estimate, not a billing guarantee. Stop before provider trials if the change set adds an unreviewed paid service, and stop the experiment if AWS actual or forecast cost attributable to the probe approaches $1.

## Evidence receipt versus host-visible success

Single-use Phase 1 storage remains correct for contamination control, but these outcomes must be recorded independently for every attempted trial:

1. `evidence_captured`: whether the exact record exists in S3 with a valid receipt timestamp, argument hash, and session identity;
2. `provider_observed_success`: whether the provider surface displayed or otherwise confirmed a successful tool response (`yes`, `no`, or `unknown`).
3. `additional_call_attempted`: whether the host deliberately or apparently tried another tool invocation after the captured call (`yes`, `no`, or `unknown`).
4. `truncation_or_chunking_observed`: whether the host or transport exposed truncation or a plan to continue in chunks (`yes`, `no`, or `unknown`).

If the first write succeeds but the response is lost and the provider retries, the second call may receive `already used`. Score the captured record normally, mark `evidence_captured=yes`, record the host-visible response separately, and do not count that transport/response loss as an acquisition-content failure. Never overwrite the first record or run an automatic second evidence submission under the same trial identity.

## Implementation acceptance gates

Implementation is not ready for a deployment review until tests prove:

- the hosted adapter advertises the exact one-tool contract;
- the neutral tool metadata remains byte-for-byte constant across all three acquisition legs;
- the ZIP is deterministic, content-addressed, below Lambda package limits, and its deployed code hash matches the reviewed artifact;
- request bodies above 5 MiB are rejected before JSON parsing;
- token generation, digest lookup, exact expiry, and non-disclosing errors;
- one-call behavior under concurrent submissions using a conditional S3 write;
- content-free recording of additional-call attempts and observed truncation/chunking without capturing a rejected second payload;
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

1. approve Phase 1 implementation of the neutral description, single-call S3-backed diagnostic adapter, operator commands, deterministic ZIP, template, outcome fields, trigger reporting, and tests;
2. review the resulting diff, IAM policies, change set, immutable ZIP/code hashes, tests, cost estimate, and cleanup commands;
3. approve creation of the private AWS foundation;
4. approve bounded public compatibility testing;
5. after compatibility succeeds, approve creation of synthetic provider projects and execution of the Phase 1 empirical trials;
6. only if triggered, implement and review the already bounded Phase 2 mode before its trials.

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
