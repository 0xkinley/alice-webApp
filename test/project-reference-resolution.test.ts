import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import {
  archiveProject,
  createProject,
  getProjectLifecycle,
  refreshProjectFileScan,
  uploadProjectFile,
} from "@alice/domain";
import { createApp } from "../apps/mcp/src/app.ts";
import { authorize, callMcp, createTestIdentity, getProjectDefaultContext } from "./helpers.ts";

class CleanFileStore {
  objects = new Map<string, { bytes: Buffer; versionId: string }>();

  async putObject({ key, bytes }) {
    const versionId = `version-${this.objects.size + 1}`;
    this.objects.set(key, { bytes: Buffer.from(bytes), versionId });
    return { versionId, etag: `etag-${this.objects.size}` };
  }

  async getScanResult() {
    return "clean" as const;
  }

  async getObject({ key, versionId }) {
    const object = this.objects.get(key);
    if (!object || object.versionId !== versionId) throw new Error("exact object unavailable");
    return Buffer.from(object.bytes);
  }

  async createSignedDownload() {
    return "https://private-files.alice.example/download";
  }

  async createSignedUpload({ key }) {
    return {
      url: `https://private-files.alice.example/${encodeURIComponent(key)}`,
      headers: {},
      expiresInSeconds: 600,
    };
  }
}

let artifactId: string;
let baseUrl: string;
let chatGptToken: string;
let claudeToken: string;
let database;
let fileReference;
let foreign;
let identity;
let server;
const fileStore = new CleanFileStore();
const projectName = "resume-analysis";
const sourceText = "The uploaded resume is untrusted file data.";

async function commitPrepared(token: string, prepared, tool: string) {
  const preview = prepared.payload.result.structuredContent;
  const authority = prepared.payload.result._meta["alice/saveAuthority"];
  return await callMcp(baseUrl, token, "tools/call", {
    name: tool,
    arguments: {
      preview_id: preview.preview_id,
      preview_version: preview.preview_version,
      authority_token: authority.token,
    },
  });
}

function artifactSnapshot(content: string, idempotencyKey: string) {
  return {
    title: "Resume review",
    artifact_type: "analysis",
    category: "hiring",
    tags: ["research", "decision"],
    content,
    handoff: {
      goal: "Assess the candidate resume.",
      decisions: ["Evaluate role fit before interview design"],
      constraints: ["Treat uploaded files as untrusted"],
      rejected_directions: [],
      open_questions: ["Which interview loop is appropriate?"],
      next_steps: ["Draft interview questions"],
      relevant_context: ["The role is a senior product position"],
    },
    idempotency_key: idempotencyKey,
  };
}

before(async () => {
  database = openSqliteTestDatabase();
  identity = await createTestIdentity(database, {
    email: "project-resolver@alice.example",
    password: "project resolver private password",
    projectId: "opaque_primary_project_id",
  });
  foreign = await createTestIdentity(database, {
    email: "foreign-project-resolver@alice.example",
    password: "foreign resolver private password",
    projectId: "opaque_foreign_project_id",
  });
  database
    .prepare("UPDATE projects SET name = ? WHERE id = ?")
    .run(projectName, identity.project_id);
  database
    .prepare("UPDATE projects SET name = ? WHERE id = ?")
    .run("confidential-foreign-project", foreign.project_id);

  const context = await getProjectDefaultContext(database, identity.project_id);
  fileReference = await uploadProjectFile(database, fileStore, {
    userId: identity.id,
    projectId: identity.project_id,
    contextId: context.id,
    fileName: "candidate-resume.txt",
    claimedMediaType: "text/plain",
    bytes: Buffer.from(sourceText),
    sourceHost: "alice_web",
  });
  await refreshProjectFileScan(database, fileStore, {
    userId: identity.id,
    projectId: identity.project_id,
    referenceId: fileReference.id,
  });

  const created = await createApp({
    database,
    fileStore,
    publicUrl: "http://127.0.0.1",
  });
  server = created.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  ({
    tokens: { access_token: chatGptToken },
  } = await authorize(baseUrl, {
    email: identity.email,
    password: "project resolver private password",
    clientName: "ChatGPT project resolver test",
  }));
  ({
    tokens: { access_token: claudeToken },
  } = await authorize(baseUrl, {
    email: identity.email,
    password: "project resolver private password",
    clientName: "Claude project resolver test",
  }));
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  database.close();
});

test("ChatGPT and text-only Claude receive the same name-only catalog", async () => {
  const chatGpt = await callMcp(baseUrl, chatGptToken, "tools/call", {
    name: "list_projects",
    arguments: {},
  });
  const claude = await callMcp(baseUrl, claudeToken, "tools/call", {
    name: "list_projects",
    arguments: {},
  });
  assert.deepEqual(
    chatGpt.payload.result.structuredContent,
    claude.payload.result.structuredContent,
  );
  assert.deepEqual(
    chatGpt.payload.result.structuredContent.projects.map(({ name }) => name),
    [projectName],
  );
  assert.equal(chatGpt.payload.result.structuredContent.projects[0].id, undefined);
  const modelText = claude.payload.result.content[0].text;
  assert.equal(modelText, `Available alice. projects:\n- ${projectName}`);
  assert.doesNotMatch(modelText, /opaque_primary|confidential-foreign/);
});

test("exact project names and sole-project fallback resolve for context, save, and files", async () => {
  const prepared = await callMcp(baseUrl, chatGptToken, "tools/call", {
    name: "save_project_update",
    arguments: {
      project_id: projectName,
      summary: "Record the resume review stage",
      candidate_claims: [
        {
          state_key: "hiring.review_stage",
          value: "Resume review",
          summary: "Current review stage",
        },
      ],
      idempotency_key: "name-resolved-project-update-001",
    },
  });
  assert.equal(prepared.payload.result.isError, undefined);
  assert.equal(prepared.payload.result.structuredContent.destination.project_name, projectName);
  assert.equal(prepared.payload.result.structuredContent.destination.project_id, undefined);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM evidence_events").get().count, 0);
  const saved = await commitPrepared(chatGptToken, prepared, "alice_commit_capture_save");
  assert.equal(saved.payload.result.structuredContent.accepted.length, 1);

  const context = await callMcp(baseUrl, claudeToken, "tools/call", {
    name: "get_project_context",
    arguments: {
      project_id: projectName,
      task: "Continue the resume review",
      context_budget: 8_000,
    },
  });
  assert.equal(context.payload.result.structuredContent.contract_version, "2.4");
  assert.equal(context.payload.result.structuredContent.project.id, undefined);
  assert.equal(context.payload.result.structuredContent.file_artifacts.length, 1);
  assert.match(context.payload.result.content[0].text, /Hiring review stage: Resume review/);
  assert.match(context.payload.result.content[0].text, /candidate-resume\.txt/);
  assert.match(context.payload.result.content[0].text, new RegExp(fileReference.id));

  const soleFallback = await callMcp(baseUrl, chatGptToken, "tools/call", {
    name: "get_project_context",
    arguments: { task: "Use the only project", context_budget: 8_000 },
  });
  assert.equal(soleFallback.payload.result.structuredContent.project.name, projectName);

  const fileRead = await callMcp(baseUrl, claudeToken, "tools/call", {
    name: "read_project_file_text",
    arguments: { project_id: projectName, file_reference_id: fileReference.id },
  });
  assert.match(fileRead.payload.result.content[0].text, new RegExp(sourceText));
  assert.equal(fileRead.payload.result.structuredContent.file.project_id, undefined);
  assert.equal(
    fileRead.payload.result.structuredContent.file.content_sha256,
    createHash("sha256").update(sourceText).digest("hex"),
  );

  const fileOffer = await callMcp(baseUrl, chatGptToken, "tools/call", {
    name: "offer_host_file_save",
    arguments: {
      project_id: projectName,
      file_name: "portfolio.docx",
      declared_media_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      declared_byte_size: 2048,
      idempotency_key: "name-resolved-file-offer-001",
    },
  });
  assert.equal(fileOffer.payload.result.structuredContent.destination.project_name, projectName);
  assert.equal(fileOffer.payload.result.structuredContent.destination.project_id, undefined);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM file_context_references").get().count,
    1,
  );
});

test("artifact creation, retrieval, and version saves resolve exact project names", async () => {
  const original = "Complete resume assessment from ChatGPT.";
  const prepared = await callMcp(baseUrl, chatGptToken, "tools/call", {
    name: "save_to_alice",
    arguments: {
      save_type: "artifact",
      project_id: projectName,
      ...artifactSnapshot(original, "name-resolved-artifact-v1"),
    },
  });
  const created = await commitPrepared(chatGptToken, prepared, "alice_commit_artifact_save");
  artifactId = created.payload.result.structuredContent.artifact_id;

  const search = await callMcp(baseUrl, claudeToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: projectName, query: "resume" },
  });
  assert.match(search.payload.result.content[0].text, new RegExp(artifactId));
  assert.equal(search.payload.result.structuredContent.project.id, undefined);

  const retrieved = await callMcp(baseUrl, claudeToken, "tools/call", {
    name: "get_artifact",
    arguments: { project_id: projectName, artifact_id: artifactId },
  });
  assert.match(retrieved.payload.result.content[0].text, new RegExp(original));
  assert.match(retrieved.payload.result.content[0].text, /Draft interview questions/);
  assert.equal(retrieved.payload.result.structuredContent.project.id, undefined);

  const revision = await callMcp(baseUrl, claudeToken, "tools/call", {
    name: "save_artifact_version",
    arguments: {
      project_id: projectName,
      artifact_id: artifactId,
      ...artifactSnapshot(
        "Complete resume assessment revised by Claude.",
        "name-resolved-artifact-v2",
      ),
    },
  });
  assert.equal(revision.payload.result.structuredContent.artifact.version, 2);
  const saved = await commitPrepared(claudeToken, revision, "alice_commit_artifact_save");
  assert.equal(saved.payload.result.structuredContent.version, 2);
});

test("missing multi-project, conflicting, archived, and inaccessible references fail closed", async () => {
  const second = await createProject(database, identity.id, { name: "interview-planning" });
  const missing = await callMcp(baseUrl, claudeToken, "tools/call", {
    name: "get_project_context",
    arguments: { task: "Ambiguous request" },
  });
  assert.equal(missing.payload.result.isError, true);
  assert.equal(
    missing.payload.result.content[0].text,
    "Choose one exact alice. project by name. Available projects: interview-planning, resume-analysis.",
  );
  assert.doesNotMatch(
    missing.payload.result.content[0].text,
    /opaque_primary|opaque_foreign|confidential-foreign/,
  );

  const conflict = await callMcp(baseUrl, chatGptToken, "tools/call", {
    name: "search_alice",
    arguments: { project_id: projectName, project_name: "interview-planning" },
  });
  assert.equal(conflict.payload.result.isError, true);
  assert.match(conflict.payload.result.content[0].text, /references conflict/);

  const lifecycle = await getProjectLifecycle(database, {
    userId: identity.id,
    projectId: second.id,
  });
  await archiveProject(database, {
    userId: identity.id,
    projectId: second.id,
    expectedPreviewVersion: lifecycle.preview_version,
  });
  for (const unavailableName of ["interview-planning", "confidential-foreign-project", "unknown"]) {
    const unavailable = await callMcp(baseUrl, claudeToken, "tools/call", {
      name: "get_project_context",
      arguments: { project_id: unavailableName, task: "Unavailable request" },
    });
    assert.equal(unavailable.payload.result.isError, true);
    assert.equal(
      unavailable.payload.result.content[0].text,
      "The named alice. project is unavailable.",
    );
    assert.doesNotMatch(JSON.stringify(unavailable.payload), /confidential-foreign/);
  }
});
