import assert from "node:assert/strict";
import { test } from "node:test";
import { openSqliteTestDatabase } from "@alice/database/testing";
import {
  acceptProjectInvitation,
  activeTargetForConnection,
  contextScopeForUser,
  createProjectInvitation,
  createWorkContext,
  endContextAccess,
  getContextAccessView,
  getProjectAccessOverview,
  getCapturePreview,
  getProjectContext,
  getProjectCollaborators,
  getProjectMembershipView,
  grantContextAccess,
  leaveProject,
  listWorkContexts,
  ProjectMembershipUserError,
  removeProjectMember,
  saveCandidateUpdate,
  setActiveConnectionTarget,
  transferProjectOwnership,
  confirmCapturedUpdate,
  updateContextAccessRole,
} from "@alice/domain";
import { createTestIdentity } from "./helpers.ts";

async function addMember(database, owner, member, role: "editor" | "viewer") {
  const invitation = await createProjectInvitation(database, {
    userId: owner.id,
    projectId: owner.project_id,
    email: member.email,
    role,
  });
  await acceptProjectInvitation(database, member.id, invitation.token);
  return await getProjectMembershipView(database, member.id, owner.project_id);
}

test("restricted and personal contexts require exact context access independently of project role", async () => {
  const database = openSqliteTestDatabase();
  const owner = await createTestIdentity(database, {
    email: "context-owner@alice.example",
    projectId: "project_context_access",
  });
  const editor = await createTestIdentity(database, {
    email: "context-editor@alice.example",
    projectId: "project_context_editor_private",
  });
  const viewer = await createTestIdentity(database, {
    email: "context-viewer@alice.example",
    projectId: "project_context_viewer_private",
  });
  const ownerMembership = await getProjectMembershipView(database, owner.id, owner.project_id);
  const editorMembership = await addMember(database, owner, editor, "editor");
  const viewerMembership = await addMember(database, owner, viewer, "viewer");

  const restricted = await createWorkContext(database, {
    userId: editor.id,
    projectId: owner.project_id,
    input: {
      name: "Restricted launch",
      description: "Explicitly selected launch collaborators.",
      visibility: "selected_members",
    },
  });
  const personal = await createWorkContext(database, {
    userId: editor.id,
    projectId: owner.project_id,
    input: {
      name: "Editor's private draft",
      description: "Visible only to its creator.",
      visibility: "personal",
    },
  });

  const ownerBeforeGrant = await getProjectAccessOverview(database, {
    userId: owner.id,
    projectId: owner.project_id,
  });
  assert.deepEqual(
    ownerBeforeGrant.members.map(({ email }) => email).sort(),
    [editor.email, owner.email, viewer.email].sort(),
  );
  assert.equal(
    ownerBeforeGrant.contexts.some(({ id }) => id === restricted.id),
    false,
  );
  assert.equal(
    ownerBeforeGrant.contexts.some(({ id }) => id === personal.id),
    false,
  );
  assert.equal(
    ownerBeforeGrant.security_events.some(({ context_name }) => context_name === restricted.name),
    false,
  );
  assert.equal(
    await getProjectAccessOverview(database, {
      userId: viewer.id,
      projectId: editor.project_id,
    }),
    undefined,
  );

  assert.ok(
    (await listWorkContexts(database, editor.id, owner.project_id)).some(
      ({ id }) => id === restricted.id,
    ),
  );
  assert.ok(
    (await listWorkContexts(database, editor.id, owner.project_id)).some(
      ({ id }) => id === personal.id,
    ),
  );
  assert.throws(() =>
    database
      .prepare(
        `UPDATE project_memberships
         SET ended_at = ?, ended_by_user_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        owner.id,
        new Date().toISOString(),
        editorMembership.membership_id,
      ),
  );
  for (const principal of [owner, viewer]) {
    const visible = await listWorkContexts(database, principal.id, owner.project_id);
    assert.equal(
      visible.some(({ id }) => id === restricted.id),
      false,
    );
    assert.equal(
      visible.some(({ id }) => id === personal.id),
      false,
    );
    assert.equal(
      await contextScopeForUser(database, {
        userId: principal.id,
        projectId: owner.project_id,
        contextId: restricted.id,
      }),
      undefined,
    );
  }

  const accessView = await getContextAccessView(database, {
    userId: editor.id,
    projectId: owner.project_id,
    contextId: restricted.id,
  });
  assert.equal(accessView.context.name, "Restricted launch");
  const ownerGrant = await grantContextAccess(database, {
    userId: editor.id,
    projectId: owner.project_id,
    contextId: restricted.id,
    membershipId: ownerMembership.membership_id,
    role: "viewer",
  });
  assert.equal(
    (
      await contextScopeForUser(database, {
        userId: owner.id,
        projectId: owner.project_id,
        contextId: restricted.id,
      })
    ).contextRole,
    "viewer",
  );
  assert.equal(
    await contextScopeForUser(database, {
      userId: owner.id,
      projectId: owner.project_id,
      contextId: restricted.id,
      capability: "write",
    }),
    undefined,
  );
  await updateContextAccessRole(database, {
    userId: editor.id,
    projectId: owner.project_id,
    contextId: restricted.id,
    grantId: ownerGrant.id,
    role: "editor",
  });
  assert.ok(
    await contextScopeForUser(database, {
      userId: owner.id,
      projectId: owner.project_id,
      contextId: restricted.id,
      capability: "write",
    }),
  );

  await assert.rejects(
    grantContextAccess(database, {
      userId: editor.id,
      projectId: owner.project_id,
      contextId: restricted.id,
      membershipId: viewerMembership.membership_id,
      role: "manager",
    }),
    /project Viewer can only receive Viewer/i,
  );
  const viewerGrant = await grantContextAccess(database, {
    userId: editor.id,
    projectId: owner.project_id,
    contextId: restricted.id,
    membershipId: viewerMembership.membership_id,
    role: "viewer",
  });
  assert.ok(
    await contextScopeForUser(database, {
      userId: viewer.id,
      projectId: owner.project_id,
      contextId: restricted.id,
    }),
  );
  assert.throws(() =>
    database.prepare("DELETE FROM context_access_grants WHERE id = ?").run(viewerGrant.id),
  );
  await endContextAccess(database, {
    userId: editor.id,
    projectId: owner.project_id,
    contextId: restricted.id,
    grantId: viewerGrant.id,
  });

  database
    .prepare(
      `INSERT INTO audit_events
        (id, workspace_id, project_id, action, actor_type, actor_id,
         correlation_id, safe_metadata_json, created_at)
       VALUES ('audit_access_privacy_fixture', ?, ?, 'context_access_granted',
               'human_user', ?, 'privacy_fixture', ?, ?)`,
    )
    .run(
      owner.workspace_id,
      owner.project_id,
      owner.id,
      JSON.stringify({
        context_id: restricted.id,
        bearer_token: "must-never-render",
        submitted_evidence_content: "private launch evidence",
      }),
      new Date().toISOString(),
    );
  const ownerAfterGrant = await getProjectAccessOverview(database, {
    userId: owner.id,
    projectId: owner.project_id,
  });
  const ownerRestricted = ownerAfterGrant.contexts.find(({ id }) => id === restricted.id);
  assert.deepEqual(
    ownerRestricted.members.map(({ email, context_role: role }) => [email, role]),
    [
      [editor.email, "manager"],
      [owner.email, "editor"],
    ],
  );
  assert.equal(
    ownerAfterGrant.contexts.some(({ id }) => id === personal.id),
    false,
  );
  assert.ok(
    ownerAfterGrant.security_events.some(
      ({ label, context_name: contextName }) =>
        label === "Context access granted" && contextName === restricted.name,
    ),
  );
  assert.doesNotMatch(JSON.stringify(ownerAfterGrant), /must-never-render|private launch evidence/);

  const editorOverview = await getProjectAccessOverview(database, {
    userId: editor.id,
    projectId: owner.project_id,
  });
  const editorPersonal = editorOverview.contexts.find(({ id }) => id === personal.id);
  assert.deepEqual(
    editorPersonal.members.map(({ email, context_role: role }) => [email, role]),
    [[editor.email, "manager"]],
  );
  assert.equal(
    await contextScopeForUser(database, {
      userId: viewer.id,
      projectId: owner.project_id,
      contextId: restricted.id,
    }),
    undefined,
  );
  assert.equal(editorMembership.role, "editor");
  database.close();
});

test("ownership transfer and departure preserve an active owner and revoke context grants", async () => {
  const database = openSqliteTestDatabase();
  const owner = await createTestIdentity(database, {
    email: "transfer-owner@alice.example",
    projectId: "project_transfer_access",
  });
  const editor = await createTestIdentity(database, {
    email: "transfer-editor@alice.example",
    projectId: "project_transfer_editor_private",
  });
  const viewer = await createTestIdentity(database, {
    email: "leaving-viewer@alice.example",
    projectId: "project_leaving_viewer_private",
  });
  const editorMembership = await addMember(database, owner, editor, "editor");
  const viewerMembership = await addMember(database, owner, viewer, "viewer");
  const restricted = await createWorkContext(database, {
    userId: owner.id,
    projectId: owner.project_id,
    input: {
      name: "Transfer restricted",
      description: "Restricted ownership-transfer fixture.",
      visibility: "selected_members",
    },
  });
  const editorGrant = await grantContextAccess(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: restricted.id,
    membershipId: editorMembership.membership_id,
    role: "manager",
  });
  const viewerGrant = await grantContextAccess(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: restricted.id,
    membershipId: viewerMembership.membership_id,
    role: "viewer",
  });

  await transferProjectOwnership(database, {
    userId: owner.id,
    projectId: owner.project_id,
    membershipId: editorMembership.membership_id,
  });
  assert.equal(
    (await getProjectMembershipView(database, editor.id, owner.project_id)).role,
    "owner",
  );
  assert.equal(
    (await getProjectMembershipView(database, owner.id, owner.project_id)).role,
    "editor",
  );
  assert.ok(await getProjectCollaborators(database, editor.id, owner.project_id));
  assert.equal(await getProjectCollaborators(database, owner.id, owner.project_id), undefined);
  assert.equal(
    database.prepare("SELECT role FROM context_access_grants WHERE id = ?").get(editorGrant.id)
      .role,
    "manager",
  );

  await leaveProject(database, viewer.id, owner.project_id);
  assert.equal(await getProjectMembershipView(database, viewer.id, owner.project_id), undefined);
  const endedGrant = database
    .prepare("SELECT ended_at, ended_by_user_id FROM context_access_grants WHERE id = ?")
    .get(viewerGrant.id);
  assert.ok(endedGrant.ended_at);
  assert.equal(endedGrant.ended_by_user_id, viewer.id);
  assert.equal(
    await contextScopeForUser(database, {
      userId: viewer.id,
      projectId: owner.project_id,
      contextId: restricted.id,
    }),
    undefined,
  );

  await createWorkContext(database, {
    userId: owner.id,
    projectId: owner.project_id,
    input: {
      name: "Personal departure blocker",
      description: "Must receive an explicit disposition before departure.",
      visibility: "personal",
    },
  });
  const priorOwnerMembership = await getProjectMembershipView(database, owner.id, owner.project_id);
  await assert.rejects(
    removeProjectMember(database, {
      userId: editor.id,
      projectId: owner.project_id,
      membershipId: priorOwnerMembership.membership_id,
    }),
    (error) =>
      error instanceof ProjectMembershipUserError && /personal context/i.test(error.message),
  );
  assert.equal(
    (await getProjectMembershipView(database, owner.id, owner.project_id)).role,
    "editor",
  );
  database.close();
});

test("a collaborator connection captures into the project workspace and loses its target on grant revocation", async () => {
  const database = openSqliteTestDatabase();
  const owner = await createTestIdentity(database, {
    email: "capture-owner@alice.example",
    projectId: "project_collaborator_capture",
  });
  const editor = await createTestIdentity(database, {
    email: "capture-editor@alice.example",
    projectId: "project_capture_editor_private",
  });
  const editorMembership = await addMember(database, owner, editor, "editor");
  const restricted = await createWorkContext(database, {
    userId: owner.id,
    projectId: owner.project_id,
    input: {
      name: "Collaborator capture",
      description: "A restricted cross-workspace capture target.",
      visibility: "selected_members",
    },
  });
  const grant = await grantContextAccess(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: restricted.id,
    membershipId: editorMembership.membership_id,
    role: "editor",
  });
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES ('collaborator-client', 'Collaborator client', '[]', 'none', ?)`,
    )
    .run(now);
  database
    .prepare(
      `INSERT INTO integration_connections
        (id, user_id, workspace_id, client_id, client_classification, granted_scopes,
         first_connected_at, last_used_at)
       VALUES ('collaborator-connection', ?, ?, 'collaborator-client', 'test',
               'mcp:read mcp:write', ?, ?)`,
    )
    .run(editor.id, editor.workspace_id, now, now);
  const selected = await setActiveConnectionTarget(database, {
    userId: editor.id,
    connectionId: "collaborator-connection",
    projectId: owner.project_id,
    contextId: restricted.id,
    expectedVersions: { "collaborator-connection": null },
  });
  assert.equal(selected.conflict, false);
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT workspace_id, project_workspace_id FROM active_connection_targets
         WHERE connection_id = 'collaborator-connection'`,
        )
        .get(),
    },
    { workspace_id: editor.workspace_id, project_workspace_id: owner.workspace_id },
  );

  const receipt = await saveCandidateUpdate(database, {
    clientId: "collaborator-client",
    connectionId: "collaborator-connection",
    publicUrl: "https://app.alice.example",
    userId: editor.id,
    payload: {
      project_id: owner.project_id,
      context_id: restricted.id,
      summary: "Collaborator captured one candidate.",
      candidate_claims: [
        {
          state_key: "launch.collaborator_decision",
          value: "captured across workspaces",
          summary: "Cross-workspace capture fixture.",
        },
      ],
      idempotency_key: "collaborator-capture-fixture",
    },
  });
  const evidence = database
    .prepare(`SELECT workspace_id, connection_workspace_id FROM evidence_events WHERE id = ?`)
    .get(receipt.evidence_id);
  assert.deepEqual(
    { ...evidence },
    {
      workspace_id: owner.workspace_id,
      connection_workspace_id: editor.workspace_id,
    },
  );
  const preview = await getCapturePreview(database, {
    evidenceId: receipt.evidence_id,
    userId: editor.id,
  });
  const confirmed = await confirmCapturedUpdate(database, {
    evidenceId: receipt.evidence_id,
    expectedPreviewVersion: preview.preview_version,
    userId: editor.id,
  });
  assert.equal(confirmed.conflict, false);
  const context = await getProjectContext(database, {
    userId: editor.id,
    projectId: owner.project_id,
    contextId: restricted.id,
    task: "Read the collaborator decision",
    contextBudget: 4_000,
  });
  assert.equal(context.accepted_decisions[0].value, "captured across workspaces");

  await endContextAccess(database, {
    userId: owner.id,
    projectId: owner.project_id,
    contextId: restricted.id,
    grantId: grant.id,
  });
  assert.equal(
    await activeTargetForConnection(database, {
      userId: editor.id,
      connectionId: "collaborator-connection",
    }),
    undefined,
  );
  assert.equal(
    await getProjectContext(database, {
      userId: editor.id,
      projectId: owner.project_id,
      contextId: restricted.id,
      task: "Try after revocation",
      contextBudget: 4_000,
    }),
    undefined,
  );
  database.close();
});
