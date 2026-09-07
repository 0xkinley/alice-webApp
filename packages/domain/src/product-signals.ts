import { tenantScopeForUser } from "./authorization.ts";

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function utcWeek(value: string) {
  const date = new Date(value);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function safeMetadata(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function sevenDayCrossHostProjects(rows) {
  const byProject = new Map<string, any[]>();
  for (const row of rows) {
    if (!row.project_id) continue;
    const projectRows = byProject.get(row.project_id) || [];
    projectRows.push(row);
    byProject.set(row.project_id, projectRows);
  }
  let count = 0;
  for (const projectRows of byProject.values()) {
    const sorted = projectRows.sort(
      (left, right) => Date.parse(left.created_at) - Date.parse(right.created_at),
    );
    let reused = false;
    for (let left = 0; left < sorted.length && !reused; left += 1) {
      for (let right = left + 1; right < sorted.length; right += 1) {
        const difference =
          Date.parse(sorted[right].created_at) - Date.parse(sorted[left].created_at);
        if (difference > 7 * 24 * 60 * 60 * 1_000) break;
        if (sorted[left].client_classification !== sorted[right].client_classification) {
          reused = true;
          break;
        }
      }
    }
    if (reused) count += 1;
  }
  return count;
}

export async function getPrivateAlphaSignals(database, userId: string) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return undefined;

  const reads = await database
    .prepare(
      `SELECT status, failure_code, client_classification, project_id, created_at
       FROM context_read_events
       WHERE user_id = ? AND connection_workspace_id = ?
       ORDER BY created_at, id`,
    )
    .all(tenant.userId, tenant.workspaceId);
  const successfulReads = reads.filter(({ status }) => status === "succeeded");
  const failedReads = reads.length - successfulReads.length;
  const activeWeeks = new Set(
    successfulReads.map(({ created_at: createdAt }) => utcWeek(createdAt)),
  );

  const captures = await database
    .prepare(
      `SELECT evidence.id, evidence.created_at, candidate.status,
              COUNT(*) OVER (PARTITION BY evidence.id) AS candidate_count
       FROM evidence_events evidence
       JOIN integration_connections connection
         ON connection.workspace_id = evidence.connection_workspace_id
        AND connection.id = evidence.connection_id
        AND connection.user_id = ?
       JOIN candidate_claims candidate
         ON candidate.workspace_id = evidence.workspace_id
        AND candidate.project_id = evidence.project_id
        AND candidate.evidence_id = evidence.id
       WHERE evidence.connection_workspace_id = ?
         AND evidence.tool_name = 'save_project_update'
       ORDER BY evidence.created_at, evidence.id, candidate.id`,
    )
    .all(tenant.userId, tenant.workspaceId);
  const offers = new Map<
    string,
    { createdAt: string; candidateCount: number; statuses: string[] }
  >();
  for (const row of captures) {
    const offer = offers.get(row.id) || {
      createdAt: row.created_at,
      candidateCount: Number(row.candidate_count),
      statuses: [] as string[],
    };
    offer.statuses.push(row.status);
    offers.set(row.id, offer);
  }

  const decisions = await database
    .prepare(
      `SELECT action, safe_metadata_json, created_at
       FROM audit_events
       WHERE action IN ('candidate_update_confirmed', 'candidate_update_cancelled')
       ORDER BY created_at, id`,
    )
    .all();
  const decisionByEvidence = new Map<string, string>();
  for (const decision of decisions) {
    const metadata: any = safeMetadata(decision.safe_metadata_json);
    if (typeof metadata.evidence_id === "string" && offers.has(metadata.evidence_id)) {
      decisionByEvidence.set(metadata.evidence_id, decision.created_at);
    }
  }

  let confirmed = 0;
  let cancelled = 0;
  let pending = 0;
  let proposalCount = 0;
  const decisionSeconds: number[] = [];
  for (const [evidenceId, offer] of offers) {
    proposalCount += offer.candidateCount;
    if (offer.statuses.every((status) => status === "accepted")) confirmed += 1;
    else if (offer.statuses.every((status) => status === "rejected")) cancelled += 1;
    else pending += 1;
    const decidedAt = decisionByEvidence.get(evidenceId);
    if (decidedAt) {
      decisionSeconds.push(
        Math.max(0, Math.round((Date.parse(decidedAt) - Date.parse(offer.createdAt)) / 1_000)),
      );
    }
  }

  const repairAudits = await database
    .prepare(
      `SELECT safe_metadata_json FROM audit_events
       WHERE action = 'saved_context_removed' AND actor_id = ?`,
    )
    .all(tenant.userId);
  const repairCount = repairAudits.filter((audit) => {
    const metadata: any = safeMetadata(audit.safe_metadata_json);
    return ["stale", "contradicted", "wrong"].includes(metadata.repair_type);
  }).length;
  const offerCount = offers.size;
  const decidedOffers = confirmed + cancelled;
  return {
    privacy: {
      content_fields_read: false,
      limitation:
        "alice. can count MCP calls it receives and retained capture outcomes, but cannot observe host turns where the host never called alice. or routine Save cards the user ignored or allowed to expire.",
    },
    consumption: {
      observed_attempts: reads.length,
      successful_reads: successfulReads.length,
      failed_reads: failedReads,
      success_rate_percent:
        reads.length === 0 ? null : Math.round((successfulReads.length / reads.length) * 100),
      successful_host_surfaces: new Set(
        successfulReads.map(({ client_classification: classification }) => classification),
      ).size,
      active_utc_weeks: activeWeeks.size,
      repeated_weekly_use: activeWeeks.size >= 2,
      projects_reused_across_hosts_within_7_days: sevenDayCrossHostProjects(successfulReads),
    },
    saving: {
      offers: offerCount,
      proposals: proposalCount,
      confirmed_offers: confirmed,
      cancelled_offers: cancelled,
      pending_offers: pending,
      completion_rate_percent:
        offerCount === 0 ? null : Math.round((decidedOffers / offerCount) * 100),
      average_proposals_per_offer:
        offerCount === 0 ? null : Math.round((proposalCount / offerCount) * 10) / 10,
      median_decision_seconds: median(decisionSeconds),
      repairs: repairCount,
    },
  };
}
