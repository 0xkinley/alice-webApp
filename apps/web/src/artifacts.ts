import {
  ArtifactDecisionConflictUserError,
  ArtifactLifecycleUserError,
  changeArtifactLifecycle,
  getArtifactDecisionConflictControl,
  getArtifactLifecycleControl,
  getProjectArtifact,
  listArtifactLifecycleReplacements,
  resolveArtifactDecisionConflict,
  searchProjectArtifacts,
} from "@alice/domain";
import type { PrivateFileStore } from "@alice/domain";
import { aliceArtifactCategories, aliceCanonicalTags } from "@alice/schemas";
import express from "express";
import { renderAppPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { escapeHtml, readableLabel, readableText, renderReadableValue } from "./human-readable.ts";
import { hostLabel, localTimestamp } from "./product-copy.ts";
import { getProjectShell, renderProjectShell } from "./project-shell.ts";

const SOURCES = ["chatgpt", "claude"] as const;
const TIMELINES = [
  "past_7_days",
  "past_28_days",
  "past_3_months",
  "past_year",
  "all_time",
] as const;
const LIFECYCLES = ["active", "superseded", "archived", "all"] as const;

function unavailable(response) {
  return response
    .status(404)
    .type("html")
    .send(
      renderStatusPage(
        "Not found",
        '<h1>Artifact unavailable</h1><p>The artifact or project may be unavailable or outside your access.</p><p><a href="/">Return to your private workspace</a></p>',
        "neutral",
      ),
    );
}

function queryValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" && value ? [value] : [];
}

function allowedValues(value: unknown, allowed: readonly string[], maximum: number) {
  const values = queryValues(value);
  if (values.length > maximum || values.some((item) => !allowed.includes(item))) return undefined;
  return [...new Set(values)];
}

function artifactFilters(query) {
  const search = typeof query.q === "string" ? query.q.trim() : "";
  const categories = allowedValues(query.category, aliceArtifactCategories, 10);
  const tags = allowedValues(query.tag, aliceCanonicalTags, 12);
  const sources = allowedValues(query.source, SOURCES, 2);
  const timelines = allowedValues(query.period, TIMELINES, 1);
  const lifecycles = allowedValues(query.lifecycle, LIFECYCLES, 1);
  if (search.length > 300 || !categories || !tags || !sources || !timelines || !lifecycles) {
    return undefined;
  }
  return {
    query: search || undefined,
    categories,
    tags,
    sources,
    artifact_types: [],
    timeline: timelines[0] || "all_time",
    limit: 100,
    lifecycle: (lifecycles[0] || "active") as (typeof LIFECYCLES)[number],
  };
}

function optionList(
  values: readonly string[],
  selectedValues: string[],
  emptyLabel: string,
  label = readableLabel,
): string {
  return `<option value="">${escapeHtml(emptyLabel)}</option>${values
    .map(
      (value) =>
        `<option value="${escapeHtml(value)}"${selectedValues.includes(value) ? " selected" : ""}>${escapeHtml(label(value))}</option>`,
    )
    .join("")}`;
}

function filtersForm(projectId: string, filters): string {
  const timelineLabels = new Map([
    ["all_time", "All time"],
    ["past_7_days", "Past 7 days"],
    ["past_28_days", "Past 28 days"],
    ["past_3_months", "Past 3 months"],
    ["past_year", "Past year"],
  ]);
  const periods = `<option value="">All time periods</option>${TIMELINES.filter(
    (value) => value !== "all_time",
  )
    .map(
      (value) =>
        `<option value="${value}"${filters.timeline === value ? " selected" : ""}>${timelineLabels.get(value)}</option>`,
    )
    .join("")}`;
  const lifecycleLabels = new Map([
    ["active", "Active artifacts"],
    ["superseded", "Superseded artifacts"],
    ["archived", "Archived artifacts"],
    ["all", "All lifecycle states"],
  ]);
  const lifecycles = LIFECYCLES.map(
    (value) =>
      `<option value="${value}"${filters.lifecycle === value ? " selected" : ""}>${lifecycleLabels.get(value)}</option>`,
  ).join("");
  return `<form class="artifact-filters" method="get" action="/projects/${encodeURIComponent(projectId)}/artifacts"><label class="artifact-search">Search artifacts<input type="search" name="q" maxlength="300" value="${escapeHtml(filters.query || "")}" placeholder="Title, goal, summary, or tag"></label><div class="artifact-filter-grid"><label>Category<select name="category">${optionList(aliceArtifactCategories, filters.categories, "All categories")}</select></label><label>Tag<select name="tag">${optionList(aliceCanonicalTags, filters.tags, "All tags")}</select></label><label>Source AI<select name="source">${optionList(SOURCES, filters.sources, "All source AIs", hostLabel)}</select></label><label>Time period<select name="period">${periods}</select></label><label>Lifecycle<select name="lifecycle">${lifecycles}</select></label></div><div class="actions"><button type="submit">Search and filter</button><a href="/projects/${encodeURIComponent(projectId)}/artifacts">Clear filters</a></div></form>`;
}

function artifactCards(projectId: string, artifacts): string {
  if (artifacts.length === 0) {
    return '<div class="empty-state"><h2>No artifacts found</h2><p>Try different filters, or save a full artifact from a connected AI tool.</p></div>';
  }
  return `<div class="artifact-grid">${artifacts
    .map((artifact) => {
      const tags = artifact.tags
        .map((tag) => `<span class="badge">${escapeHtml(readableLabel(tag))}</span>`)
        .join("");
      const titleWarning =
        artifact.title_version_integrity?.status === "conflicting_label"
          ? `<p class="notice warning"><strong>Title/version mismatch.</strong> ${escapeHtml(artifact.title_version_integrity.notice)}</p>`
          : "";
      const authority =
        artifact.authority === "IMPORTED_UNVERIFIED"
          ? '<span class="badge">Imported · Unverified</span>'
          : `<span>Alice version ${artifact.current_version}</span>`;
      return `<article class="artifact-card"><div class="artifact-card-meta"><span>${escapeHtml(readableLabel(artifact.artifact_type))}</span><span>${escapeHtml(readableLabel(artifact.category))}</span>${authority}<span>${escapeHtml(readableLabel(artifact.lifecycle.state))}</span></div><h2><a class="artifact-link" href="/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}">${escapeHtml(artifact.title)}</a></h2>${titleWarning}${artifact.summary ? `<p>${escapeHtml(readableText(artifact.summary))}</p>` : `<p>${escapeHtml(readableText(artifact.goal))}</p>`}<div class="artifact-tags">${tags}</div><p class="artifact-card-source">From ${escapeHtml(hostLabel(artifact.source))} · ${localTimestamp(artifact.saved_at)}</p></article>`;
    })
    .join("")}</div>`;
}

function handoffList(title: string, items): string {
  const content = items.length
    ? `<ul>${items.map((item) => `<li>${escapeHtml(readableText(item))}</li>`).join("")}</ul>`
    : '<p class="muted">None saved for this version.</p>';
  return `<section class="handoff-section"><h3>${escapeHtml(title)}</h3>${content}</section>`;
}

function rejectedDirections(items): string {
  const content = items.length
    ? `<ul>${items
        .map(
          (item) =>
            `<li><strong>${escapeHtml(readableText(item.direction))}</strong><span>${escapeHtml(readableText(item.reason))}</span></li>`,
        )
        .join("")}</ul>`
    : '<p class="muted">None saved for this version.</p>';
  return `<section class="handoff-section"><h3>Rejected directions</h3>${content}</section>`;
}

function decisionRecords(items): string {
  const content = items.length
    ? `<dl>${items.map((item) => `<dt>${escapeHtml(item.decision_key)}</dt><dd><div class="readable-value">${renderReadableValue(item.value)}</div></dd>`).join("")}</dl>`
    : '<p class="muted">None saved for this version.</p>';
  return `<section class="handoff-section"><h3>Structured decision records</h3>${content}</section>`;
}

function decisionConflicts(projectId: string, conflicts, canResolve: boolean): string {
  if (!conflicts?.length) return "";
  const project = encodeURIComponent(projectId);
  return `<section><div class="section-heading"><div><p class="eyebrow">Deterministic comparison</p><h2>Decision conflicts</h2></div></div><p>Alice found different exact values under the same explicit decision key. It does not infer contradictions from prose or decide which value is correct. Host-generated content and a human selection are not Alice verification.</p>${conflicts
    .map((conflict) => {
      const records = conflict.records
        .map(
          (record) =>
            `<li><strong>${escapeHtml(record.title)}</strong> · Alice version ${record.alice_version} · ${escapeHtml(hostLabel(record.source))} · ${localTimestamp(record.saved_at)}<div class="readable-value">${renderReadableValue(record.value)}</div></li>`,
        )
        .join("");
      const resolution = conflict.resolution
        ? `<p class="notice warning"><strong>Human selection recorded.</strong> The selected exact value is shown below. Source artifacts still disagree, and this selection is not Alice verification.</p><div class="readable-value">${renderReadableValue(conflict.resolution.selected_value)}</div>`
        : '<p class="notice danger"><strong>Unresolved.</strong> Review the exact current source records.</p>';
      const action =
        canResolve && conflict.status === "unresolved"
          ? `<form method="post" action="/projects/${project}/artifact-decision-conflicts/${encodeURIComponent(conflict.conflict_fingerprint)}/resolve"><fieldset><legend>Select one exact current record</legend>${conflict.records
              .map(
                (record, index) =>
                  `<label class="select-row"><input type="radio" name="selected_version_id" value="${escapeHtml(record.version_id)}"${index === 0 ? " checked" : ""}><span>${escapeHtml(record.title)} · Alice version ${record.alice_version}</span></label>`,
              )
              .join("")}</fieldset><button type="submit">Record human selection</button></form>`
          : "";
      return `<article class="artifact-card"><p class="eyebrow">${escapeHtml(conflict.decision_key)}</p>${resolution}<ul>${records}</ul><p class="muted">${escapeHtml(conflict.limitation)}</p>${action}</article>`;
    })
    .join("")}</section>`;
}

function lifecycleControls(projectId: string, artifact, control, replacements): string {
  const project = encodeURIComponent(projectId);
  const id = encodeURIComponent(artifact.id);
  const expected = control ? Number(control.version) : 0;
  const replacementOptions = (replacements || [])
    .map(
      (item) =>
        `<option value="${escapeHtml(item.artifact_id)}">${escapeHtml(item.title)} · Alice version ${item.current_version}</option>`,
    )
    .join("");
  const humanControls = !control
    ? ""
    : control.state === "active"
      ? `<section><h3>Artifact lifecycle</h3><p>Only this authenticated Alice action can change lifecycle. AI tools may suggest a duplicate or obsolete artifact but cannot apply this change.</p><div class="actions"><form method="post" action="/projects/${project}/artifacts/${id}/lifecycle"><input type="hidden" name="action" value="archive"><input type="hidden" name="expected_version" value="${expected}"><button type="submit">Archive artifact</button></form></div>${replacementOptions ? `<form method="post" action="/projects/${project}/artifacts/${id}/lifecycle"><input type="hidden" name="action" value="supersede"><input type="hidden" name="expected_version" value="${expected}"><label>Canonical replacement<select name="replacement_artifact_id" required><option value="">Choose an active artifact</option>${replacementOptions}</select></label><button type="submit">Mark superseded</button></form>` : ""}</section>`
      : `<section><h3>Artifact lifecycle</h3><p>Only this authenticated Alice action can restore the artifact to active use.</p><form method="post" action="/projects/${project}/artifacts/${id}/lifecycle"><input type="hidden" name="action" value="restore"><input type="hidden" name="expected_version" value="${expected}"><button type="submit">Restore artifact</button></form></section>`;
  return humanControls;
}

function artifactDetail(projectId: string, result, control, replacements, canResolve): string {
  const artifact = result.artifact;
  const selectedIsCurrent = artifact.selected_version === artifact.current_version;
  const tags = artifact.tags
    .map((tag) => `<span class="badge">${escapeHtml(readableLabel(tag))}</span>`)
    .join("");
  const history = artifact.history
    .map((version) => {
      const selected = version.version === artifact.selected_version;
      const current = version.version === artifact.current_version;
      return `<li><a href="/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.id)}?version=${version.version}"${selected ? ' aria-current="page"' : ""}><span>Version ${version.version}${current ? " · Current" : ""}</span><span>From ${escapeHtml(hostLabel(version.source))} · ${localTimestamp(version.saved_at)}</span></a></li>`;
    })
    .join("");
  const olderNotice = selectedIsCurrent
    ? ""
    : `<p class="notice warning"><strong>You are viewing version ${artifact.selected_version}.</strong> <a href="/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.id)}">Return to current version ${artifact.current_version}</a>.</p>`;
  const heading = selectedIsCurrent
    ? "Current content"
    : `Version ${artifact.selected_version} content`;
  const titleWarning = artifact.title_version_integrity?.notice
    ? `<p class="notice ${artifact.title_version_integrity.status === "conflicting_label" ? "danger" : "warning"}"><strong>Stored title label.</strong> ${escapeHtml(artifact.title_version_integrity.notice)}</p>`
    : "";
  const lifecycleNotice =
    artifact.lifecycle.state === "superseded" && artifact.lifecycle.replacement
      ? `<p class="notice warning"><strong>Superseded.</strong> Continue with <a href="/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.lifecycle.replacement.artifact_id)}">${escapeHtml(artifact.lifecycle.replacement.title || "the canonical replacement")}</a>, Alice version ${artifact.lifecycle.replacement.current_version}.</p>`
      : artifact.lifecycle.state === "archived"
        ? '<p class="notice warning"><strong>Archived.</strong> This artifact remains in immutable history but is excluded from default search and cannot receive versions.</p>'
        : "";
  const authorityNotice =
    artifact.authority === "IMPORTED_UNVERIFIED"
      ? '<p class="notice warning"><strong>Imported · Unverified.</strong> Alice received this complete content during migration and preserved it as an artifact. It is source evidence, not accepted project information.</p>'
      : '<p class="notice warning"><strong>Saved after human confirmation, not verified by alice.</strong> The source AI generated this content. Saving the exact snapshot preserves it and its provenance; it does not verify its claims.</p>';
  return `<section class="artifact-detail"><p><a href="/projects/${encodeURIComponent(projectId)}/artifacts">← All artifacts</a></p><div class="section-heading"><div><p class="eyebrow">${selectedIsCurrent ? "Current artifact" : "Earlier artifact version"}</p><h2>${escapeHtml(artifact.title)}</h2></div><span class="badge">${artifact.authority === "IMPORTED_UNVERIFIED" ? "Imported · Unverified" : `Alice version ${artifact.selected_version} of ${artifact.current_version}`}</span></div>${titleWarning}${lifecycleNotice}<div class="artifact-card-meta"><span>${escapeHtml(readableLabel(artifact.artifact_type))}</span><span>${escapeHtml(readableLabel(artifact.category))}</span><span>${escapeHtml(readableLabel(artifact.lifecycle.state))}</span><span>From ${escapeHtml(hostLabel(artifact.source))}</span><span>${localTimestamp(artifact.saved_at)}</span></div><div class="artifact-tags">${tags}</div>${authorityNotice}${olderNotice}<section class="artifact-content"><h3>${heading}</h3><div class="artifact-body">${escapeHtml(artifact.content)}</div></section><section><div class="section-heading"><div><p class="eyebrow">Handoff information</p><h2>Continue this work</h2></div></div><dl><dt>Goal</dt><dd>${escapeHtml(readableText(artifact.handoff.goal))}</dd><dt>Summary</dt><dd>${artifact.handoff.summary ? escapeHtml(readableText(artifact.handoff.summary)) : '<span class="muted">None saved for this version.</span>'}</dd></dl><div class="handoff-grid">${handoffList("Decisions", artifact.handoff.decisions)}${decisionRecords(artifact.handoff.decision_records)}${handoffList("Constraints", artifact.handoff.constraints)}${rejectedDirections(artifact.handoff.rejected_directions)}${handoffList("Open questions", artifact.handoff.open_questions)}${handoffList("Next steps", artifact.handoff.next_steps)}${handoffList("Relevant context", artifact.handoff.relevant_context)}</div></section>${decisionConflicts(projectId, artifact.decision_conflicts, canResolve)}<section><div class="section-heading"><div><p class="eyebrow">Immutable lineage</p><h2>Version history</h2></div></div><ol class="artifact-history">${history}</ol></section>${lifecycleControls(projectId, artifact, control, replacements)}</section>`;
}

export function createArtifactsRouter({
  database,
  fileStore,
}: {
  database: unknown;
  fileStore?: PrivateFileStore | undefined;
}) {
  const router = express.Router();
  const authenticated = requireAuthenticatedUser(database);

  router.get("/:projectId/artifacts", authenticated, async (request, response) => {
    const filters = artifactFilters(request.query);
    if (!filters) {
      return response
        .status(400)
        .type("html")
        .send(
          renderStatusPage(
            "Invalid artifact filters",
            "<h1>Invalid artifact filters</h1><p>Choose filters shown in the artifact browser.</p><p>No project or artifact data changed.</p>",
            "neutral",
          ),
        );
    }
    const view = await searchProjectArtifacts(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      ...filters,
      include_unverified_imports: true,
    });
    if (!view) return unavailable(response);
    const conflictControl = await getArtifactDecisionConflictControl(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
    });
    const shell = await getProjectShell(database, request.aliceUser!.id, request.params.projectId);
    if (!shell) return unavailable(response);
    response
      .set("Cache-Control", "no-store")
      .type("html")
      .send(
        renderAppPage(
          `Artifacts · ${view.project.name}`,
          `<div class="project-home">${renderProjectShell({ shell, fileStore, activeTab: "artifacts" })}<section><div class="section-heading"><div><p class="eyebrow">Saved work products</p><h2>Artifacts</h2></div><p class="muted">${view.results.length} ${view.results.length === 1 ? "result" : "results"}</p></div><p>Artifacts are complete text snapshots saved from connected AI tools. Uploaded files remain in the separate Files tab.</p>${filtersForm(view.project.id, filters)}${artifactCards(view.project.id, view.results)}</section>${decisionConflicts(view.project.id, view.decision_conflicts, Boolean(conflictControl))}</div>`,
          { email: request.aliceUser!.email, activeSection: "projects" },
        ),
      );
  });

  router.get("/:projectId/artifacts/:artifactId", authenticated, async (request, response) => {
    const rawVersion = request.query.version;
    const version =
      rawVersion === undefined
        ? undefined
        : typeof rawVersion === "string" && /^[1-9]\d*$/.test(rawVersion)
          ? Number(rawVersion)
          : Number.NaN;
    if (version !== undefined && (!Number.isSafeInteger(version) || version <= 0)) {
      return unavailable(response);
    }
    const result = await getProjectArtifact(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      artifactId: request.params.artifactId,
      ...(version === undefined ? {} : { version }),
      includeHistory: true,
    });
    if (!result) return unavailable(response);
    const control = await getArtifactLifecycleControl(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
      artifactId: request.params.artifactId,
    });
    const replacements = control
      ? await listArtifactLifecycleReplacements(database, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          artifactId: request.params.artifactId,
        })
      : undefined;
    const conflictControl = await getArtifactDecisionConflictControl(database, {
      userId: request.aliceUser!.id,
      projectId: request.params.projectId,
    });
    const shell = await getProjectShell(database, request.aliceUser!.id, request.params.projectId);
    if (!shell) return unavailable(response);
    response
      .set("Cache-Control", "no-store")
      .type("html")
      .send(
        renderAppPage(
          `${result.artifact.title} · ${result.project.name}`,
          `<div class="project-home">${renderProjectShell({ shell, fileStore, activeTab: "artifacts" })}${artifactDetail(result.project.id, result, control, replacements, Boolean(conflictControl))}</div>`,
          { email: request.aliceUser!.email, activeSection: "projects" },
        ),
      );
  });

  router.post(
    "/:projectId/artifact-decision-conflicts/:fingerprint/resolve",
    authenticated,
    async (request, response) => {
      const fingerprint = String(request.params.fingerprint || "");
      const selectedVersionId = String(request.body.selected_version_id || "");
      if (
        !/^[0-9a-f]{64}$/.test(fingerprint) ||
        !/^[A-Za-z0-9._:-]{1,240}$/.test(selectedVersionId)
      ) {
        return unavailable(response);
      }
      try {
        const resolved = await resolveArtifactDecisionConflict(database, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          conflictFingerprint: fingerprint,
          selectedVersionId,
        });
        if (!resolved) return unavailable(response);
        response.redirect(
          303,
          `/projects/${encodeURIComponent(request.params.projectId)}/artifacts`,
        );
      } catch (error) {
        if (!(error instanceof ArtifactDecisionConflictUserError)) throw error;
        response
          .status(409)
          .set("Cache-Control", "no-store")
          .type("html")
          .send(
            renderStatusPage(
              "Decision resolution unchanged",
              `<h1>Decision resolution unchanged</h1><p>${escapeHtml(error.message)}</p><p>No artifact, version, source value, or prior resolution was changed.</p>`,
              "danger",
            ),
          );
      }
    },
  );

  router.post(
    "/:projectId/artifacts/:artifactId/lifecycle",
    authenticated,
    async (request, response) => {
      const action = String(request.body.action || "");
      const expectedVersion = Number(request.body.expected_version);
      if (
        !["archive", "restore", "supersede"].includes(action) ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0
      ) {
        return unavailable(response);
      }
      try {
        const changed = await changeArtifactLifecycle(database, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          artifactId: request.params.artifactId,
          action: action as "archive" | "restore" | "supersede",
          expectedVersion,
          ...(action === "supersede"
            ? { replacementArtifactId: String(request.body.replacement_artifact_id || "") }
            : {}),
        });
        if (!changed) return unavailable(response);
        response.redirect(
          303,
          `/projects/${encodeURIComponent(request.params.projectId)}/artifacts/${encodeURIComponent(request.params.artifactId)}`,
        );
      } catch (error) {
        if (!(error instanceof ArtifactLifecycleUserError)) throw error;
        response
          .status(409)
          .set("Cache-Control", "no-store")
          .type("html")
          .send(
            renderStatusPage(
              "Artifact lifecycle unchanged",
              `<h1>Artifact lifecycle unchanged</h1><p>${escapeHtml(error.message)}</p><p>No artifact, version, or lifecycle history was changed.</p>`,
              "danger",
            ),
          );
      }
    },
  );

  return router;
}
