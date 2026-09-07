import { createHash } from "node:crypto";
import { consumptionContractVersion } from "@alice/schemas";
import {
  contextScopeForConnection,
  contextScopeForUser,
  projectScopeForUser,
  tenantScopeForUser,
} from "./authorization.ts";
import { listWorkContexts } from "./work-contexts.ts";

// Trusted context is assembled only from human-accepted state.

function parseJson(value) {
  return JSON.parse(value);
}

function normalizedTerms(value) {
  return [
    ...new Set(
      String(value)
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    ),
  ].sort();
}

function relevanceScore(row, taskTerms) {
  const stateKeyTerms = new Set(normalizedTerms(row.state_key));
  const summaryTerms = new Set(normalizedTerms(row.summary));
  const valueTerms = new Set(normalizedTerms(row.value_json));
  return taskTerms.reduce(
    (score, term) =>
      score +
      (stateKeyTerms.has(term) ? 8 : 0) +
      (summaryTerms.has(term) ? 4 : 0) +
      (valueTerms.has(term) ? 2 : 0),
    0,
  );
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function categoryForStateKey(stateKey) {
  if (/^(?:question|questions|open_question|open_questions)[._-]/.test(stateKey)) {
    return "open_questions";
  }
  if (/^(?:artifact|artifacts)[._-]/.test(stateKey)) return "artifacts";
  return "accepted_decisions";
}

const categoryPriority = Object.freeze({
  accepted_decisions: 0,
  unresolved_conflicts: 1,
  open_questions: 2,
  artifacts: 3,
  file_artifacts: 4,
});

function compareRankedEntries(left, right) {
  return (
    right.relevance - left.relevance ||
    categoryPriority[left.category] - categoryPriority[right.category] ||
    compareText(left.item.state_key, right.item.state_key) ||
    compareText(left.stableId, right.stableId)
  );
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function latestTimestamp(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function updateBudgetUsed(context) {
  let previous = -1;
  while (previous !== context.package.budget.used) {
    previous = context.package.budget.used;
    context.package.budget.used = serializedBytes(context);
  }
  return context;
}

function omissionCounts(availableCounts, selected) {
  const counts = Object.fromEntries(
    Object.entries(availableCounts).map(([category, available]) => [
      category,
      Number(available) - selected[category].length,
    ]),
  );
  return {
    total: Object.values(counts).reduce((total, count) => total + count, 0),
    ...counts,
  };
}

function buildContext({
  project,
  context,
  task,
  selected,
  freshness,
  contextBudget,
  availableCounts,
  version,
}) {
  const omissions = omissionCounts(availableCounts, selected);
  return updateBudgetUsed({
    contract_version: consumptionContractVersion,
    project,
    context,
    task,
    ...selected,
    package: {
      version,
      selection_strategy: "deterministic_full_text_v2",
      freshness,
      budget: { unit: "utf8_bytes", limit: contextBudget, used: 0 },
      omissions: {
        ...omissions,
        reason: omissions.total === 0 ? "none" : "budget_exhausted",
      },
    },
  });
}

export class ContextBudgetError extends Error {}

export async function listProjects(database, userId) {
  const tenant = await tenantScopeForUser(database, userId);
  if (!tenant) return [];
  const projects = await database
    .prepare(
      `SELECT project.id, project.workspace_id, project.name, project.brief,
              project.created_at, project.updated_at
       FROM projects project
       JOIN project_memberships membership
         ON membership.workspace_id = project.workspace_id
        AND membership.project_id = project.id
        AND membership.user_id = ?
        AND membership.ended_at IS NULL
       WHERE project.archived_at IS NULL
       ORDER BY project.name, project.id`,
    )
    .all(tenant.userId);
  const visible: any[] = [];
  for (const project of projects) {
    const contexts = (await listWorkContexts(database, userId, project.id)) || [];
    let acceptedStateCount = 0;
    let acceptedStateUpdatedAt = null;
    for (const context of contexts) {
      const current = await database
        .prepare(
          `SELECT COUNT(accepted.id) AS accepted_state_count,
                  MAX(accepted.accepted_at) AS accepted_state_updated_at
           FROM accepted_project_state accepted
           JOIN accepted_context_entries entry
             ON entry.workspace_id = accepted.workspace_id
            AND entry.project_id = accepted.project_id
            AND entry.accepted_state_id = accepted.id
            AND entry.context_id = ?
           WHERE accepted.workspace_id = ? AND accepted.project_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM context_entry_exclusions exclusion
               WHERE exclusion.workspace_id = accepted.workspace_id
                 AND exclusion.project_id = accepted.project_id
                 AND exclusion.accepted_state_id = accepted.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM accepted_project_state newer
               JOIN accepted_context_entries newer_entry
                 ON newer_entry.workspace_id = newer.workspace_id
                AND newer_entry.project_id = newer.project_id
                AND newer_entry.accepted_state_id = newer.id
                AND newer_entry.context_id = entry.context_id
               WHERE newer.workspace_id = accepted.workspace_id
                 AND newer.project_id = accepted.project_id
                 AND newer.state_key = accepted.state_key
                 AND newer.version > accepted.version
             )`,
        )
        .get(context.id, project.workspace_id, project.id);
      acceptedStateCount += Number(current.accepted_state_count);
      if (
        current.accepted_state_updated_at &&
        (!acceptedStateUpdatedAt || current.accepted_state_updated_at > acceptedStateUpdatedAt)
      ) {
        acceptedStateUpdatedAt = current.accepted_state_updated_at;
      }
    }
    visible.push({
      id: project.id,
      name: project.name,
      brief: project.brief,
      created_at: project.created_at,
      updated_at: project.updated_at,
      accepted_state_count: acceptedStateCount,
      accepted_state_updated_at: acceptedStateUpdatedAt,
    });
  }
  return visible;
}

function latestEffectiveAcceptedRows(acceptedRows, projectWideId, selectedContextId) {
  const allowedContextIds = new Set([projectWideId, selectedContextId].filter(Boolean));
  const latestByContextAndKey = new Map();
  for (const row of acceptedRows) {
    if (!allowedContextIds.has(row.context_id)) continue;
    const key = `${row.context_id}\u0000${row.state_key}`;
    const previous = latestByContextAndKey.get(key);
    if (!previous || row.version > previous.version) latestByContextAndKey.set(key, row);
  }

  const effectiveByStateKey = new Map();
  for (const row of latestByContextAndKey.values()) {
    if (row.context_id === projectWideId && !row.removed_at) {
      effectiveByStateKey.set(row.state_key, row);
    }
  }
  if (selectedContextId) {
    for (const row of latestByContextAndKey.values()) {
      if (row.context_id === selectedContextId && !row.removed_at) {
        effectiveByStateKey.set(row.state_key, row);
      }
    }
  }
  return effectiveByStateKey;
}

export async function getProjectContext(
  database,
  {
    userId,
    connectionId = undefined,
    projectId,
    contextId,
    task,
    contextBudget,
    fileTextReadAvailable = false,
  },
) {
  const scope = await projectScopeForUser(database, { userId, projectId });
  if (!scope) return undefined;
  const project = await database
    .prepare(
      `SELECT id, name, brief, created_at, updated_at
       FROM projects WHERE id = ? AND workspace_id = ?`,
    )
    .get(projectId, scope.projectWorkspaceId);
  if (!project) return undefined;

  const contexts = await database
    .prepare(
      `SELECT id, name, description, context_kind, visibility, updated_at
       FROM work_contexts
       WHERE workspace_id = ? AND project_id = ? AND archived_at IS NULL
         AND (context_kind = 'project_wide' OR id = ?)
       ORDER BY context_kind, id`,
    )
    .all(scope.projectWorkspaceId, projectId, contextId || "");
  const projectWide = contexts.find(({ context_kind: kind }) => kind === "project_wide");
  const selectedContext = contextId
    ? contexts.find(({ id, context_kind: kind }) => id === contextId && kind === "work")
    : undefined;
  if (!projectWide || (contextId && !selectedContext)) return undefined;
  const selectedForAuthorization = selectedContext || projectWide;
  const authorizeContext = (authorizedContextId) =>
    connectionId
      ? contextScopeForConnection(database, {
          userId,
          connectionId,
          projectId,
          contextId: authorizedContextId,
        })
      : contextScopeForUser(database, {
          userId,
          projectId,
          contextId: authorizedContextId,
        });
  if (!(await authorizeContext(selectedForAuthorization.id))) {
    return undefined;
  }
  const projectWideAuthorized = Boolean(await authorizeContext(projectWide.id));
  const allowedContextIds = new Set(
    [projectWideAuthorized ? projectWide.id : undefined, selectedContext?.id].filter(Boolean),
  );
  const selectedContextRow = selectedContext || projectWide;
  const context = {
    id: selectedContextRow.id,
    name: selectedContextRow.name,
    description: selectedContextRow.description,
    visibility: selectedContextRow.visibility,
    updated_at: selectedContextRow.updated_at,
    includes_project_wide: projectWideAuthorized,
  };

  const acceptedRows = await database
    .prepare(
      `SELECT accepted.id AS accepted_state_id, accepted.state_key, accepted.value_json,
              accepted.version, accepted.accepted_at, accepted.candidate_id,
              accepted.evidence_id, candidate.summary,
              evidence.payload_hash AS evidence_payload_hash,
              evidence.created_at AS evidence_captured_at,
              COALESCE(entry.context_id, ?) AS context_id,
              exclusion.removed_at
       FROM accepted_project_state accepted
       JOIN candidate_claims candidate
         ON candidate.workspace_id = accepted.workspace_id
        AND candidate.project_id = accepted.project_id
        AND candidate.id = accepted.candidate_id
        AND candidate.evidence_id = accepted.evidence_id
       JOIN evidence_events evidence
         ON evidence.workspace_id = accepted.workspace_id
        AND evidence.project_id = accepted.project_id
        AND evidence.id = accepted.evidence_id
       LEFT JOIN accepted_context_entries entry
         ON entry.workspace_id = accepted.workspace_id
        AND entry.project_id = accepted.project_id
        AND entry.accepted_state_id = accepted.id
       LEFT JOIN context_entry_exclusions exclusion
         ON exclusion.workspace_id = accepted.workspace_id
        AND exclusion.project_id = accepted.project_id
        AND exclusion.accepted_state_id = accepted.id
       WHERE accepted.project_id = ? AND accepted.workspace_id = ?
       ORDER BY accepted.state_key, accepted.version, accepted.id`,
    )
    .all(projectWide.id, projectId, scope.projectWorkspaceId);
  const effectiveByStateKey = latestEffectiveAcceptedRows(
    acceptedRows,
    projectWide.id,
    selectedContext?.id,
  );
  const rows = [...effectiveByStateKey.values()].sort((left, right) =>
    compareText(left.state_key, right.state_key),
  );

  const pendingRows = await database
    .prepare(
      `SELECT alternative.id AS alternative_candidate_id, alternative.state_key,
              alternative.value_json,
              alternative.evidence_id AS alternative_evidence_id,
              alternative_evidence.payload_hash AS alternative_evidence_payload_hash,
              alternative_evidence.created_at AS alternative_evidence_captured_at,
              COALESCE(target.context_id, ?) AS context_id
       FROM candidate_claims alternative
       JOIN evidence_events alternative_evidence
         ON alternative_evidence.workspace_id = alternative.workspace_id
        AND alternative_evidence.project_id = alternative.project_id
        AND alternative_evidence.id = alternative.evidence_id
       LEFT JOIN candidate_context_targets target
         ON target.workspace_id = alternative.workspace_id
        AND target.project_id = alternative.project_id
        AND target.candidate_id = alternative.id
       WHERE alternative.workspace_id = ? AND alternative.project_id = ?
         AND alternative.status = 'pending'
       ORDER BY alternative.state_key, alternative.id`,
    )
    .all(projectWide.id, scope.projectWorkspaceId, projectId);
  const conflictRows = pendingRows
    .filter((row) => allowedContextIds.has(row.context_id))
    .map((row) => ({ ...row, accepted: effectiveByStateKey.get(row.state_key) }))
    .filter(({ accepted, value_json: valueJson }) => accepted && accepted.value_json !== valueJson);

  const fileRows = await database
    .prepare(
      `SELECT reference.id AS file_reference_id, reference.logical_file_id,
              reference.version, reference.display_name, reference.source_host,
              reference.referenced_at, reference.context_id,
              object.content_sha256, object.byte_size,
              object.verified_media_type AS media_type
       FROM file_context_references reference
       JOIN file_objects object
         ON object.workspace_id = reference.workspace_id
        AND object.id = reference.file_object_id
        AND object.scan_status = 'clean'
       WHERE reference.workspace_id = ? AND reference.project_id = ?
         AND reference.context_id IN (?, ?)
         AND NOT EXISTS (
           SELECT 1 FROM file_context_references grouped
           JOIN file_reference_exclusions exclusion
             ON exclusion.workspace_id = grouped.workspace_id
            AND exclusion.project_id = grouped.project_id
            AND exclusion.context_id = grouped.context_id
            AND exclusion.file_reference_id = grouped.id
           WHERE grouped.workspace_id = reference.workspace_id
             AND grouped.project_id = reference.project_id
             AND grouped.context_id = reference.context_id
             AND grouped.logical_file_id = reference.logical_file_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM file_context_references newer
           JOIN file_objects newer_object
             ON newer_object.workspace_id = newer.workspace_id
            AND newer_object.id = newer.file_object_id
            AND newer_object.scan_status = 'clean'
           WHERE newer.workspace_id = reference.workspace_id
             AND newer.project_id = reference.project_id
             AND newer.context_id = reference.context_id
             AND newer.logical_file_id = reference.logical_file_id
             AND newer.version > reference.version
         )
       ORDER BY reference.context_id, lower(reference.display_name), reference.id`,
    )
    .all(
      scope.projectWorkspaceId,
      projectId,
      projectWide.id,
      selectedContext?.id || projectWide.id,
    );

  const taskTerms = normalizedTerms(task);
  const rankedAccepted = rows.map((row) => {
    const category = categoryForStateKey(row.state_key);
    return {
      category,
      item: {
        state_key: row.state_key,
        summary: row.summary,
        value: parseJson(row.value_json),
        version: row.version,
        accepted_at: row.accepted_at,
        provenance: {
          accepted_state_id: row.accepted_state_id,
          candidate_id: row.candidate_id,
          evidence_id: row.evidence_id,
          evidence_payload_hash: row.evidence_payload_hash,
          evidence_captured_at: row.evidence_captured_at,
        },
        ...(category === "open_questions" ? { status: "open" } : {}),
        ...(category === "artifacts" ? { handling: "reference_only" } : {}),
      },
      relevance: relevanceScore(row, taskTerms),
      stableId: row.accepted_state_id,
    };
  });

  const conflictsByStateKey = new Map();
  for (const row of conflictRows) {
    const accepted = row.accepted;
    let conflict = conflictsByStateKey.get(row.state_key);
    if (!conflict) {
      conflict = {
        category: "unresolved_conflicts",
        item: {
          state_key: row.state_key,
          status: "unresolved",
          trusted_current: {
            version: accepted.version,
            provenance: {
              accepted_state_id: accepted.accepted_state_id,
              candidate_id: accepted.candidate_id,
              evidence_id: accepted.evidence_id,
              evidence_payload_hash: accepted.evidence_payload_hash,
              evidence_captured_at: accepted.evidence_captured_at,
            },
          },
          unreviewed_alternatives: [],
          notice:
            "Pending alternatives exist for this accepted state key. Their values are excluded and are not alice.-verified.",
        },
        relevance: relevanceScore(accepted, taskTerms),
        stableId: accepted.accepted_state_id,
      };
      conflictsByStateKey.set(row.state_key, conflict);
    }
    conflict.item.unreviewed_alternatives.push({
      candidate_id: row.alternative_candidate_id,
      evidence_id: row.alternative_evidence_id,
      evidence_payload_hash: row.alternative_evidence_payload_hash,
      evidence_captured_at: row.alternative_evidence_captured_at,
      review_status: "pending",
    });
  }

  const rankedEntries = [...rankedAccepted, ...conflictsByStateKey.values()].sort(
    compareRankedEntries,
  );
  rankedEntries.push(
    ...fileRows.map((row) => ({
      category: "file_artifacts",
      item: {
        file_reference_id: row.file_reference_id,
        logical_file_id: row.logical_file_id,
        version: Number(row.version),
        display_name: row.display_name,
        media_type: row.media_type,
        byte_size: Number(row.byte_size),
        content_sha256: row.content_sha256,
        context_id: row.context_id,
        context_scope: row.context_id === projectWide.id ? "project_wide" : "selected_context",
        source_host: row.source_host,
        referenced_at: row.referenced_at,
        handling: "reference_only_untrusted",
        text_read_tool:
          fileTextReadAvailable &&
          [
            "application/json",
            "text/csv",
            "text/markdown",
            "text/plain",
            "text/tab-separated-values",
          ].includes(row.media_type)
            ? "read_project_file_text"
            : null,
        pdf_read_tool:
          fileTextReadAvailable && row.media_type === "application/pdf"
            ? "read_project_file_pdf_text"
            : null,
      },
      relevance: normalizedTerms(`${row.display_name} ${row.source_host}`).reduce(
        (score, term) => score + (taskTerms.includes(term) ? 2 : 0),
        0,
      ),
      stableId: row.file_reference_id,
    })),
  );
  rankedEntries.sort(compareRankedEntries);
  const selected = {
    accepted_decisions: [],
    open_questions: [],
    artifacts: [],
    file_artifacts: [],
    unresolved_conflicts: [],
  };
  const acceptedStateAsOf = latestTimestamp(rows.map((row) => row.accepted_at));
  const evidenceAsOf = latestTimestamp([
    ...rows.map((row) => row.evidence_captured_at),
    ...conflictRows.map((row) => row.alternative_evidence_captured_at),
  ]);
  const fileReferenceAsOf = latestTimestamp(fileRows.map((row) => row.referenced_at));
  const freshness = {
    project_updated_at: project.updated_at,
    context_updated_at: context.updated_at,
    accepted_state_as_of: acceptedStateAsOf,
    evidence_as_of: evidenceAsOf,
    file_reference_as_of: fileReferenceAsOf,
    state_as_of:
      latestTimestamp([
        project.updated_at,
        context.updated_at,
        acceptedStateAsOf,
        evidenceAsOf,
        fileReferenceAsOf,
      ]) || project.updated_at,
  };
  const availableCounts = {
    accepted_decisions: rankedAccepted.filter((entry) => entry.category === "accepted_decisions")
      .length,
    open_questions: rankedAccepted.filter((entry) => entry.category === "open_questions").length,
    artifacts: rankedAccepted.filter((entry) => entry.category === "artifacts").length,
    file_artifacts: fileRows.length,
    unresolved_conflicts: conflictsByStateKey.size,
  };

  const placeholderVersion = `context_${"0".repeat(64)}`;
  const emptyContext = buildContext({
    project,
    context,
    task,
    selected,
    freshness,
    contextBudget,
    availableCounts,
    version: placeholderVersion,
  });
  if (emptyContext.package.budget.used > contextBudget) {
    throw new ContextBudgetError(
      "The requested context budget is too small for the required package envelope.",
    );
  }

  for (const entry of rankedEntries) {
    const attempted = {
      ...selected,
      [entry.category]: [...selected[entry.category], entry.item],
    };
    const attemptedContext = buildContext({
      project,
      context,
      task,
      selected: attempted,
      freshness,
      contextBudget,
      availableCounts,
      version: placeholderVersion,
    });
    if (attemptedContext.package.budget.used <= contextBudget) {
      selected[entry.category] = attempted[entry.category];
    }
  }

  const omissions = omissionCounts(availableCounts, selected);
  const sourceInventory = {
    accepted_state: rows.map((row) => ({
      accepted_state_id: row.accepted_state_id,
      state_key: row.state_key,
      value_json: row.value_json,
      version: row.version,
      accepted_at: row.accepted_at,
      candidate_id: row.candidate_id,
      evidence_id: row.evidence_id,
      evidence_payload_hash: row.evidence_payload_hash,
      evidence_captured_at: row.evidence_captured_at,
      context_id: row.context_id,
    })),
    pending_conflict_alternatives: conflictRows.map((row) => ({
      candidate_id: row.alternative_candidate_id,
      evidence_id: row.alternative_evidence_id,
      evidence_payload_hash: row.alternative_evidence_payload_hash,
      evidence_captured_at: row.alternative_evidence_captured_at,
      context_id: row.context_id,
    })),
    file_artifacts: fileRows.map((row) => ({
      file_reference_id: row.file_reference_id,
      logical_file_id: row.logical_file_id,
      version: Number(row.version),
      context_id: row.context_id,
      content_sha256: row.content_sha256,
      referenced_at: row.referenced_at,
    })),
  };
  const packageHash = createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: consumptionContractVersion,
        project,
        context,
        task,
        contextBudget,
        selected,
        freshness,
        omissions,
        sourceInventory,
      }),
    )
    .digest("hex");

  return buildContext({
    project,
    context,
    task,
    selected,
    freshness,
    contextBudget,
    availableCounts,
    version: `context_${packageHash}`,
  });
}
