# Private Alpha Infrastructure Selection

Status: Recommended; no resources provisioned

Decision date: 2026-08-30

Official references revalidated: 2026-08-30

## Decision boundary

This document is a read-only provider comparison approved by the product owner. It does not create an account, resource, DNS record, credential, paid plan, public deployment, invitation, or external data transfer. Provisioning and any spend remain a separate approval gate.

## Recommended stack

| Responsibility | Recommendation | Initial region | Why it fits alice. |
| --- | --- | --- | --- |
| Web and MCP compute | Railway, two separately health-checked services | EU West, Amsterdam | Direct support for always-on Node services, public HTTPS/custom domains, Streamable HTTP MCP, usage limits, and a low-volume usage model. |
| PostgreSQL 17 system of record | Neon Launch, one production project | AWS Europe, Frankfurt | Managed PostgreSQL, required TLS, pooled and direct connections, SQL-created constrained roles, restore history, and usage-based scale. |
| Private file bytes and malware scanning | Amazon S3 Standard plus GuardDuty Malware Protection for S3 | Europe, Frankfurt (`eu-central-1`) | Private/versioned objects, managed encryption, short-lived signed access, and managed scanning with a result that can gate every read. |
| Continuous endpoint probe | Existing GitHub Actions, scheduled read-only health job | N/A | Avoids another subprocessor for the initial cohort; probes only `/health` and protocol metadata without user content or credentials. |

Amsterdam and Frankfurt are the closest available matching European regions in the selected services and are a reasonable starting point for a Dubai-based owner and initial private cohort. Region is immutable or costly to change on some providers, so the exact cohort location and disclosure must be confirmed before provisioning.

## Compute decision

Railway is preferred over Render, Vercel, and Fly.io for this milestone:

- Railway documents deployment of a TypeScript Streamable HTTP MCP server and supplies public HTTPS domains, custom-domain certificates, service health checks during deployment, replica resource limits, hard usage limits, and an EU West region. Its Hobby plan is currently a USD 5 monthly minimum whose credit applies to resource use; published usage rates are USD 10/GB-month RAM, USD 20/vCPU-month, USD 0.05/GB egress, and USD 0.15/GB-month volume storage. [Railway MCP deployment](https://docs.railway.com/guides/mcp-server), [regions](https://docs.railway.com/deployments/regions), [pricing](https://docs.railway.com/pricing), [cost controls](https://docs.railway.com/pricing/cost-control), [domains and TLS](https://docs.railway.com/networking/domains/working-with-domains)
- Render is technically viable and has stronger continuous platform health checking, native Node 24, stable web services, and paid PostgreSQL recovery. Its free services sleep after 15 minutes and free PostgreSQL expires after 30 days, so the free tier cannot be the friend-alpha environment. Render remains the fallback if Railway's hosted protocol probe or operational behavior fails. [Render health checks](https://render.com/docs/health-checks), [Node versions](https://render.com/docs/node-version), [free-tier limits](https://render.com/docs/free), [PostgreSQL backups](https://render.com/docs/postgresql-backups)
- Vercel is not selected for the first hosted verification. Its function duration and serverless lifecycle are a less direct match for the repository's two independent Express processes and remote MCP protocol verification. It may be reconsidered only after a hosted proof, not assumed from generic Express support. [Vercel function limits](https://vercel.com/docs/functions/limitations)
- Fly.io can run the services and offers precise machine sizing, but it adds more infrastructure operation than Railway for a small friend alpha. Its health checks route around unhealthy machines but do not themselves restart them. [Fly.io pricing](https://fly.io/docs/about/pricing/), [health checks](https://fly.io/docs/reference/health-checks/)

The web and MCP services remain separate processes and stable origins. They receive the same constrained application database credential but different public URLs and health checks. Deployment never runs migrations automatically. A release first runs the existing clean check, then an explicit migration using a separately supplied owner credential, then deploys only after the migration ledger matches.

Railway's deployment health check is not continuous after a release. The application already makes `/health` query PostgreSQL; a scheduled GitHub Actions probe must exercise both origins after provisioning and report a failure without sending authentication or user data. This is a required mitigation, not an optional monitoring enhancement.

## PostgreSQL decision

Neon Launch is preferred over a platform PostgreSQL container because PostgreSQL is alice.'s system of record, not an application sidecar. Neon requires TLS, supports PgBouncer connection pooling, SQL-created least-privilege roles, and point-in-time restore history. Its published Launch example is approximately USD 15/month for intermittent compute with 1 GB storage; current rates are USD 0.106/CU-hour and USD 0.35/GB-month, with a seven-day restore window. [Neon pricing](https://neon.com/pricing), [TLS and encryption](https://neon.com/docs/security/security-overview), [connection pooling](https://neon.com/docs/connect/connection-pooling), [PostgreSQL compatibility and roles](https://neon.com/docs/reference/compatibility)

The production wiring uses:

- a pooled, TLS-required URL for both constrained application services;
- a direct, TLS-required owner URL only for the explicit migration/role-grant command;
- the existing application role with no schema creation and no update/delete privilege over immutable evidence, accepted state, audit history, context mappings, or exclusions;
- scheduled provider snapshots plus the repository's logical `pg_dump`/restore drill; and
- a disabled or tightly allowlisted public endpoint after migration and operational access are proven, where the selected plan permits it.

The Neon free tier is suitable only for pre-provisioning experiments. Its sleep behavior and shorter restore window do not satisfy the stable friend-alpha target. Railway PostgreSQL and Render PostgreSQL remain fallbacks, but neither is selected merely to reduce the number of vendors.

## Object storage and scan decision

Amazon S3 Standard with GuardDuty Malware Protection is preferred over Cloudflare R2 plus a self-operated scanner.

S3 configuration requirements:

- one general-purpose bucket in `eu-central-1`, with account- and bucket-level Block Public Access, ACLs disabled, versioning enabled, and no website or public object endpoint;
- default server-side encryption and TLS-only bucket policy;
- opaque non-reused object keys, with the exact S3 version identifier, SHA-256 content hash, verified media type, size, and lifecycle state stored in PostgreSQL;
- an application IAM principal that can put bounded objects and read only an exact clean object version, but cannot list the bucket, alter policies, disable scanning/versioning, or permanently delete bytes;
- GuardDuty scanning enabled before the first upload, with managed scan-result tags and tag-based access control denying reads unless the result is `NO_THREATS_FOUND`;
- `THREATS_FOUND`, `UNSUPPORTED`, `ACCESS_DENIED`, missing, and `FAILED` results all treated as non-readable failures;
- PostgreSQL remains `scanning` until alice. independently observes the exact bucket/key/version scan result; duplicate at-least-once scan events remain idempotent;
- a short-lived, single-object signed GET only after current alice. authorization is rechecked; signed URLs are bearer credentials and must never be logged or stored as provenance; and
- no ordinary object overwrite or delete. Policy-governed erasure will use a separate privileged path after retention and backup timelines are approved.

S3 encrypts new uploads by default, supports versioning and Block Public Access, and GuardDuty scans newly uploaded objects in an isolated same-region environment. GuardDuty publishes `NO_THREATS_FOUND`, `THREATS_FOUND`, `UNSUPPORTED`, `ACCESS_DENIED`, and `FAILED` outcomes and supports tag-based access control. [S3 access controls](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-management.html), [Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html), [GuardDuty scan process](https://docs.aws.amazon.com/guardduty/latest/ug/how-malware-protection-for-s3-gdu-works.html), [scan-result tags](https://docs.aws.amazon.com/guardduty/latest/ug/monitor-enable-s3-object-tagging-malware-protection.html)

GuardDuty Malware Protection for S3 includes 1,000 objects and 1 GB scanned per account/region each month. Beyond that, cost is regional and based on objects plus bytes; AWS's current US East example is USD 0.215 per 1,000 objects plus USD 0.09/GB. S3 itself has no minimum charge and bills storage, requests, and transfer separately. These are planning references, not a Frankfurt quote. [GuardDuty pricing](https://aws.amazon.com/guardduty/pricing/), [S3 pricing](https://aws.amazon.com/s3/pricing/)

Cloudflare R2 remains the storage fallback. It currently includes 10 GB-month Standard storage, one million Class A requests, ten million Class B requests, and free egress, and encrypts objects at rest. It is not selected because it does not supply the required managed malware disposition; operating ClamAV would add an always-on memory-heavy service, signature-update lifecycle, scanner health/failure handling, and another recovery path. [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [R2 data security](https://developers.cloudflare.com/r2/reference/data-security/), [ClamAV signature updates](https://docs.clamav.net/manual/Usage/SignatureManagement.html)

## Upload flow implied by the selection

The first implementation keeps the trust boundary at alice.:

1. an authenticated browser streams a bounded file to the alice. web origin;
2. alice. bounds bytes, sanitizes the display name, verifies the allowlisted signature/media type, and computes SHA-256 before any active reference exists;
3. alice. uploads the verified bytes to a random private S3 object key and records metadata as `scanning`;
4. GuardDuty scans the exact new object version;
5. alice. observes and stores the scan disposition; only `NO_THREATS_FOUND` can become a downloadable active artifact reference; and
6. every preview/download request rechecks current project/context access before returning a very short-lived exact-version URL.

The browser never receives reusable AWS credentials. Direct-to-S3 upload is deferred until an equally strong finalize-and-scan protocol is necessary for measured file sizes; it is not assumed merely for progress UI. File contents remain untrusted input after a clean malware scan. Clean means only that the scanner found no known threat, not that claims or embedded instructions are trusted.

## Cost envelope and stop conditions

For a low-volume friend alpha, the planning estimate is USD 20-45/month plus a domain, dominated by two Railway services and Neon Launch; S3 and GuardDuty should be small at the stated test volume. This is not a quote. Before provisioning:

- set a Railway hard usage limit and alert;
- set AWS Budgets alerts and retain only the required GuardDuty protection plan;
- record Neon compute/storage limits and restore settings;
- disable automatic paid preview environments;
- choose a monthly ceiling with the product owner; and
- recheck all displayed prices in the actual billing region.

Provisioning stops if the expected steady-state estimate exceeds USD 50/month, if a required control needs a higher plan than documented here, or if the exact storage/subprocessor region cannot be disclosed accurately. Any such change returns to the product owner for approval.

## Verification required before invitations

Provider selection is not provider verification. Before any friend invitation or real project data:

- migrate an empty Neon database and verify the constrained application role from Railway;
- run the full PostgreSQL concurrency and immutable-history gate against Neon;
- run and restore a logical backup in addition to testing provider restore behavior;
- verify stable HTTPS, OAuth metadata, Streamable HTTP MCP, both `/health` endpoints, redacted logs, and failed-database health behavior;
- upload clean fixtures, EICAR, bad signatures, oversized files, scanner failures, and guessed/foreign identifiers without activating or disclosing unsafe objects;
- prove S3 public-access blocks, least-privilege IAM, scan-tag read denial, exact-version signed downloads, expiry, and non-logging of signed URLs;
- record actual monthly run-rate after at least one representative test week; and
- obtain separate approval before external invitations, real user data, or advertised capability claims.
