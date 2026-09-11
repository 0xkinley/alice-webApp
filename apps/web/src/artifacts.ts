import { getProjectArtifact, searchProjectArtifacts } from "@alice/domain";
import type { PrivateFileStore } from "@alice/domain";
import { aliceArtifactCategories, aliceCanonicalTags } from "@alice/schemas";
import express from "express";
import { renderAppPage, renderStatusPage, requireAuthenticatedUser } from "./auth.ts";
import { escapeHtml, readableLabel, readableText } from "./human-readable.ts";
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
  if (search.length > 300 || !categories || !tags || !sources || !timelines) {
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
  return `<form class="artifact-filters" method="get" action="/projects/${encodeURIComponent(projectId)}/artifacts"><label class="artifact-search">Search artifacts<input type="search" name="q" maxlength="300" value="${escapeHtml(filters.query || "")}" placeholder="Title, goal, summary, or tag"></label><div class="artifact-filter-grid"><label>Category<select name="category">${optionList(aliceArtifactCategories, filters.categories, "All categories")}</select></label><label>Tag<select name="tag">${optionList(aliceCanonicalTags, filters.tags, "All tags")}</select></label><label>Source AI<select name="source">${optionList(SOURCES, filters.sources, "All source AIs", hostLabel)}</select></label><label>Time period<select name="period">${periods}</select></label></div><div class="actions"><button type="submit">Search and filter</button><a href="/projects/${encodeURIComponent(projectId)}/artifacts">Clear filters</a></div></form>`;
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
      return `<article class="artifact-card"><div class="artifact-card-meta"><span>${escapeHtml(readableLabel(artifact.artifact_type))}</span><span>${escapeHtml(readableLabel(artifact.category))}</span><span>Version ${artifact.current_version}</span></div><h2><a class="artifact-link" href="/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}">${escapeHtml(artifact.title)}</a></h2>${artifact.summary ? `<p>${escapeHtml(readableText(artifact.summary))}</p>` : `<p>${escapeHtml(readableText(artifact.goal))}</p>`}<div class="artifact-tags">${tags}</div><p class="artifact-card-source">From ${escapeHtml(hostLabel(artifact.source))} · ${localTimestamp(artifact.saved_at)}</p></article>`;
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

function artifactDetail(projectId: string, result): string {
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
  return `<section class="artifact-detail"><p><a href="/projects/${encodeURIComponent(projectId)}/artifacts">← All artifacts</a></p><div class="section-heading"><div><p class="eyebrow">${selectedIsCurrent ? "Current artifact" : "Earlier artifact version"}</p><h2>${escapeHtml(artifact.title)}</h2></div><span class="badge">Version ${artifact.selected_version} of ${artifact.current_version}</span></div><div class="artifact-card-meta"><span>${escapeHtml(readableLabel(artifact.artifact_type))}</span><span>${escapeHtml(readableLabel(artifact.category))}</span><span>From ${escapeHtml(hostLabel(artifact.source))}</span><span>${localTimestamp(artifact.saved_at)}</span></div><div class="artifact-tags">${tags}</div><p class="notice warning"><strong>Saved after human confirmation, not verified by alice.</strong> The source AI generated this content. Saving the exact snapshot preserves it and its provenance; it does not verify its claims.</p>${olderNotice}<section class="artifact-content"><h3>${heading}</h3><div class="artifact-body">${escapeHtml(artifact.content)}</div></section><section><div class="section-heading"><div><p class="eyebrow">Handoff information</p><h2>Continue this work</h2></div></div><dl><dt>Goal</dt><dd>${escapeHtml(readableText(artifact.handoff.goal))}</dd><dt>Summary</dt><dd>${artifact.handoff.summary ? escapeHtml(readableText(artifact.handoff.summary)) : '<span class="muted">None saved for this version.</span>'}</dd></dl><div class="handoff-grid">${handoffList("Decisions", artifact.handoff.decisions)}${handoffList("Constraints", artifact.handoff.constraints)}${rejectedDirections(artifact.handoff.rejected_directions)}${handoffList("Open questions", artifact.handoff.open_questions)}${handoffList("Next steps", artifact.handoff.next_steps)}${handoffList("Relevant context", artifact.handoff.relevant_context)}</div></section><section><div class="section-heading"><div><p class="eyebrow">Immutable lineage</p><h2>Version history</h2></div></div><ol class="artifact-history">${history}</ol></section></section>`;
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
    });
    if (!view) return unavailable(response);
    const shell = await getProjectShell(database, request.aliceUser!.id, request.params.projectId);
    if (!shell) return unavailable(response);
    response
      .set("Cache-Control", "no-store")
      .type("html")
      .send(
        renderAppPage(
          `Artifacts · ${view.project.name}`,
          `<div class="project-home">${renderProjectShell({ shell, fileStore, activeTab: "artifacts" })}<section><div class="section-heading"><div><p class="eyebrow">Saved work products</p><h2>Artifacts</h2></div><p class="muted">${view.results.length} ${view.results.length === 1 ? "result" : "results"}</p></div><p>Artifacts are complete text snapshots saved from connected AI tools. Uploaded files remain in the separate Files tab.</p>${filtersForm(view.project.id, filters)}${artifactCards(view.project.id, view.results)}</section></div>`,
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
    const shell = await getProjectShell(database, request.aliceUser!.id, request.params.projectId);
    if (!shell) return unavailable(response);
    response
      .set("Cache-Control", "no-store")
      .type("html")
      .send(
        renderAppPage(
          `${result.artifact.title} · ${result.project.name}`,
          `<div class="project-home">${renderProjectShell({ shell, fileStore, activeTab: "artifacts" })}${artifactDetail(result.project.id, result)}</div>`,
          { email: request.aliceUser!.email, activeSection: "projects" },
        ),
      );
  });

  return router;
}
