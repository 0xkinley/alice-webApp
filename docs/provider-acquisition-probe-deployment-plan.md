# Provider Acquisition Probe Deployment Review

Status: Review complete; implementation, deployment, public enablement, and provider-account use are not authorized by this document.

Date: 2026-09-17

## Decision

If the empirical provider-acquisition test is approved for hosted execution, deploy the diagnostic probe as a separate, temporary CloudFormation stack named `alice-acquisition-probe` in `eu-central-1`.

Do not add the probe to `alice-private-alpha`, reuse its runtime image, database, buckets, users, OAuth clients, URLs, roles, or secrets, or deploy the Milestone 06.5 migration feature. The probe remains synthetic-only and diagnostic-only. Its one tool writes a captured test argument to disposable evidence storage; it cannot change Alice trusted state or a provider project.

This review recommends proceeding to implementation only after the product owner separately approves this design. A later implementation review must occur before any AWS mutation. A further explicit approval is required before public enablement or adding the URL to ChatGPT or Claude.

## Fixed diagnostic contract

The hosted probe must retain the already reviewed local contract:

- one tool: `submit_acquisition_evidence`;
- exact description: `Send all information currently available for this diagnostic acquisition test.`;
- exact input schema: `{ "type": "object", "additionalProperties": true }`;
- exact pre-validation JSON-RPC argument snapshot plus one parsed duplicate for scoring;
- one successful evidence submission per randomly generated 256-bit session URL;
- synthetic fixture data only;
- fixed hosted TTL of 24 hours, with immediate operator deletion after scoring;
- no Alice user, project, migration, artifact, file, accepted-state, or database dependency;
- no provider password, cookie, session credential, hidden token, or account-wide export.

The Lambda-hosted request ceiling must be lower than the local 8 MiB ceiling. AWS documents a 6 MB maximum for synchronous Lambda invocation, so implementation should reject requests above 5 MiB before parsing and verify the complete fixture remains well below that limit.

Any change to the tool name, description, schema, captured fields, prompts, fixture inventory, scoring, or TTL requires another review before use.

## Proposed isolated resources

The temporary stack should contain only:

1. A dedicated ECR repository for one immutable ARM64 probe image. Enable scan-on-push, immutable tags, and deletion with the stack after its image is removed.
2. A dedicated private, nonversioned S3 bucket for `sessions/` and `records/`. Enable S3-managed encryption, bucket-owner-enforced ownership, block all public access, and deny insecure transport. Do not enable Object Lock.
3. A bucket policy enforcing transport and conditional evidence writes.
4. A dedicated CloudWatch log group with one-day retention.
5. A dedicated Lambda execution role.
6. One ARM64 Lambda function with 256 MB memory, a 30-second timeout, default 512 MB ephemeral storage, no VPC, and no Alice environment variables or secrets.
7. One buffered Lambda Function URL.
8. One public `lambda:InvokeFunctionUrl` permission, created only in the public-test stage.
9. One public `lambda:InvokeFunction` permission constrained with `lambda:InvokedViaFunctionUrl`, also created only in the public-test stage.

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
4. At experiment completion, remove both public Lambda permissions, empty the probe bucket, delete the stack and ECR image, and verify the Lambda, Function URL, role, log group, bucket, repository, and resource-based permissions no longer exist.
5. Treat the lifecycle rule and one-day log retention as failure backstops, not proof of immediate erasure.

The stack must be removed within seven days of creation. A public test window should last no more than four hours for each provider.

## Staged deployment and stop points

Every stage uses a reviewed CloudFormation change set. A stage may advance only when its evidence is recorded and the working tree still matches the reviewed commit.

```text
Reviewed source and template
          |
          v
Stage A — private foundation
ECR + private S3 + policy + log group + role
          |
          | verify policies, lifecycle, no public access
          v
Stage B — private runtime
immutable ARM64 image + Lambda + Function URL,
no public invoke permissions
          |
          | local/AWS protocol and content-free-log checks
          v
Stage C — bounded public compatibility check
add both Function URL public permissions
          |
          +--> host rejects anonymous MCP/OAuth is required
          |       -> remove both permissions and stop for redesign
          |
          +--> host accepts exact tool contract
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

Official OpenAI guidance recommends connecting an HTTPS MCP server in ChatGPT developer mode and adding OAuth only when user-specific data or writes require it. That supports trying an anonymous path for this synthetic diagnostic, but it does not prove the exact target ChatGPT plan, account, region, or surface will accept this server. Claude capability is likewise unproven.

The first bounded live action for each provider is therefore a compatibility check, not a data-acquisition result:

- confirm that the exact account and surface can register the HTTPS MCP URL;
- confirm the displayed tool name, description, and unrestricted object schema are unchanged;
- confirm the host does not require OAuth or a marketplace/publication step;
- make no project claim from a health check or tool discovery alone;
- if OAuth is required, immediately remove public permissions and stop. Do not add OAuth speculatively or reuse Alice OAuth.

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

With no always-on compute, database, VPC, NAT, API Gateway, or custom domain, expected Lambda, S3, ECR, and log charges for this volume should be pennies and likely below $0.10. This is a planning estimate, not a billing guarantee. Stop before provider trials if the change set adds an unreviewed paid service, and stop the experiment if AWS actual or forecast cost attributable to the probe approaches $1.

## Implementation acceptance gates

Implementation is not ready for a deployment review until tests prove:

- the hosted adapter advertises the exact one-tool contract;
- request bodies above 5 MiB are rejected before JSON parsing;
- token generation, digest lookup, exact expiry, and non-disclosing errors;
- one-call behavior under concurrent submissions using a conditional S3 write;
- no path, header, body, argument, token, or evidence content appears in application logs;
- the Lambda role cannot list storage, read records, create sessions, delete objects, or access production resources;
- expired sessions are unusable before lifecycle deletion;
- operator-only exact-key create, retrieve, score, delete, and verify-missing commands;
- both public permission resources can be added and removed without replacing the private foundation;
- a safe-stop leaves the Function URL returning 403;
- stack teardown leaves no probe resources or evidence;
- local formatting, linting, typechecking, secret scanning, focused tests, fast tests, and production builds still pass;
- the production Docker context and `alice-private-alpha` template remain unaffected.

## Approval boundaries

This document authorizes no mutation. The remaining approvals are deliberately separate:

1. approve implementation of the S3-backed diagnostic adapter, operator commands, dedicated image, template, and tests;
2. review the resulting diff, IAM policies, change set, immutable image digest, tests, cost estimate, and cleanup commands;
3. approve creation of the private AWS foundation;
4. approve bounded public compatibility testing;
5. after compatibility succeeds, approve creation of synthetic provider projects and execution of the empirical trials.

At every boundary, `Host-generated does not mean alice.-verified` remains controlling. Probe output is evidence about one tested host configuration; it is not trusted Alice state and is not automatically a migration design.

## References

- [AWS Lambda Function URL access control](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)
- [AWS Lambda synchronous invocation payload limit](https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html)
- [Amazon S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
- [Amazon S3 lifecycle timing and asynchronous deletion](https://docs.aws.amazon.com/AmazonS3/latest/userguide/troubleshoot-lifecycle.html)
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/)
- [Amazon S3 pricing](https://aws.amazon.com/s3/pricing/)
- [OpenAI: Bring your app to ChatGPT](https://learn.chatgpt.com/zh-Hans/use-cases/chatgpt-apps)
