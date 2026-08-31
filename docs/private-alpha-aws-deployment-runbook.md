# Private Alpha AWS Deployment Runbook

Status: product-owner approved; Stages 1-5 complete, hosted health and authorization boundaries verified, private invitation-operator preflight complete, authenticated protocol/file proof still open

Date: 2026-08-31

This runbook is the approval boundary for the first AWS-hosted proof. It is not permission to create the stack. The product owner must approve the region, resources, usage-priced costs, and security settings below before Stage 1. Every command after approval runs with short-lived console credentials in AWS CloudShell or with AWS CLI `aws login`; no IAM access key is created, copied, committed, or stored as a GitHub secret.

Product-owner approval was received on 2026-08-31 for AWS Bundle 1 in `eu-central-1`, the existing USD 5 alert, the USD 5-15/month low-traffic expectation, the USD 45 planning ceiling, and at most three live proof rounds. This authorizes the staged procedure below; it does not authorize exceeding a stop rule, changing region or architecture, creating access keys, or retaining the stack after the proof without the Stage 7 review.

## Approval envelope

| Decision | Exact selection |
| --- | --- |
| Region | Europe (Frankfurt), `eu-central-1`, only |
| Stack | `alice-private-alpha` from `infra/aws/private-files.template.json` |
| Compute | Two ARM64 image Lambdas: `alice-private-alpha-web` at 512 MiB and `alice-private-alpha-mcp` at 1,024 MiB; 60-second timeout, 512 MiB ephemeral disk; no per-function reservation during the proof because the new account's Frankfurt quota is 10 concurrent executions, which remains the account-wide cap |
| Public origins | Two AWS-generated buffered Lambda Function URLs; no custom domain, load balancer, API Gateway, or CDN |
| Database | One private Aurora PostgreSQL 17.4 Serverless v2 writer, Aurora Standard, 0-1 ACU, auto-pause after 600 seconds, seven-day backups |
| Files | One operator-supplied globally unique S3 bucket, versioning, SSE-S3, public access block, GuardDuty Malware Protection, exact web-origin PUT CORS |
| Network | `10.42.0.0/16` VPC, two isolated `/24` subnets in separate Availability Zones, no Internet Gateway, no NAT Gateway, no public database endpoint |
| Credentials | Lambda/ECS roles and Secrets Manager only; no IAM user or access key in the stack |
| Existing cost control | Keep the already-created `alice-aws-testing` USD 5 monthly budget with 80% actual, 100% actual, and 100% forecast email alerts; this is an alert, not a hard cap |
| Planning limit | Expected low-traffic gross usage USD 5-15/month before credits; do not exceed USD 45/month or raise the budget without a new approval |
| Live proof limit | At most three rounds: infrastructure smoke, OAuth/MCP/file security, and one remediation rerun if required |

The bucket name is the only intentionally unresolved resource name because S3 names are globally shared. Choose a neutral name of the form `alice-private-alpha-files-<random lowercase suffix>` at deployment time. Do not put an account number, email address, person name, or environment secret in it.

## Exact resource change set

The template has 44 possible CloudFormation resources. Conditions make them appear only in controlled stages:

| Stage | Resource count | Resources |
| --- | ---: | --- |
| Foundation | 22 | VPC; two private subnets, route tables, and associations; Lambda and database security groups; database ingress; S3 bucket, bucket policy, and free S3 gateway endpoint; GuardDuty role and malware plan; database subnet group, Aurora cluster and writer; application secret; ECR repository; web and MCP execution roles |
| Temporary migration | 9 | Four interface endpoints (`ecr.api`, `ecr.dkr`, CloudWatch Logs, Secrets Manager), their endpoint security group, ECS cluster, three-day migration log group, ECS execution role, and ARM64 Fargate task definition |
| Runtime | 6 | Two 14-day log groups, two image Lambdas, and two Function URL resources |
| Final public-origin update | 4 | The two permissions required for each Function URL: `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` restricted to invocation through the URL |
| Temporary invitation operator | 3 | One direct-invoke image Lambda, its dedicated least-privilege execution role, and a one-day log group; no Function URL or `AWS::Lambda::Permission` resource |

The foundation creates billable resources immediately, even while runtime services are disabled. CloudFormation itself, VPCs, subnets, route tables, security groups, and the S3 gateway endpoint have no hourly charge. The database, secrets, stored image/objects/logs, malware scanning, requests, and data transfer are usage-priced.

## Current Frankfurt cost model

All figures are gross before the USD 100 promotional credit, tax, and any applicable Free Plan allowance. They are planning estimates from the public `eu-central-1` AWS offer catalogs dated 2026-08-31, not a quote.

| Component | Current unit price | Bounded-alpha assumption | Planning amount |
| --- | ---: | ---: | ---: |
| Aurora Serverless v2 Standard | USD 0.14/ACU-hour | 0.5 ACU for 10-100 awake hours | USD 0.70-7.00/month |
| Aurora Standard storage | USD 0.119/GB-month | 10 GiB initial working volume | about USD 1.19/month |
| Aurora Standard I/O | USD 0.22/million requests | at most 1 million | up to USD 0.22/month |
| Secrets Manager | USD 0.40/secret-month | two database secrets | USD 0.80/month |
| Lambda ARM compute/requests | USD 0.0000133334/GB-second and USD 0.20/million requests; Free Tier may apply | friend-alpha traffic | expected below USD 1/month |
| ECR storage | USD 0.10/GB-month | about 1 GiB retained image layers | about USD 0.10/month |
| S3 Standard | USD 0.0245/GB-month; USD 0.0054/1,000 PUT-class; USD 0.0043/10,000 GET-class | at most 5 GiB and low request volume | about USD 0.12 plus cents/month |
| GuardDuty S3 malware scanning | first 1 GB and 1,000 PUTs/month free, then USD 0.129/GB and USD 0.000308/scanned PUT | at most 5 GiB and fewer than 1,000 uploads | up to about USD 0.52/month |
| CloudWatch Logs | USD 0.63/GB ingested and USD 0.0324/GB-month stored | at most 1 GiB content-free logs | up to about USD 0.66/month |
| Temporary interface endpoints | USD 0.012/endpoint-AZ-hour plus USD 0.01/GB | 4 services x 2 AZs x at most 2 hours | about USD 0.19 plus cents once |
| Temporary Fargate migration | USD 0.03725/vCPU-hour + USD 0.00409/GB-hour | 0.25 vCPU, 0.5 GiB, a few minutes | below USD 0.01 once |

Expected gross cost is USD 1-5 for the bounded deployment proof and USD 5-15/month for low-traffic friend use. The main uncertainty is database awake time. A keepalive that prevents pause would cost about USD 51.10/month at a constant 0.5 ACU before storage and ancillary charges, so the dormant 15-minute hosted-health workflow must not be enabled. Stop live work and investigate when the existing USD 5 actual or forecast alert fires.

## Security settings

- Root stays signed out except for root-only recovery/account work. `alice-admin` remains MFA-protected and has no access keys.
- The application stack creates no IAM users. Lambda and the one-off ECS task receive short-lived role credentials from AWS.
- The Aurora writer is encrypted, private, reachable on port 5432 only from the workload security group, deletion-protected, and retained as a snapshot on replacement/deletion.
- Runtime connections use TLS and the constrained `alice_app` role. Schema migration uses the RDS-managed owner secret only in the temporary ECS task; the task creates/rotates `alice_app`, applies the exact migration ledger, refreshes grants, then is removed.
- The VPC has no route to the internet. Runtime HTTPS egress reaches only the routed S3 gateway endpoint. Temporary private ECR, Logs, and Secrets Manager endpoints exist only during migration.
- The S3 bucket blocks public access, rejects insecure transport, versions every object, and encrypts with SSE-S3. Ordinary roles have no bucket list, object delete, or scan-tag write permission.
- MCP can read only exact clean versions under `objects/`. Web can sign bounded staging/object writes and read exact clean versions. A bucket-policy deny blocks reads until GuardDuty sets `GuardDutyMalwareScanStatus=NO_THREATS_FOUND`.
- Browser upload CORS is absent until the exact generated web origin is supplied. Then it allows only `PUT`, the required checksum/metadata/encryption headers, and exposes only `ETag` and `x-amz-version-id` for ten minutes.
- Staging current versions expire after two days, noncurrent staging versions after one day, and incomplete multipart uploads after one day. Permanent object erasure remains a separate privileged, unimplemented workflow.
- Function URLs are deliberately public network endpoints, but alice. web sessions and MCP OAuth remain the application authorization boundary. The URLs receive no invoke permission until the final exact-origin update.
- Application logs are content-free and expire after 14 days; migration logs expire after three days. The template contains no secret value.
- The alpha invitation operator is disabled by default and uses a separately pinned immutable image. When enabled, it has one reserved execution, the constrained application database credential, no S3 permission, no Function URL, no resource-based invoke permission, and a one-day content-free log group. Invoke it once through the signed-in administrator's identity policy and remove all three resources immediately afterward. Its one-time invitation token is returned only in the direct invocation response and is never logged.
- The proof uses ordinary unreserved Lambda concurrency. The account-wide Frankfurt quota of 10 remains the aggregate cap; do not request a quota increase or enable paid provisioned concurrency during the proof. Restore an explicit two-execution reservation per function only after the regional quota is at least 14 and the product owner approves the change.

## Credential-free staged procedure

Do not combine these stages. Review the CloudFormation change set before every create/update and stop if it includes a resource not listed above.

1. **Foundation:** deploy with `DeployServices=false`, `RunMigration=false`, `OriginsConfigured=false`, and the placeholder digest/URLs. Confirm 22 resources, private networking, the USD 5 budget, and current account-plan/service eligibility.
2. **Immutable image:** use the signed-in `alice-admin` AWS CloudShell session or AWS CLI 2.32+ `aws login`. Build the committed branch for `linux/arm64`, push to the stack's ECR output, record its digest, and use only the digest URI afterward. Do not create an access key.
3. **Migration:** update with the digest and `RunMigration=true`, keeping `DeployServices=false`. Confirm exactly nine temporary resources, run one Fargate task in the two private subnets with the workload security group, require exit code 0 and migration 015, then immediately update `RunMigration=false` and verify all four paid interface endpoints are gone.
4. **Private runtime:** update with `DeployServices=true` and `OriginsConfigured=false`. The two Function URLs are created but lack public invoke permissions. Record both generated URL outputs.
5. **Exact origins:** update both URL parameters with those exact outputs and set `OriginsConfigured=true`. Confirm only four invoke permissions and the exact web-origin S3 CORS rule are added.
6. **Private invitation operator:** build and push the committed image, pin its digest only in `OperatorImageUri`, and create a reviewed `invitation-operator` change set. Confirm it adds exactly the dedicated role, one-day log group, and direct-invoke Lambda without changing the web or MCP image and without adding a Function URL or permission. Invoke it once for the approved alpha account, keep the response out of logs, then immediately run a reviewed hosted-proof update with `RunInvitationOperator=false` and verify all three temporary resources are gone.
7. **Bounded proof:** complete the authenticated OAuth/MCP round trip and direct-file/GuardDuty/exact-version test. Perform one remediation rerun only if needed. Keep automated 15-minute probes disabled.
8. **Decision:** retain the stack for the approved friend-alpha window only after reviewing Cost Explorer and budget status. Otherwise disable origins/services and start the separately reviewed teardown path.

CloudShell is pre-authenticated and AWS documents native Docker/ECR support. AWS CLI `aws login` is also acceptable because it derives renewable temporary credentials from the MFA-protected console session; it requires the AWS-managed `SignInLocalDevelopmentAccess` policy and CLI 2.32 or later. Neither path creates a long-term access key.

## Stop and recovery rules

- If a template stage differs from this document, cancel it. Do not accept replacement of the retained S3 bucket or Aurora cluster.
- If migration fails, do not deploy either Lambda. Preserve the logs, diagnose locally, and remove the four interface endpoints by setting `RunMigration=false`.
- If the buffered MCP or OAuth proof fails, set `OriginsConfigured=false` and `DeployServices=false`; do not silently switch to ECS Express Mode.
- If GuardDuty does not produce the exact clean tag, no file may be finalized or read.
- If actual or forecast cost reaches USD 5 during the proof, stop additional live rounds and review usage. The USD 45 ceiling is not authority to ignore the alert.
- Stack deletion is not ordinary cleanup: the bucket/ECR/application secret are retained and Aurora has deletion protection plus snapshot retention. Disabling protection, deleting retained data, or deleting snapshots requires a separate explicit erasure/retention decision.

## Verification evidence before Stage 1

- `infra/aws/private-files.template.json` parses as JSON and passes `cfn-lint` 1.55.1 with no findings.
- Structural deployment tests verify region, network isolation, Aurora bounds, role separation, staged permissions, CORS/lifecycle rules, and temporary migration endpoints.
- The migration entrypoint applied all 15 migrations to disposable PostgreSQL 17, created the constrained application role without raw credential interpolation, and passed the 17-test PostgreSQL suite.
- The complete repository gate passes 111 fast tests, 17 constrained-role PostgreSQL tests, both evaluations, formatting, linting, typechecking, secret scanning, and both builds. The final ARM64 image rebuild succeeds, runs as the non-root `node` user, contains both migration scripts, and executes migration 015 against disposable PostgreSQL 17. GitHub Actions CI run `33340204691` passed approval commit `e8bb958` in 1 minute 20 seconds.

## Live proof evidence and TLS remediation

The first live proof on 2026-08-31 stopped at the migration boundary exactly as required:

- The foundation stack reached `CREATE_COMPLETE` with 22 resources and six outputs. The ARM64 image tagged from commit `e8bb958` was pushed by digest, and ECR reported scan-on-push, immutable tags, and AES-256 repository encryption.
- The reviewed migration change set added exactly the nine temporary resources listed above. One private Fargate task started with no public IP, the exact image digest, and Secrets Manager-backed credentials.
- The task reached PostgreSQL TLS negotiation but exited 1 before applying a migration. Its content-free CloudWatch error was `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (`unable to get local issuer certificate`). No Lambda service was deployed and the task was not rerun.
- The failure cleanup change set removed exactly those nine resources. The stack returned to `UPDATE_COMPLETE`, 22 resources, and six outputs; all four hourly-priced interface endpoints were deleted.

The root cause is a missing Amazon RDS trust chain in the slim Node image. Current `pg-connection-string` behavior treats `sslmode=require` as certificate-verifying TLS unless libpq compatibility is explicitly requested, so the connection correctly failed closed instead of accepting an untrusted chain. The remediation keeps verification strict: the image downloads the official Frankfurt RDS PEM bundle during the build with SHA-256 `56a0cae044b6cc433971d964347401692a92ea0294e392753a3ebdaee54d8b84`, copies it into the non-root runtime, exposes it through `NODE_EXTRA_CA_CERTS`, and uses explicit `sslmode=verify-full` for migration and runtime URLs. `rejectUnauthorized: false` is prohibited.

Local remediation verification passed before the rerun: `cfn-lint` 1.55.1 reported no findings; the complete gate passed 111 fast tests, 17 constrained-role PostgreSQL tests, both evaluations, formatting, linting, typechecking, secret scanning, and both builds; migration applied all 15 versions; and backup/restore matched 42 protected tables. A `linux/arm64` image build succeeded, ran as UID 1000, retained the non-root `node` user, matched the pinned bundle checksum, and reported three RDS certificates as Node extra trust anchors alongside 121 default anchors.

The one permitted remediation rerun completed successfully on 2026-08-31:

- Commit `bf5c837` passed GitHub Actions workflow run 39. Its checksum-verified `linux/arm64` archive was loaded in CloudShell, confirmed as Linux ARM64 with runtime user `node`, and pushed to the stack repository as tag `bf5c837` and immutable digest `sha256:25609912a6fdcbeb85eadf516504083b73f1bede2036fbaeebf6af4c9478753d`.
- Change set `migration-stage-2-retry-tls` replaced the live stack template with the committed remediated template and added exactly the same nine temporary migration resources, with no modification, replacement, or removal of a foundation resource. `DeployServices` and `OriginsConfigured` remained false.
- Exactly one private Fargate task ran from task definition revision 2 with no public IP and the immutable remediated digest. It stopped with `EssentialContainerExited`, container exit code 0, and no placement failure. Its content-free CloudWatch log reported `PostgreSQL migrations current: 15 applied.`, proving the strict RDS TLS path and exact migration ledger succeeded.
- Change set `migration-stage-2-disable-complete` then changed only `RunMigration` to false. Its reviewed resource diff contained exactly nine removals with delete policy: the four interface endpoints, endpoint security group, ECS cluster, execution role, migration log group, and task definition. It completed with stack status `UPDATE_COMPLETE`.
- Post-cleanup CloudFormation evidence shows exactly 22 resources and six outputs, with no `Migration*` resource or output. All four hourly-priced interface endpoints are gone, no Lambda runtime or public invoke permission has been deployed, and Stages 4-7 remain pending.

The first Stage 4 private-runtime attempt then stopped at the Lambda account-quota boundary:

- Change set `runtime-stage-4-private` contained exactly the expected six additions: the two functions, two 14-day log groups, and two Function URLs. Migration remained disabled, the URL resources had no public invoke permissions, and no foundation resource was modified, replaced, or removed.
- Both function creations failed with AWS Lambda `InvalidRequest`: `Specified ReservedConcurrentExecutions for function decreases account's UnreservedConcurrentExecution below its minimum value of [10].` CloudFormation rolled the stack back to `UPDATE_ROLLBACK_COMPLETE`; the partial runtime resources were removed and the 22-resource foundation remained intact.
- The account's Frankfurt concurrency quota is 10, so reserving two executions for either function is impossible while AWS requires all 10 to remain unreserved. This was an account-quota failure, not an image, application, database, migration, networking, or TLS failure.
- On 2026-08-31 the product owner approved removing both per-function reservations for the bounded proof. This configuration has no concurrency reservation charge, leaves the regional account-wide limit of 10 as the aggregate cap, and does not make either Function URL publicly invocable during Stage 4. No quota increase or provisioned concurrency is authorized. A two-execution reservation per function may be restored only after the regional quota is at least 14 and a later review approves it.

The quota-adjusted runtime and exact-origin stages then completed, but the first infrastructure smoke request exposed an image permission mismatch:

- Change set `runtime-stage-4-quota-fix` added exactly the expected two functions, two 14-day log groups, and two Function URLs. It completed with 28 resources and eight outputs while public invoke permissions remained absent.
- Change set `runtime-stage-5-exact-origins` modified only the two functions and retained S3 bucket without replacement and added exactly four Function URL permissions. It completed with 32 resources and eight outputs.
- The bounded public probe first timed out during cold initialization and then both `/health` requests returned HTTP 502. Probing stopped immediately. Content-free Lambda logs showed both processes failed before listening because Node could not read `/app/certs/eu-central-1-bundle.pem`: `load failed: error:8000000D:system library::Permission denied`, followed by the expected fail-closed `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` PostgreSQL error.
- The checksum-pinned CA bundle is public trust material, not a credential. The migration task ran as the image's declared `node` user and could read the owner-only copied path, but Lambda replaces the image user with its own least-privileged runtime identity. The remediation preserves the checksum, path, ownership, and strict `verify-full` behavior while making only the public certificate directory traversable with mode `0755` and its PEM readable with mode `0644`. No secret, application file, other directory, or database permission is widened.
- This is the one bounded infrastructure remediation rerun. Do not disable TLS verification, enable provisioned concurrency, raise a quota, or run repeated probes. If the corrected immutable image is not ready for immediate verification, set `OriginsConfigured=false` and `DeployServices=false` as the safe stopping state.

The Lambda-readable certificate remediation was then deployed, but its single bounded hosted probe was inconclusive and the runtime was returned to the safe stopping state:

- The remediated commit `eb3c83f` was rebuilt for Linux ARM64, verified, and pushed to the stack repository as immutable digest `sha256:d18fbf412e8bc16a1526707ff25a7f7a94f886d71bd87355c015fde1810505de`. A reviewed CloudFormation update changed the image on exactly the existing web and MCP functions, with no function replacement and no other resource change.
- Exactly one hosted smoke request was allowed. It produced no response before the client stopped at its ten-second timeout. This is not a successful health result, and no retry or polling loop was started.
- Change set `runtime-stage-7-safe-stop` set `DeployServices=false`, `OriginsConfigured=false`, and `RunMigration=false`. Its reviewed resource diff removed exactly the two functions, two 14-day log groups, two Function URLs, and four Function URL invoke permissions, and modified only `PrivateFilesBucket` without replacement to remove the web-origin CORS rule.
- CloudFormation screenshots captured after cleanup show stack `alice-private-alpha` in `eu-central-1` at `UPDATE_COMPLETE` with exactly 22 resources and six outputs. The database, private S3 data boundary, ECR repository, Secrets Manager values, roles, and private network foundation remain. The runtime functions, generated public URLs, and public invoke permissions are absent.
- Stage 6 has not passed. The ten-second timeout establishes neither application health nor a new root cause. Any further live attempt requires a separately reviewed, single bounded diagnostic/deployment step; services and origins must remain disabled until that exact step is explained and approved.

The separately reviewed private direct-health diagnostic then proved the corrected image and database path without making either Function URL publicly invocable:

- Change set `runtime-stage-4-private-direct-health` added exactly six non-public runtime resources: the web and MCP Lambdas, their 14-day log groups, and their generated Function URL resources. `DeployServices=true`, `OriginsConfigured=false`, and `RunMigration=false`; no invoke permission, origin/CORS rule, foundation change, replacement, or migration resource was included.
- Exactly one synchronous Lambda-console request was made to each function using a synthetic API Gateway v2 `GET /health` event. Both returned HTTP 200 with `{"database":"reachable","service":"alice-web","status":"ok"}` and `{"database":"reachable","service":"alice-mcp","status":"ok"}` on immutable digest `sha256:d18fbf412e8bc16a1526707ff25a7f7a94f886d71bd87355c015fde1810505de`. No request was retried.
- The web invocation took 7,193.42 ms after a 9,824.24 ms cold initialization; the MCP invocation took 7.05 ms after a 1,319.14 ms cold initialization. The web readiness output did not report the listener ready until approximately eight seconds, which explains the earlier ten-second hosted timeout but does not convert that hosted probe into a pass. The only warning was Lambda Web Adapter's deprecation notice for `HOST` in favor of `AWS_LWA_HOST`; it did not affect either 200 result and remains a deferred hygiene change.
- Change set `runtime-stage-7-direct-health-stop` then removed exactly those six runtime resources, with no additions, modifications, replacements, public permissions, or foundation changes. CloudFormation update `61005b4d-25a4-4b64-97e9-8f7dad3417d2` finished `UPDATE_COMPLETE`. Final read-only checks showed exactly 22 retained resources and six outputs; neither Lambda, Function URL, nor log group remains, and no endpoint output was retained.

This establishes only the bounded direct runtime and database-health proof. It does not complete Stage 6's hosted, OAuth, MCP protocol, or private-file proof, and any future runtime or public-origin step remains a separately reviewed and explicitly approved operation.

### Hosted-proof browser-blocked stop (2026-08-31)

- `runtime-stage-4-hosted-proof-base` restored only the two Lambdas, their 14-day log groups, and their generated Function URL resources with `DeployServices=true`, `OriginsConfigured=false`, and `RunMigration=false`. It added no public permission or CORS rule.
- `runtime-stage-5-hosted-proof-origins` was reviewed and then executed with exactly seven changes: two non-replacement Lambda configuration updates, a non-replacement private-files-bucket CORS update, and four Function URL permissions. It temporarily made the generated Function URLs publicly invocable for the single approved proof.
- Exactly one hosted `GET /health` attempt was made against the web Function URL. The Codex in-app browser returned `ERR_BLOCKED_BY_CLIENT` before the request reached Lambda. There was no HTTP response, no application or database result, no retry, and no MCP request. This is inconclusive browser-client evidence, not an application health result.
- Immediate change set `runtime-stage-8-hosted-proof-stop` removed exactly the two Functions, two Function URLs, two log groups, and four Function URL permissions; it modified only `PrivateFilesBucket` without replacement to remove the temporary CORS rule. CloudFormation operation `16901987-11cc-47c0-8b40-179e3d118d6d` completed `UPDATE_COMPLETE`. Final read-only evidence shows 22 resources and six outputs; database, private S3 data boundary, ECR, secrets, roles, GuardDuty, and the private network foundation remain, while all runtime and public resources are absent.

Another hosted proof must first name a client that can actually issue the one allowed request, review the exact bounded change set, and remain within the product-owner-approved live-proof limit.

### Hosted health and authorization-boundary proof (2026-08-31)

- After the product owner separately approved continuing Bundle 1, change set `bundle1-runtime-private-20260831` restored exactly the two Lambdas, two 14-day log groups, and two Function URL resources with `DeployServices=true`, `OriginsConfigured=false`, and `RunMigration=false`.
- The generated origins are `https://5u3x6bi4jvhkvphtl4sha6yn7i0bberj.lambda-url.eu-central-1.on.aws` for web and `https://aprie3x5vmnrv2hnexwow3m3ny0nlbax.lambda-url.eu-central-1.on.aws` for MCP. Before public permissions were added, both returned Lambda's expected HTTP 403 response.
- Change set `bundle1-hosted-origins-20260831` was reviewed with resolved property values before execution. Its actual diff contained exactly seven changes: non-replacement environment updates to the two Lambdas, a non-replacement exact-origin CORS update to `PrivateFilesBucket`, and the four Function URL permissions required by current Lambda authorization. CloudFormation reached `UPDATE_COMPLETE` with `DeployServices=true`, `OriginsConfigured=true`, and `RunMigration=false`.
- A bounded CloudShell verification reached both public endpoints. Web `GET /health` returned HTTP 200 with `{"database":"reachable","service":"alice-web","status":"ok"}`; MCP `GET /health` returned HTTP 200 with `{"database":"reachable","service":"alice-mcp","status":"ok"}`. This proves the public HTTPS, Lambda Web Adapter, strict RDS TLS, constrained runtime database role, and hosted database path are operational.
- The application authorization boundaries remained closed after AWS network access was enabled. An unauthenticated web `GET /` returned HTTP 303 to `/auth/login?next=%2F`. An unauthenticated MCP `POST /mcp` returned HTTP 401 with a Bearer challenge for `mcp:read mcp:write` and the exact protected-resource metadata URL.
- OAuth discovery advertises the exact hosted issuer, authorization, token, dynamic-registration, and revocation endpoints, S256 PKCE, and the `mcp:read`, `mcp:write`, and `offline_access` scopes. Protected-resource discovery advertises only the exact hosted `/mcp` resource and its matching authorization server.
- Read-only policy checks show that both functions have the required `lambda:InvokeFunctionUrl` statement conditioned on `lambda:FunctionUrlAuthType=NONE` and the required `lambda:InvokeFunction` statement conditioned on `lambda:InvokedViaFunctionUrl=true`. Both use `Principal: "*"` so ordinary browsers and remote MCP hosts can reach alice.; the web session and MCP OAuth token remain the application authorization boundary.
- The live bucket CORS rule allows only `PUT` from the exact web origin, only the four required content/checksum/metadata/encryption headers, and exposes only `ETag` and `x-amz-version-id`. The bucket public-access block, scan-gated reads, versioning, and no-delete runtime-role boundaries remain unchanged.
- The `alice-aws-testing` budget still reported USD 0 actual, USD 0 forecast, and a USD 5 limit after verification. Automated keepalive probes remain disabled.

This completes hosted health, OAuth discovery, and unauthenticated negative-boundary verification. It does not yet complete an authenticated OAuth/MCP protocol round trip, direct private-file upload/GuardDuty/exact-version proof, clean-checkout hosted verification, backup/restore evidence against the hosted database, or the Stage 8 retain/disable cost decision.

### Private invitation-operator preflight (2026-08-31)

- The private Aurora writer is intentionally unreachable from the laptop and CloudShell, and the deployed runtime image did not contain an invitation issuance entrypoint. Therefore authenticated proof could not safely create the first hosted alpha user. Opening the database, logging an invitation token, or adding a public administration route was rejected.
- The replacement is a temporary direct-invoke operator in the same isolated subnets. It uses the constrained `alice_app` connection only, accepts exactly one JSON `email` field, returns one no-store registration URL, emits no token or request-body log, and has no S3 access, Function URL, or public permission. CloudFormation keeps it disabled by default, pins its image independently from the stable web/MCP digest, limits it to one concurrent execution, retains logs for one day, and makes its three resources removable immediately after use.
- The change-set helper now has an `invitation-operator` review mode that requires a real immutable Frankfurt ECR digest. Every ordinary runtime, hosted-proof, and safe-stop plan explicitly disables the operator, preventing accidental retention.
- Local verification passed formatting, linting, typechecking, secret scanning, both deterministic evaluations, all 117 fast tests, all 17 constrained-role PostgreSQL tests against a disposable PostgreSQL 17 database, and both production builds. Structural tests prove the operator cannot acquire a Function URL, resource-based public permission, or S3 policy. The temporary AWS resources and alpha account have not yet been created; both remain explicit approval actions after exact change-set review.

## CLI change-set helper

`npm run aws:change-set -- <private-runtime|hosted-proof|invitation-operator|safe-stop>` prints the exact, review-only AWS CLI command for the approved stack and region. Add `--create` only after reviewing that printed command; it creates and waits for the change set but never executes it. The hosted-proof mode additionally requires both exact generated Function URL origins. The invitation-operator mode requires `--operator-image` with the separately built immutable Frankfurt ECR digest and must resolve to exactly three temporary private resources. Review the resulting resource diff before separately executing it, and remove the operator immediately after one use; use safe-stop after every bounded proof unless the product owner explicitly authorizes retention.

## Primary references

- [AWS CloudShell Docker and ECR tutorial](https://docs.aws.amazon.com/cloudshell/latest/userguide/tutorial-docker-cli.html)
- [AWS CLI login with console credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html)
- [Amazon RDS TLS certificate bundles](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html)
- [node-postgres SSL configuration](https://node-postgres.com/features/ssl)
- [Dockerfile checksum-verified remote `ADD`](https://docs.docker.com/reference/dockerfile/#add---checksum)
- [Lambda Function URL authorization](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)
- [Aurora Serverless v2 automatic pause](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html)
- [ECR VPC endpoint requirements](https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html)
- [S3 gateway endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html)
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/)
- [Amazon Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/)
- [AWS PrivateLink pricing](https://aws.amazon.com/privatelink/pricing/)
- [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/)
