# Private Alpha Production Deployment

Status: Superseded before provisioning; no workload resource created

Decision date: 2026-08-31

Official references revalidated: 2026-08-31

> Superseded on 2026-08-31 before approval or provisioning. The product owner chose to investigate an AWS-native path using the account's AWS credit. Do not execute this Railway/Neon sequence. Continue from `docs/private-alpha-aws-compatibility.md`.

## Approval boundary

This checkpoint prepares the repository and records the exact production topology. It does not create a Railway, Neon, or AWS account; accept provider terms; add a payment method; create a public origin; provision infrastructure; create an access key; transfer alice. data; or invite a tester.

Provisioning requires the product owner to approve all of the following together:

- a USD 45 monthly planning ceiling before any domain cost;
- Railway Hobby, Neon Launch, and AWS pay-as-you-go billing;
- Railway EU West in Amsterdam and Neon/AWS `eu-central-1` in Frankfurt;
- Railway-generated HTTPS domains for the first hosted proof, with custom domains deferred;
- Neon's public TLS endpoint on Launch because IP allow rules and private networking require a higher plan;
- two least-privilege AWS IAM users with sealed, service-specific long-term access keys because Railway has no documented native AWS workload identity in the selected configuration; and
- the residual outage risk of Railway's USD 20 compute hard limit and the residual overrun risk that AWS Budgets alerts but does not automatically stop usage.

The product owner creates and owns the accounts, enables MFA, accepts terms, supplies billing details, and retains recovery credentials. Technical provisioning can proceed only after those owner-controlled steps.

## Exact topology

| Boundary | Resource | Initial configuration |
| --- | --- | --- |
| Compute | Railway project `alice-private-alpha-production` | Hobby; production environment only; PR environments disabled |
| Web | Railway persistent service `alice-web` | One replica; EU West Metal (`europe-west4-drams3a`); repository-root `Dockerfile`; `npm run start:web`; `/health`; no volume; serverless disabled |
| MCP | Railway persistent service `alice-mcp` | One replica; EU West Metal (`europe-west4-drams3a`); same image; `npm run start:mcp`; `/health`; no volume; serverless disabled |
| Database | Neon project `alice-private-alpha-production` | Launch; PostgreSQL 17; AWS Frankfurt (`eu-central-1`); primary branch only; 0.25 CU fixed ceiling; five-minute scale to zero; seven-day restore window |
| Runtime database access | Neon pooled role `alice_app` | TLS and channel binding required; shared by the two Railway services; application pools remain bounded to 10 connections each |
| Migration database access | Neon direct owner/migrator connection | Never supplied to a deployable; used only for explicit migration, role-grant, backup, and restore operations |
| File bytes | One general-purpose S3 Standard bucket | `eu-central-1`; BucketOwnerEnforced; all public access blocked; versioning; SSE-S3; TLS-only; retained on stack deletion; no website endpoint or lifecycle expiry yet |
| File scanning | One independent GuardDuty Malware Protection for S3 plan | Whole bucket; managed result tagging enabled; no read unless the exact object version is tagged `NO_THREATS_FOUND` |
| Web storage identity | IAM user `<prefix>-web-files` | Put, exact-version read, and scan-tag read only; no list, delete, policy, ACL, versioning, or tag-write permission |
| MCP storage identity | IAM user `<prefix>-mcp-files` | Exact-version read and scan-tag read only; no put, list, delete, policy, ACL, versioning, or tag-write permission |
| Cost warning | AWS monthly budget | USD 5; actual alert at 80 percent and forecast alert at 100 percent |
| Continuous probe | GitHub Actions `Hosted health` | Every 15 minutes; public `/health` plus MCP protected-resource metadata only; dormant until both repository variables are configured |

Railway's legacy Config as Code format is deprecated and scheduled to stop for new use after 2026-12-01. The repository therefore keeps the immutable build contract in `Dockerfile` and records the small set of Railway service settings here rather than adding a new deprecated `railway.json` or `railway.toml` file. A future Railway Terraform adoption is not required to prove this small alpha topology.

## Cost envelope

These figures are planning estimates, not quotes or invoices. Prices must be checked again in each billing screen before confirmation.

| Provider | Current published basis | Alpha expectation | Control |
| --- | --- | --- | --- |
| Railway | Hobby is USD 5/month including USD 5 of usage; RAM is USD 10/GB-month, CPU USD 20/vCPU-month, and egress USD 0.05/GB | USD 5-15/month for two low-traffic Node services | Email alert at USD 12; compute hard limit at USD 20; one replica each; no volume or preview environment |
| Neon | Launch is USD 0.106/CU-hour and USD 0.35/GB-month; restore history is USD 0.20/GB-month of changes | Approximately USD 7-20/month plus small storage/history charges | Fixed 0.25 CU ceiling and scale to zero; at 730 continuously active hours, compute is approximately USD 19.35 |
| AWS | GuardDuty Malware Protection for S3 includes 1,000 objects and 1 GB scanned per account/Region each month; S3 storage, requests, tags, and transfer remain usage-priced | Below USD 1/month while the alpha stays inside the scan allowance and stores only a few GB | USD 5 budget alerts; no public access; no unapproved service plans |
| Domain | Railway-generated domains | USD 0 for the hosted proof | A custom domain is a later, separate purchase decision |

The expected initial total is approximately USD 12-36/month. The planning ceiling is USD 45/month: Railway can stop at USD 20, Neon is capacity-bounded near USD 20 for continuously active 0.25 CU compute plus small storage/history, and AWS alerts at USD 4 actual and USD 5 forecast. AWS Budgets is not a hard shutdown mechanism, so representative usage and the billing dashboard must be reviewed during the first week.

Official pricing references:

- Railway [plans and usage pricing](https://docs.railway.com/pricing/plans) and [cost controls](https://docs.railway.com/pricing/cost-control)
- Neon [pricing](https://neon.com/pricing), [connection pooling](https://neon.com/docs/connect/connection-pooling), and [scale to zero](https://neon.com/docs/introduction/scale-to-zero)
- AWS [GuardDuty pricing](https://aws.amazon.com/guardduty/pricing/) and [S3 pricing](https://aws.amazon.com/s3/pricing/)

## Security settings

### Account ownership

- Use the product owner's durable email addresses, a password manager, and MFA for all three providers.
- Do not create AWS root access keys. Enable root MFA and create a separate administrative identity for normal console work.
- Keep production access limited to the product owner for the friend alpha. Add collaborators only through named individual accounts, never shared passwords.
- Enable Railway and Neon billing/incident notifications and subscribe to their regional status pages.

### Railway

- Connect the GitHub repository only after reviewing requested permissions.
- Deploy production only from the protected `main` branch after the milestone branch is merged. Disable automatic paid PR environments.
- Use one production environment and two persistent services. Do not attach a volume; no production request may depend on Railway's ephemeral filesystem.
- Configure EU West Metal explicitly, one replica per service, health path `/health`, 60-second deployment health timeout, restart policy `ALWAYS`, and serverless disabled.
- Start with 512 MiB/0.5 vCPU replica limits for web and 1 GiB/0.5 vCPU for MCP because bounded PDF parsing occurs in the MCP process. Limits are safety caps, not reserved spend.
- Seal `ALICE_DATABASE_URL`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`. Railway exposes service variables to builds as well as runtimes; the production Docker build therefore runs locked installation with lifecycle scripts disabled and never reads these values.
- Do not add `ALICE_MIGRATION_DATABASE_URL`, `ALICE_APPLICATION_DATABASE_ROLE`, an AWS root credential, or any provider account password to Railway.
- Do not enable Railway request logging that captures query strings, authorization headers, cookies, form bodies, or MCP request bodies. Application logs remain content-free and fixed.

Railway variables shared by both services:

```text
ALICE_DATABASE_URL=<pooled alice_app URL with sslmode=require&channel_binding=require>
ALICE_FILE_STORAGE=aws_s3
ALICE_S3_BUCKET=<stack output>
ALICE_S3_REGION=eu-central-1
HOST=0.0.0.0
NODE_ENV=production
```

Web-only variables:

```text
ALICE_WEB_URL=https://<alice-web Railway domain>
ALICE_MCP_URL=https://<alice-mcp Railway domain>
AWS_ACCESS_KEY_ID=<web-files key ID>
AWS_SECRET_ACCESS_KEY=<web-files secret>
```

MCP-only variables:

```text
ALICE_PUBLIC_URL=https://<alice-mcp Railway domain>
ALICE_WEB_URL=https://<alice-web Railway domain>
AWS_ACCESS_KEY_ID=<mcp-files key ID>
AWS_SECRET_ACCESS_KEY=<mcp-files secret>
```

### Neon

- Select AWS Frankfurt and PostgreSQL 17 at project creation. Region changes require a new project and migration.
- Use Launch with 0.25 CU minimum and maximum plus five-minute scale to zero. A first request after idle may have a small database wake delay; this is an accepted cost tradeoff for the initial alpha.
- Set the restore window to seven days and keep only the primary production branch after verification branches are removed.
- Use Neon's pooled hostname containing `-pooler` for `alice_app`. Use the direct hostname for migrations and `pg_dump`/restore because Neon's transaction pooler does not preserve all session features and is not the supported backup/migration path.
- Create `alice_app` with a provider-accepted high-entropy password, run the repository migration command with the direct owner URL, and verify the constrained grants before giving the pooled app URL to Railway.
- Neon Launch requires TLS and encryption at rest but does not include IP allow rules or private networking. The endpoint is internet-reachable through the Neon proxy and protected by TLS, channel binding, high-entropy role credentials, and least database privilege. Do not claim private networking.
- Rotate the application password immediately after suspected exposure and at the same time in both sealed Railway services.

### AWS

- Deploy `infra/aws/private-files.template.json` only in `eu-central-1`, after reviewing the CloudFormation change set and acknowledging GuardDuty Malware Protection terms.
- Supply a globally unique non-identifying bucket name, the budget-alert email, and the default resource prefix. The template creates no access key and outputs no secret.
- The stack creates the retained private bucket, TLS and tag-based bucket policy, GuardDuty scan role and plan, separate web/MCP IAM users, and budget alerts. It does not grant deletion to either runtime identity.
- Generate exactly one access key for each runtime IAM user only after the stack succeeds. Put each key only in its matching sealed Railway service. Never use root keys or reuse one key between services.
- Long-term keys are a documented residual risk. Review last-used data monthly, rotate at least every 90 days, and delete the previous key immediately after both a successful deployment and live S3 verification.
- Keep account- and bucket-level Block Public Access enabled. Do not add ACLs, CORS, a website endpoint, public policies, or object lifecycle expiry.
- Do not delete the CloudFormation stack or retained bucket. Permanent object-version erasure remains a separate privileged workflow and retention decision.

The AWS controls follow the official [GuardDuty service-role policy](https://docs.aws.amazon.com/guardduty/latest/ug/malware-protection-s3-iam-policy-prerequisite.html), [tag-based access-control example](https://docs.aws.amazon.com/guardduty/latest/ug/tag-based-access-s3-malware-protection.html), [CloudFormation malware-plan resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-guardduty-malwareprotectionplan.html), and [S3 TLS-only policy](https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-bucket-policies.html).

## Provisioning sequence

Every step stops on a failed check. No friend or real project data is admitted during provisioning.

1. Product owner approves the regions, plans, USD 45 ceiling, generated domains, Neon public-endpoint limitation, and AWS long-term-key limitation.
2. Product owner creates the three accounts, enables MFA, supplies billing details, and confirms alerts.
3. Create Neon first. Record project ID, region, PostgreSQL version, compute bounds, restore window, direct owner URL, and pooled application URL without committing either URL.
4. Create the high-entropy `alice_app` role and run `npm run db:migrate` with the direct migrator URL. Run the complete PostgreSQL test and logical backup/restore gates against an isolated verification branch or database before production data exists.
5. Create an AWS CloudFormation change set from the committed template, inspect it, then execute. Verify stack outputs, GuardDuty plan status, bucket versioning/encryption/public-access state, and both IAM policies before generating access keys.
6. Create the Railway project and two services from the same commit and Dockerfile. Configure domains, service settings, non-secret variables, then sealed service-specific secrets. Migrations never run as a Railway pre-deploy command.
7. Set reciprocal public origins, deploy web and MCP, and verify each `/health` response plus OAuth protected-resource and authorization metadata.
8. Set GitHub repository variables `ALICE_HOSTED_WEB_ORIGIN` and `ALICE_HOSTED_MCP_ORIGIN`, manually run `Hosted health`, and confirm the scheduled job records only public contract status.
9. Run the hosted authentication, OAuth, MCP read/write/revocation, PostgreSQL concurrency, backup/restore, clean-file, EICAR, malformed/oversized-file, scan-failure, exact-version, signed-URL-expiry, cross-tenant, and public-access-denial checks.
10. Review Railway, Neon, and AWS billing after the representative test week. Stop and return for approval if forecast spend exceeds USD 45/month or any required security control needs a higher plan.

## Evidence required to close Bundle 1

The Milestone 06 deployment and private-file tasks remain open until durable evidence records:

- provider account/resource identifiers without credentials;
- exact regions, plans, limits, restore settings, and billing alerts;
- successful empty migration and constrained runtime-role verification;
- successful production-image starts for both services as a non-root user;
- stable HTTPS origins, health behavior with reachable and unreachable PostgreSQL, and public MCP metadata;
- content-free logs under authentication, upload, scan, and MCP failures;
- S3 account/bucket public-access blocks, versioning, encryption, TLS denial, no-list/no-delete runtime permissions, GuardDuty plan health, scan tagging, non-clean read denial, clean exact-version download, and signed URL expiry;
- logical backup and restore plus the selected Neon restore procedure;
- scheduled hosted probe results; and
- an observed one-week run rate within the approved ceiling.

The production deployment checkbox must not be marked complete merely because this plan or template exists.

## Pending combined artifact-integrity deployment plan (source only, 2026-09-13)

Production remains on source `751998e`; this checkpoint creates no AWS change set, runs no production migration, touches no hosted data, and leaves the existing web and MCP URLs unchanged. After the final four-task branch commit is pushed, deployment requires a new explicit product-owner approval for this exact staged operation:

1. Build the pushed commit once as a single-manifest Linux/ARM64 image with provenance and SBOM attestations disabled; verify non-root `node`, `npm run start:mcp`, both production builds, exact archive SHA-256, and an unused short-commit ECR tag. Push, resolve the immutable digest, and require completed scanning with no findings before any stack action.
2. Create review-only `m06-artifact-integrity-safe-stop` with all thirteen retained production parameter values reused, `DeployServices=false`, `OriginsConfigured=false`, and every temporary operation false. It may remove only the documented ten runtime/public/log resources with no retained-resource replacement. Execute only after separate approval and wait for `UPDATE_COMPLETE`.
3. Create review-only `m06-artifact-integrity-migration` using the new immutable application digest, `RunMigration=true`, services/origins and every other temporary operation false. It may add only the four interface endpoints, migration endpoint security group, ECS cluster, execution role, three-day log group, and ARM64 task definition. Run exactly one no-public-IP task in the two private subnets; require exit 0 and the content-free log `PostgreSQL migrations current: 28 applied.`
4. Create review-only `m06-artifact-integrity-migration-cleanup` with every temporary operation false. It must remove exactly the same nine temporary resources and return the stack to retained private foundation state. No paid interface endpoint may remain.
5. Create review-only `m06-artifact-integrity-private-runtime` using the same immutable digest, `DeployServices=true`, `OriginsConfigured=false`, and the two existing public URL parameter values. It may add only the two ARM64 functions, their two Function URL configurations, and two 14-day log groups, without public permissions.
6. Before public restoration, confirm the generated web and MCP origins exactly equal the existing production origins. A mismatch is a hard stop requiring a separately reviewed URL-continuity decision; do not silently update provider configuration or expose replacement URLs.
7. Create review-only `m06-artifact-integrity-origins` with `DeployServices=true`, `OriginsConfigured=true`, both exact existing origins, and every temporary operation false. Its allowed direct changes are the four Function URL permissions plus non-replacement reciprocal environment values; IAM, CORS, storage, retention, network, database, and provider configuration must otherwise remain unchanged.
8. After separately approved execution, verify both functions Active/Successful on the exact digest; unchanged URLs; web/MCP health and PostgreSQL reachability; logged-out redirect; OAuth issuer/resource/S256 contract; unauthenticated MCP challenge; existing PUT-only bounded CORS; IAM allow/denials; 32-resource final stack; all temporary flags false; only the free S3 gateway endpoint; no available change set; and budget state. Then run fresh human ChatGPT/Claude artifact create/search/read/version/conflict flows without changing the pending provider-backup-expiry result.
9. Remove local and CloudShell archives, transient tags/layers, minified templates, parameter files, registry credentials, and temporary logs after evidence is recorded. Keep the immutable ECR image and prior rollback digest.

Migrations `026`–`028` are additive. Migration `028` deliberately retains the `decision_records_json DEFAULT '[]'`, so rolling the two functions back to production image `751998e` after migration remains write-compatible; the older image ignores the new receipt, lifecycle, decision-record, and resolution tables. Application rollback does not reverse migrations or delete new rows. If migration fails, do not restore the new image; clean up the temporary task, inspect only content-free failure evidence, and restore `751998e`. If post-restoration checks fail, update both functions together to digest `sha256:68184a1414177060dbcfa5ef50704662b44bae0efb45030fd5f249ad91452f22`, then repeat the complete boundary verification. No automatic data rollback, destructive migration, provider login, invitation, backup, erasure, or project mutation is authorized by this plan.
