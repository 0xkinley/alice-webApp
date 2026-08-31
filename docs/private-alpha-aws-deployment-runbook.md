# Private Alpha AWS Deployment Runbook

Status: product-owner approved; Stages 1-5 complete, corrected runtime safely disabled after one inconclusive infrastructure smoke probe

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

The template has 41 possible CloudFormation resources. Conditions make them appear only in controlled stages:

| Stage | Resource count | Resources |
| --- | ---: | --- |
| Foundation | 22 | VPC; two private subnets, route tables, and associations; Lambda and database security groups; database ingress; S3 bucket, bucket policy, and free S3 gateway endpoint; GuardDuty role and malware plan; database subnet group, Aurora cluster and writer; application secret; ECR repository; web and MCP execution roles |
| Temporary migration | 9 | Four interface endpoints (`ecr.api`, `ecr.dkr`, CloudWatch Logs, Secrets Manager), their endpoint security group, ECS cluster, three-day migration log group, ECS execution role, and ARM64 Fargate task definition |
| Runtime | 6 | Two 14-day log groups, two image Lambdas, and two Function URL resources |
| Final public-origin update | 4 | The two permissions required for each Function URL: `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` restricted to invocation through the URL |

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
- The proof uses ordinary unreserved Lambda concurrency. The account-wide Frankfurt quota of 10 remains the aggregate cap; do not request a quota increase or enable paid provisioned concurrency during the proof. Restore an explicit two-execution reservation per function only after the regional quota is at least 14 and the product owner approves the change.

## Credential-free staged procedure

Do not combine these stages. Review the CloudFormation change set before every create/update and stop if it includes a resource not listed above.

1. **Foundation:** deploy with `DeployServices=false`, `RunMigration=false`, `OriginsConfigured=false`, and the placeholder digest/URLs. Confirm 22 resources, private networking, the USD 5 budget, and current account-plan/service eligibility.
2. **Immutable image:** use the signed-in `alice-admin` AWS CloudShell session or AWS CLI 2.32+ `aws login`. Build the committed branch for `linux/arm64`, push to the stack's ECR output, record its digest, and use only the digest URI afterward. Do not create an access key.
3. **Migration:** update with the digest and `RunMigration=true`, keeping `DeployServices=false`. Confirm exactly nine temporary resources, run one Fargate task in the two private subnets with the workload security group, require exit code 0 and migration 015, then immediately update `RunMigration=false` and verify all four paid interface endpoints are gone.
4. **Private runtime:** update with `DeployServices=true` and `OriginsConfigured=false`. The two Function URLs are created but lack public invoke permissions. Record both generated URL outputs.
5. **Exact origins:** update both URL parameters with those exact outputs and set `OriginsConfigured=true`. Confirm only four invoke permissions and the exact web-origin S3 CORS rule are added.
6. **Bounded proof:** run the infrastructure smoke test and the full OAuth/MCP/direct-file negative test. Perform one remediation rerun only if needed. Keep automated 15-minute probes disabled.
7. **Decision:** retain the stack for the approved friend-alpha window only after reviewing Cost Explorer and budget status. Otherwise disable origins/services and start the separately reviewed teardown path.

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
