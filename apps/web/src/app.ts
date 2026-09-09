import express from "express";
import { openDatabase } from "@alice/database";
import {
  ContextBudgetError,
  createProject,
  createWorkContext,
  getReviewQueue,
  getProjectContext,
  getPrivateAlphaSignals,
  listArchivedProjects,
  listSharedProjects,
  listProjects,
  listWorkContexts,
  suggestSimilarWorkContexts,
} from "@alice/domain";
import { getProjectContextSchema } from "@alice/schemas";
import {
  createAuthRouter,
  renderAppPage,
  renderPage,
  renderStatusPage,
  requireAuthenticatedUser,
} from "./auth.ts";
import { createConnectionsRouter } from "./connections.ts";
import { createCaptureSavePreviewsRouter } from "./capture-save-previews.ts";
import { createContextAccessRouter } from "./context-access.ts";
import { privateAlphaPrivacySecurityBody } from "./disclosures.ts";
import { createFilesRouter } from "./files.ts";
import { createHostFileSaveOffersRouter } from "./host-file-save-offers.ts";
import { createProjectLifecycleRouter } from "./project-lifecycle.ts";
import { createProjectMembershipRouter } from "./project-memberships.ts";
import { privateAlphaAboutBody } from "./public-site.ts";
import { createReviewRouter } from "./review.ts";
import { createSavedContextRouter } from "./saved-context.ts";
import { accessLabel, roleLabel, timestampLabel } from "./product-copy.ts";
import { getProjectShell, renderProjectShell } from "./project-shell.ts";
import type { PrivateFileStore } from "@alice/domain";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const PROJECT_FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.csv,.tsv,.json,.docx,.xlsx,.pptx";

function projectCreationFileScript({ directUpload }: { directUpload: boolean }): string {
  return `<script>
(()=>{const form=document.querySelector(".create-project-form"),picker=document.getElementById("project-files"),add=document.getElementById("add-project-files"),selection=document.getElementById("project-file-selection"),status=document.getElementById("project-create-status");if(!form||!picker||!add||!selection||!status)return;const buttons=Array.from(form.querySelectorAll("button"));let createdProject=null;const announce=message=>{status.textContent=message};const fail=message=>{buttons.forEach(button=>button.disabled=false);status.textContent="";if(createdProject){status.append("The project was created, but the file upload did not finish. ");const link=document.createElement("a");link.href="/projects/"+encodeURIComponent(createdProject.project_id);link.textContent="Open the project";status.append(link,".")}else status.textContent=message||"The project could not be created."};const sha256=async file=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer()))).map(byte=>byte.toString(16).padStart(2,"0")).join("");const uploadLegacy=async(file,created)=>{const response=await fetch("/projects/"+encodeURIComponent(created.project_id)+"/files?context_id="+encodeURIComponent(created.context_id),{method:"POST",headers:{"Content-Type":file.type||"application/octet-stream","X-Alice-File-Name":encodeURIComponent(file.name)},body:file});if(!response.ok)throw new Error(await response.text())};const putDirect=(file,intent)=>new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open("PUT",intent.upload_url);for(const [name,value] of Object.entries(intent.upload_headers))xhr.setRequestHeader(name,value);xhr.onerror=()=>reject(new Error("The private storage upload failed."));xhr.onload=()=>{if(xhr.status<200||xhr.status>=300)return reject(new Error("The private storage upload failed."));const versionId=xhr.getResponseHeader("x-amz-version-id");if(!versionId)return reject(new Error("Private storage did not expose the immutable object version."));resolve(versionId)};xhr.send(file)});const uploadDirect=async(file,created)=>{const digest=await sha256(file),intentResponse=await fetch("/projects/"+encodeURIComponent(created.project_id)+"/files/direct/intents",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({context_id:created.context_id,file_name:file.name,claimed_media_type:file.type||"application/octet-stream",byte_size:file.size,sha256:digest})});if(!intentResponse.ok)throw new Error(await intentResponse.text());const intent=await intentResponse.json(),versionId=await putDirect(file,intent);for(;;){const response=await fetch("/projects/"+encodeURIComponent(created.project_id)+"/files/direct/intents/"+encodeURIComponent(intent.intent_id)+"/finalize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({storage_version_id:versionId})});if(response.status===202){await new Promise(resolve=>setTimeout(resolve,3000));continue}if(!response.ok)throw new Error(await response.text());return}};add.addEventListener("click",()=>picker.click());picker.addEventListener("change",()=>{const files=Array.from(picker.files||[]);selection.textContent=files.length===0?"":files.length===1?files[0].name:files.length+" files selected"});form.addEventListener("submit",async event=>{const files=Array.from(picker.files||[]);if(files.length===0)return;event.preventDefault();buttons.forEach(button=>button.disabled=true);announce("Creating project…");try{const response=await fetch("/projects",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json"},body:new URLSearchParams({name:String(new FormData(form).get("name")||""),response_mode:"inline_file_upload"})});if(!response.ok)throw new Error(await response.text());createdProject=await response.json();for(let index=0;index<files.length;index+=1){announce("Uploading "+(index+1)+" of "+files.length+"…");${directUpload ? "await uploadDirect(files[index],createdProject)" : "await uploadLegacy(files[index],createdProject)"}}announce("Files received. Opening project…");location.href="/projects/"+encodeURIComponent(createdProject.project_id)}catch(error){fail(error instanceof Error?error.message:String(error))}})})();
</script>`;
}

function projectCreationForm(fileStore?: PrivateFileStore): string {
  const fileControls = fileStore
    ? `<button id="add-project-files" class="secondary" type="button" aria-controls="project-files" aria-haspopup="dialog">Add files</button><input id="project-files" type="file" accept="${PROJECT_FILE_ACCEPT}" multiple hidden tabindex="-1" aria-hidden="true"><span id="project-file-selection" class="file-selection" role="status"></span>`
    : "";
  return `<form class="create-project-form" method="post" action="/projects"><label>Project name<input name="name" maxlength="120" required></label><div class="actions">${fileControls}<button type="submit">Create project</button></div><p id="project-create-status" role="status"></p></form>${fileStore ? projectCreationFileScript({ directUpload: Boolean(fileStore.createSignedUpload) }) : ""}`;
}

export async function createApp({
  database: suppliedDatabase = undefined,
  databaseUrl,
  publicUrl,
  mcpPublicUrl = publicUrl,
  fileStore = undefined as PrivateFileStore | undefined,
}) {
  const database = suppliedDatabase || (await openDatabase({ connectionString: databaseUrl }));
  const app = express();

  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.get("/health", async (_request, response) => {
    try {
      await database.query("SELECT 1");
      response.json({ database: "reachable", service: "alice-web", status: "ok" });
    } catch {
      response.status(503).json({ database: "unreachable", service: "alice-web", status: "error" });
    }
  });
  app.get("/privacy-security", (_request, response) => {
    response
      .type("html")
      .set("Cache-Control", "no-store")
      .send(renderPage("Private alpha privacy and security", privateAlphaPrivacySecurityBody));
  });
  app.get("/about", (_request, response) => {
    response
      .type("html")
      .set("Cache-Control", "no-store")
      .send(renderPage("Project intelligence for the AI tools you choose", privateAlphaAboutBody));
  });
  app.use("/auth", createAuthRouter({ database, publicUrl }));
  app.use("/connections", createConnectionsRouter({ database, mcpPublicUrl }));
  app.use(createProjectMembershipRouter({ database, publicUrl, fileStore }));
  app.use(createProjectLifecycleRouter({ database }));
  app.use("/projects", createContextAccessRouter({ database }));
  app.get("/shared", requireAuthenticatedUser(database), async (request, response) => {
    const sharedProjects = await listSharedProjects(database, request.aliceUser!.id);
    const sharedProjectList = sharedProjects
      .map(
        (project) =>
          `<article class="project-card"><p class="eyebrow">Shared project</p><h2><a class="project-link" href="/projects/${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a></h2><p class="project-meta">Your access · ${escapeHtml(roleLabel(project.role))}</p></article>`,
      )
      .join("");
    const body = `<div class="workspace-home"><header class="workspace-toolbar"><div><p class="eyebrow">Private workspace</p><h1>Shared with You</h1><p>Projects another owner has invited you to appear here.</p></div></header><section class="project-section"><div class="section-heading"><h2>Shared projects</h2><p class="muted">${sharedProjects.length} available</p></div>${
      sharedProjectList
        ? `<div class="project-grid">${sharedProjectList}</div>`
        : '<div class="empty-state"><h2>No projects shared with you</h2><p>When another project owner gives you access, the project will appear here.</p></div>'
    }</section></div>`;
    response.type("html").send(
      renderAppPage("Shared with You", body, {
        email: request.aliceUser!.email,
        activeSection: "shared",
      }),
    );
  });
  app.get("/archived", requireAuthenticatedUser(database), async (request, response) => {
    const archivedProjects = await listArchivedProjects(database, request.aliceUser!.id);
    const archivedProjectList = archivedProjects
      .map(
        (project) =>
          `<article class="project-card"><p class="eyebrow">Archived</p><h2><a class="project-link" href="/projects/${encodeURIComponent(project.id)}/archive">${escapeHtml(project.name)}</a></h2><p class="project-meta">Archived ${escapeHtml(timestampLabel(project.archived_at))}</p></article>`,
      )
      .join("");
    const body = `<div class="workspace-home"><header class="workspace-toolbar"><div><p class="eyebrow">Private workspace</p><h1>Archived Projects</h1><p>Archived projects stay available for restore or export.</p></div></header><section class="project-section"><div class="section-heading"><h2>Archived projects</h2><p class="muted">${archivedProjects.length} retained</p></div>${
      archivedProjectList
        ? `<div class="project-grid">${archivedProjectList}</div>`
        : '<div class="empty-state"><h2>No archived projects</h2><p>Projects you archive will appear here.</p></div>'
    }</section></div>`;
    response.type("html").send(
      renderAppPage("Archived Projects", body, {
        email: request.aliceUser!.email,
        activeSection: "archived",
      }),
    );
  });
  app.get("/", requireAuthenticatedUser(database), async (request, response) => {
    const projects = await listProjects(database, request.aliceUser!.id);
    const sharedProjects = await listSharedProjects(database, request.aliceUser!.id);
    const sharedProjectIds = new Set(sharedProjects.map(({ id }) => id));
    const ownedProjects = projects.filter(({ id }) => !sharedProjectIds.has(id));
    const projectList = ownedProjects
      .map(
        (project) =>
          `<article class="project-card"><p class="eyebrow">Your project</p><h2><a class="project-link" href="/projects/${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a></h2><p class="project-meta">Updated ${escapeHtml(timestampLabel(project.updated_at))}</p></article>`,
      )
      .join("");
    const sharedProjectList = sharedProjects
      .map(
        (project) =>
          `<article class="project-card"><p class="eyebrow">Shared project</p><h2><a class="project-link" href="/projects/${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a></h2><p class="project-meta">Your access · ${escapeHtml(roleLabel(project.role))}</p></article>`,
      )
      .join("");
    const projectForm = projectCreationForm(fileStore);
    const createProjectControl = `<details class="create-project" id="create-project"><summary>New project</summary>${projectForm}</details>`;
    const hasAnyProject = projects.length > 0;
    const ownedSection = ownedProjects.length
      ? `<section class="project-section"><div class="section-heading"><h2>Your Projects</h2><p class="muted">${ownedProjects.length} available</p></div><div class="project-grid">${projectList}</div></section>`
      : "";
    const sharedSection = sharedProjects.length
      ? `<section class="project-section"><div class="section-heading"><h2>Shared with You</h2><p class="muted">${sharedProjects.length} available</p></div><div class="project-grid">${sharedProjectList}</div></section>`
      : "";
    const workspaceBody = `<div class="workspace-home"><header class="workspace-toolbar"><div><p class="eyebrow">Private workspace</p><h1>Your projects</h1><p>Create a project, add files, connect the AI tools you trust, and approve anything saved back to it.</p></div>${hasAnyProject ? createProjectControl : ""}</header>${
      hasAnyProject
        ? `${ownedSection}${sharedSection}`
        : `<section class="workspace-empty"><div><p class="eyebrow">Start here</p><h2>Create your first project</h2><p>Give your work one clear home. Files, AI connections, and anything you choose to save will stay attached to the project.</p>${projectForm}</div></section>`
    }</div>`;
    response.type("html").send(
      renderAppPage("alice. private workspace", workspaceBody, {
        email: request.aliceUser!.email,
        activeSection: "projects",
      }),
    );
  });
  app.get("/signals", requireAuthenticatedUser(database), async (request, response) => {
    const signals = await getPrivateAlphaSignals(database, request.aliceUser!.id);
    if (!signals) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Not found",
            '<h1>Signals not found</h1><p><a href="/">Return to your private workspace</a></p>',
            "neutral",
          ),
        );
    }
    const percentage = (value) => (value === null ? "Not enough data" : `${value}%`);
    const duration = (value) => (value === null ? "Not enough data" : `${value} seconds`);
    response
      .type("html")
      .send(
        renderAppPage(
          "Private alpha signals",
          `<div class="workspace-home"><header class="workspace-toolbar"><div><p class="eyebrow">Private alpha</p><h1>Usage signals</h1><p>These aggregate signals use identifiers, status, counts, and timestamps. They do not inspect prompts, model responses, proposed values, evidence payloads, or saved project content.</p></div></header><section><h2>Project retrieval</h2><dl><dt>Observed MCP read attempts</dt><dd>${signals.consumption.observed_attempts}</dd><dt>Successful package reads</dt><dd>${signals.consumption.successful_reads}</dd><dt>Failed package reads</dt><dd>${signals.consumption.failed_reads}</dd><dt>Success among observed attempts</dt><dd>${percentage(signals.consumption.success_rate_percent)}</dd><dt>Successful AI classifications</dt><dd>${signals.consumption.successful_host_surfaces}</dd><dt>Projects reused across AI tools within 7 days</dt><dd>${signals.consumption.projects_reused_across_hosts_within_7_days}</dd><dt>UTC weeks with a successful read</dt><dd>${signals.consumption.active_utc_weeks}</dd><dt>Repeated weekly use</dt><dd>${signals.consumption.repeated_weekly_use ? "Observed" : "Not yet observed"}</dd></dl><p class="muted"><strong>Important limitation:</strong> ${escapeHtml(signals.privacy.limitation)} Therefore this page does not call the observed-attempt success percentage a host invocation rate.</p></section><section><h2>Retained save outcomes</h2><dl><dt>Retained captures</dt><dd>${signals.saving.offers}</dd><dt>Entries in retained captures</dt><dd>${signals.saving.proposals}</dd><dt>Accepted captures</dt><dd>${signals.saving.confirmed_offers}</dd><dt>Historical rejected captures</dt><dd>${signals.saving.cancelled_offers}</dd><dt>Historical pending captures</dt><dd>${signals.saving.pending_offers}</dd><dt>Terminal capture rate</dt><dd>${percentage(signals.saving.completion_rate_percent)}</dd><dt>Average entries per retained capture</dt><dd>${signals.saving.average_proposals_per_offer ?? "Not enough data"}</dd><dt>Median retained review time</dt><dd>${duration(signals.saving.median_decision_seconds)}</dd><dt>Information repairs</dt><dd>${signals.saving.repairs}</dd></dl><p class="muted">Routine Save cards appear here only after Save. Ignored and expired cards are intentionally not retained as project or analytics events.</p></section></div>`,
          { email: request.aliceUser!.email, activeSection: "projects" },
        ),
      );
  });
  app.post("/projects", requireAuthenticatedUser(database), async (request, response) => {
    try {
      const project = await createProject(database, request.aliceUser!.id, {
        name: request.body.name,
      });
      if (!project) {
        return response
          .status(403)
          .type("html")
          .send(
            renderStatusPage(
              "Authorization denied",
              '<h1>Authorization denied.</h1><p>No project was created.</p><p><a href="/">Return to your private workspace</a></p>',
              "danger",
            ),
          );
      }
      if (fileStore && request.body.response_mode === "inline_file_upload") {
        const contexts =
          (await listWorkContexts(database, request.aliceUser!.id, project.id)) || [];
        const initialContext = contexts.find(({ context_kind: kind }) => kind === "work");
        if (initialContext) {
          return response
            .status(201)
            .set("Cache-Control", "no-store")
            .json({ project_id: project.id, context_id: initialContext.id });
        }
      }
      response.redirect(303, `/projects/${encodeURIComponent(project.id)}`);
    } catch (error) {
      response
        .status(400)
        .type("html")
        .send(
          renderStatusPage(
            "Project not created",
            `<h1>Project not created</h1><p>${escapeHtml(String(error))}</p><p>No project data was saved.</p><p><a href="/">Return to your private workspace</a></p>`,
            "danger",
          ),
        );
    }
  });
  app.get("/projects/:projectId", requireAuthenticatedUser(database), async (request, response) => {
    const shell = await getProjectShell(database, request.aliceUser!.id, request.params.projectId);
    if (!shell) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Not found",
            '<h1>Project not found</h1><p>The project may be unavailable or outside your workspace.</p><p><a href="/">Return to your private workspace</a></p>',
            "neutral",
          ),
        );
    }
    const project = shell.project;
    const canWrite = project.project_role === "owner" || project.project_role === "editor";
    const reviewQueue = canWrite
      ? await getReviewQueue(database, {
          userId: request.aliceUser!.id,
          projectId: project.id,
          status: "pending",
          page: 1,
          pageSize: 1,
        })
      : undefined;
    const pendingCount = reviewQueue?.counts.pending || 0;
    response
      .type("html")
      .send(
        renderAppPage(
          project.name,
          `<div class="project-home">${renderProjectShell({ shell, fileStore, pendingCount })}</div>`,
          { email: request.aliceUser!.email, activeSection: "projects" },
        ),
      );
  });
  const renderContextPreview = async (request, response, input) => {
    const parsed = getProjectContextSchema.safeParse({
      project_id: request.params.projectId,
      task:
        typeof input.task === "string" && input.task.trim()
          ? input.task
          : "Preview the exact host context package",
      context_budget:
        typeof input.context_budget === "string" ? Number(input.context_budget) : undefined,
    });
    if (!parsed.success) {
      return response
        .status(400)
        .type("html")
        .send(
          renderStatusPage(
            "Invalid preview",
            `<h1>Invalid package preview request</h1><p>${escapeHtml(parsed.error.issues[0]?.message || "Invalid input")}</p><p>No host-read receipt or project-state change was created.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}">Return to the project</a></p>`,
          ),
        );
    }
    let packagePreview;
    try {
      packagePreview = await getProjectContext(database, {
        userId: request.aliceUser!.id,
        projectId: parsed.data.project_id,
        contextId: undefined,
        task: parsed.data.task,
        contextBudget: parsed.data.context_budget,
        fileTextReadAvailable: Boolean(fileStore),
      });
    } catch (error) {
      if (error instanceof ContextBudgetError) {
        return response
          .status(422)
          .type("html")
          .send(
            renderStatusPage(
              "Package does not fit",
              `<h1>Package does not fit this byte budget</h1><p>${escapeHtml(error.message)}</p><p>No partial package was returned and no project state changed.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}/context-preview">Try a larger permitted budget</a></p>`,
            ),
          );
      }
      throw error;
    }
    if (!packagePreview) {
      return response
        .status(404)
        .type("html")
        .send(
          renderStatusPage(
            "Not found",
            `<h1>Project or context not found</h1><p>The destination may be unavailable or outside your access.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}">Return to the project</a></p>`,
            "neutral",
          ),
        );
    }
    const shell = await getProjectShell(database, request.aliceUser!.id, request.params.projectId);
    if (!shell) {
      return response.status(404).end();
    }
    response
      .type("html")
      .send(
        renderAppPage(
          "Host package preview",
          `<div class="project-home">${renderProjectShell({ shell, fileStore })}<section><div class="section-heading"><div><p class="eyebrow">AI delivery preview</p><h2>Exact project package</h2></div></div><p>This is the deterministic JSON alice. would return for this task and byte budget. Opening this preview does not create a read receipt or mean an AI tool consulted alice.</p><form method="post"><label>Task<input name="task" maxlength="2000" value="${escapeHtml(parsed.data.task)}" required></label><label>UTF-8 byte budget<input name="context_budget" type="number" min="2000" max="32000" value="${escapeHtml(parsed.data.context_budget)}" required></label><button type="submit">Refresh preview</button></form><dl><dt>Package version</dt><dd>${escapeHtml(packagePreview.package.version)}</dd><dt>Budget</dt><dd>${escapeHtml(packagePreview.package.budget.used)} of ${escapeHtml(packagePreview.package.budget.limit)} UTF-8 bytes</dd><dt>Freshness</dt><dd><pre>${escapeHtml(JSON.stringify(packagePreview.package.freshness, null, 2))}</pre></dd><dt>Omitted entries</dt><dd>${escapeHtml(packagePreview.package.omissions.total)}</dd></dl><pre>${escapeHtml(JSON.stringify(packagePreview, null, 2))}</pre></section></div>`,
          { email: request.aliceUser!.email, activeSection: "projects" },
        ),
      );
  };
  app.get(
    "/projects/:projectId/context-preview",
    requireAuthenticatedUser(database),
    (request, response) =>
      renderContextPreview(request, response, { context_id: request.query.context_id }),
  );
  app.post(
    "/projects/:projectId/context-preview",
    requireAuthenticatedUser(database),
    (request, response) => renderContextPreview(request, response, request.body),
  );
  app.post(
    "/projects/:projectId/contexts/preview",
    requireAuthenticatedUser(database),
    async (request, response) => {
      try {
        const suggestions = await suggestSimilarWorkContexts(database, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          input: request.body,
        });
        if (!suggestions) {
          return response
            .status(404)
            .type("html")
            .send(
              renderStatusPage(
                "Not found",
                '<h1>Project not found</h1><p>No work context was created.</p><p><a href="/">Return to your private workspace</a></p>',
                "neutral",
              ),
            );
        }
        const similar = suggestions.length
          ? `<h2>Similar contexts</h2><p>Nothing is grouped or moved automatically. You can return to one of these contexts instead.</p>${suggestions
              .map(
                (context) =>
                  `<article><h3><a href="/projects/${encodeURIComponent(request.params.projectId)}#${encodeURIComponent(context.id)}">${escapeHtml(context.name)}</a></h3><p>${escapeHtml(context.description)}</p></article>`,
              )
              .join("")}`
          : "<p>No similar work context was found.</p>";
        const shell = await getProjectShell(
          database,
          request.aliceUser!.id,
          request.params.projectId,
        );
        if (!shell) {
          return response.status(404).end();
        }
        response
          .type("html")
          .send(
            renderAppPage(
              "Confirm work context",
              `<div class="project-home">${renderProjectShell({ shell, fileStore })}<section><div class="section-heading"><div><p class="eyebrow">Advanced project organization</p><h2>Confirm new work area</h2></div></div>${similar}<article><h3>${escapeHtml(request.body.name)}</h3><p>${escapeHtml(request.body.description)}</p><p>Access: ${escapeHtml(accessLabel(request.body.visibility))}</p></article><form method="post" action="/projects/${encodeURIComponent(request.params.projectId)}/contexts"><input type="hidden" name="name" value="${escapeHtml(request.body.name)}"><input type="hidden" name="description" value="${escapeHtml(request.body.description)}"><input type="hidden" name="visibility" value="${escapeHtml(request.body.visibility)}"><button type="submit">Create this work area</button></form></section></div>`,
              { email: request.aliceUser!.email, activeSection: "projects" },
            ),
          );
      } catch (error) {
        response
          .status(400)
          .type("html")
          .send(
            renderStatusPage(
              "Invalid work context",
              `<h1>${escapeHtml(String(error))}</h1><p>No work context was created.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}">Return to the project</a></p>`,
              "danger",
            ),
          );
      }
    },
  );
  app.post(
    "/projects/:projectId/contexts",
    requireAuthenticatedUser(database),
    async (request, response) => {
      try {
        const context = await createWorkContext(database, {
          userId: request.aliceUser!.id,
          projectId: request.params.projectId,
          input: request.body,
        });
        if (!context) {
          return response
            .status(404)
            .type("html")
            .send(
              renderStatusPage(
                "Not found",
                '<h1>Project not found</h1><p>No work context was created.</p><p><a href="/">Return to your private workspace</a></p>',
                "neutral",
              ),
            );
        }
        response.redirect(
          303,
          `/projects/${encodeURIComponent(request.params.projectId)}#${encodeURIComponent(context.id)}`,
        );
      } catch (error) {
        response
          .status(400)
          .type("html")
          .send(
            renderStatusPage(
              "Work context not created",
              `<h1>${escapeHtml(String(error))}</h1><p>No work context was created.</p><p><a href="/projects/${encodeURIComponent(request.params.projectId)}">Return to the project</a></p>`,
              "danger",
            ),
          );
      }
    },
  );
  app.use("/projects", createSavedContextRouter({ database, fileStore }));
  app.use("/save-previews", createCaptureSavePreviewsRouter({ database, publicUrl }));
  if (fileStore) {
    app.use(
      "/file-save-offers",
      createHostFileSaveOffersRouter({ database, fileStore, publicUrl }),
    );
    app.use("/projects", createFilesRouter({ database, fileStore, publicUrl }));
  }
  app.use("/review", createReviewRouter({ database, fileStore }));

  return { app, database };
}
