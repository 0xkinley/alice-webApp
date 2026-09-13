# Private Alpha AWS Compatibility Checkpoint

Status: AWS-native candidate selected for implementation proof; provisioning not approved

Decision date: 2026-08-31

Official references revalidated: 2026-08-31

## Decision boundary

This checkpoint supersedes the unprovisioned Railway/Neon recommendation after the product owner chose to investigate the account's USD 100 AWS credit. It does not create an AWS resource, public origin, access key, invitation, or external data transfer. The existing USD 5 monthly AWS budget remains an alert, not a hard spending stop.

No cloud deployment is approved yet. The repository adaptation and final CloudFormation change set are complete; the remaining pre-creation work is the account-plan/service-eligibility screen, final full/image gate, and explicit product-owner approval of the dated runbook.

## Current result

| Candidate | Result | Reason |
| --- | --- | --- |
| AWS App Runner | Rejected for this account | AWS now says App Runner is closed to new customers. Seeing it in console search does not establish create-service eligibility. |
| ECS Express Mode | Compatible fallback, not selected | It preserves the container model but provisions Fargate and an Application Load Balancer. Two smallest ARM tasks cost about USD 16.58/month continuously in Frankfurt, and the ALB alone costs about USD 19.71/month before LCUs, database, logs, storage, and transfer. |
| Lambda Function URLs plus Aurora Serverless v2 | Selected for implementation proof | It has no always-on web/MCP compute or load-balancer floor, provides stable HTTPS origins, can use private VPC access and IAM roles without access keys, and lets Aurora pause at zero ACUs. It requires bounded application changes and a live MCP protocol proof before production approval. |

AWS officially recommends ECS Express Mode as the successor to App Runner. It remains the fallback if Lambda cannot pass the hosted Streamable HTTP MCP test, but its approximately USD 36.29/month compute-plus-ALB floor before database and ancillary usage is disproportionate to this private-alpha proof.

## Local evidence

The unmodified production image was built and exercised locally on 2026-08-31 without contacting AWS:

- the locked multi-stage Node.js 24 image built successfully with zero reported dependency vulnerabilities;
- PostgreSQL 17 started with an empty disposable database and all 14 then-current migrations applied;
- the constrained `alice_app` role connected successfully;
- the web image started as the non-root `node` user and `/health` returned HTTP 200 with PostgreSQL reachable;
- the MCP image started as the non-root `node` user, `/health` returned HTTP 200, and `/.well-known/oauth-protected-resource/mcp` returned the expected resource and authorization-server metadata; and
- every disposable proof container was removed afterward.

This proves the image and database contract, not Lambda protocol compatibility. Lambda Web Adapter, Function URL request mapping, VPC networking, cold Aurora resume, OAuth, and a complete authenticated MCP round trip still require bounded implementation and then a live test.

## Selected proof topology

The exact candidate to implement locally is:

- one private ECR repository containing the same immutable ARM64 image for both functions;
- two separate Lambda functions, `alice-web` and `alice-mcp`, using AWS Lambda Web Adapter, separate execution roles, 512 MiB web memory, 1,024 MiB MCP memory, 512 MiB ephemeral storage, bounded timeouts, and the account-wide Frankfurt concurrency quota as the temporary proof cap;
- two separate public Lambda Function URLs with AWS-generated stable HTTPS origins and buffered responses; alice. web sessions and MCP OAuth remain the application authorization boundary;
- one VPC in `eu-central-1` with two isolated subnets in separate Availability Zones, no public database address, no Internet Gateway, and no NAT Gateway;
- one Aurora PostgreSQL-compatible Serverless v2 writer on PostgreSQL 17, Aurora Standard, minimum 0 ACUs, maximum 1 ACU, and a ten-minute auto-pause interval;
- one Lambda security group with outbound PostgreSQL access and one database security group accepting port 5432 only from the Lambda group;
- one no-charge S3 gateway VPC endpoint attached to the isolated-subnet route tables;
- the existing private, versioned, SSE-S3 bucket and GuardDuty Malware Protection plan, changed from IAM users to separate Lambda execution-role permissions so no access keys are created;
- CloudWatch log groups with 14-day retention and content-free application errors; and
- explicit operator-run migrations using a separate database owner credential before either runtime is updated.

The first proof uses AWS-generated origins and no custom domain. No Route 53 zone, ACM certificate, API Gateway, load balancer, NAT Gateway, public database endpoint, RDS Proxy, organization, or Control Tower resource belongs in this topology.

## Required application work before provisioning

Lambda synchronous requests are limited to 6 MB. The current server-mediated upload route accepts PDFs up to 25 MiB and images up to 10 MiB, so it cannot be placed behind a Function URL unchanged. Before any live deployment:

1. add AWS Lambda Web Adapter to the existing portable image while preserving ordinary local/container starts;
2. implement an authenticated, expiring direct-to-S3 upload intent and finalize protocol;
3. recheck the authenticated user, exact project/context, declared size/type/hash, S3 object/version, signature, actual hash, and scan lifecycle during finalization;
4. keep an object unavailable until GuardDuty reports `NO_THREATS_FOUND` for the exact version;
5. ensure invalid, abandoned, expired, and foreign intents never create an active file reference and have a documented privileged cleanup path;
6. keep ordinary MCP packages below their existing 32 KiB ceiling so buffered Function URL responses stay far below Lambda's response limit;
7. add adapter/configuration tests, direct-upload negative tests, and a local container regression; and
8. perform at most three live protocol rounds after separate resource approval: infrastructure smoke test, OAuth/MCP/file security test, and one remediation rerun only if needed.

Function URLs attached to VPC-enabled Lambdas do not provide response streaming. The MCP server must therefore pass a real buffered Function URL test; local Express success cannot substitute for that evidence. Failure returns the compute decision to ECS Express Mode or another approved host.

Items 1-4 and 6-7 are complete in the repository. The production image pins Lambda Web Adapter `1.0.1` by its multi-architecture manifest digest, keeps the non-root `node` runtime, and remains an ordinary container when it is not running inside Lambda. Migration `015_file_upload_intents.sql` records immutable, user/project/context-bound declarations and one immutable completion receipt. The browser computes SHA-256, obtains a ten-minute checksum/encryption-bound S3 PUT, uploads without an AWS credential, and submits the exact S3 version for finalization. Finalization returns pending without reading bytes until GuardDuty reports `NO_THREATS_FOUND`; it then reauthorizes the initiating user and exact context, reads that version, verifies signature, type, extension, size, and hash, and only then uses the existing immutable reference path. Foreign, expired, threat-marked, unsupported, failed, and mismatched uploads create no reference. Tests cover the domain boundary, exact-origin HTTP routes, S3 signing contract, migration 15, and constrained-role immutability.

Items 1-7 are now complete in the repository. The final template adds privileged staging lifecycle cleanup, exact-origin PUT-only bucket CORS, separate credential-free Lambda roles, an isolated two-AZ VPC, an auto-pausing Aurora writer, and a temporary private Fargate migration path. The migration task creates or rotates the constrained `alice_app` role with a generated password without raw credential interpolation, applies the exact ledger, refreshes grants, and is then removed together with its four paid interface endpoints. Public Function URL permissions are a separate final condition, so generated origins can be inspected before either endpoint becomes invokable. The 41-resource staged change set passes `cfn-lint` 1.55.1 and six structural boundary tests.

Provisioning remains blocked on a current account-plan/service-eligibility check, product-owner approval of the exact resources/security/cost envelope in `docs/private-alpha-aws-deployment-runbook.md`, and the separately approved live protocol rounds. The full local gate, rebuilt ARM64 container gate, and GitHub Actions CI run `33340204691` for approval commit `e8bb958` pass. Repository readiness is not hosted evidence.

## Cost checkpoint

These are planning estimates before credits, not a quote:

- Lambda request/compute usage should be below USD 1/month at friend-alpha traffic, subject to the account's actual Free Plan eligibility and measured duration.
- Aurora Serverless v2 in Frankfurt is USD 0.14 per ACU-hour. At the expected 0.5 ACU while awake, ten active hours cost about USD 0.70 and 100 active hours cost about USD 7.00; paused compute is not charged.
- Aurora Standard storage is USD 0.119 per GB-month and I/O is USD 0.22 per million requests in the dated Frankfurt catalog.
- Two Secrets Manager secrets cost USD 0.80/month. A 10 GiB Aurora working volume costs about USD 1.19/month before I/O.
- ECR, CloudWatch, S3, GuardDuty, and transfer should remain below a few dollars at the bounded proof volume, but each remains usage-priced. The one-off private migration endpoints cost about USD 0.096/hour while all four services exist across two Availability Zones and must be removed immediately after migration.

The target is USD 1-5 for the bounded hosted proof and approximately USD 5-15/month for a low-traffic alpha before credits, primarily determined by Aurora awake time. The existing USD 5 budget alerts stay active. Stop before further testing if actual or forecast usage reaches USD 5, and return for product-owner approval before raising that threshold or keeping resources running for friend testing.

A constant keepalive would defeat the ten-minute pause and cost about USD 51.10/month at the 0.5 ACU floor before storage and ancillary services. The dormant 15-minute hosted-health workflow therefore remains disabled for this topology. The full dated unit-price model and staged stop rules are in `docs/private-alpha-aws-deployment-runbook.md`.

The account's Free Plan expires after six months or when credits are exhausted, whichever occurs first, while the promotional credit itself can have a later expiration date. Before provisioning, verify the account-plan deadline and that Lambda, ECR, VPC, Aurora express configuration, S3, GuardDuty, and CloudFormation are available on this account. Do not join AWS Organizations or enable Control Tower because AWS documents that either action expires the credits and upgrades the plan.

## Sources

- [AWS App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)
- [Amazon ECS Express Mode overview](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html)
- [AWS Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- [AWS Lambda Web Adapter](https://github.com/aws/aws-lambda-web-adapter)
- [Lambda Function URL authorization](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)
- [Aurora Serverless v2 automatic pause](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html)
- [ECR VPC endpoint requirements](https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html)
- [S3 gateway endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html)
- [AWS CLI login with console credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html)
- [AWS Free Tier plans](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html)
- [AWS Free Tier FAQ](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-FAQ.html)

Frankfurt unit prices were read from AWS's public regional offer catalogs on 2026-08-31. Recheck the actual billing screens and CloudFormation change set before creation.
