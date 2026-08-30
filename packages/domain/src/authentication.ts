import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";

const PASSWORD_ALGORITHM = "scrypt-v1";
const PASSWORD_KEY_LENGTH = 64;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const ALPHA_INVITATION_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

function validateEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    throw new Error("Enter a valid email address.");
  }
  return normalizedEmail;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function passwordDigest(password, salt) {
  return scryptSync(password, salt, PASSWORD_KEY_LENGTH).toString("base64url");
}

function encodePassword(password) {
  const salt = randomBytes(16).toString("base64url");
  return `${PASSWORD_ALGORITHM}$${salt}$${passwordDigest(password, salt)}`;
}

function verifyPassword(password, encoded) {
  const [algorithm, salt, expected] = String(encoded).split("$");
  if (algorithm !== PASSWORD_ALGORITHM || !salt || !expected) return false;
  const actualBuffer = Buffer.from(passwordDigest(password, salt));
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function validateCredentials(email, password) {
  const normalizedEmail = validateEmail(email);
  if (typeof password !== "string" || password.length < 12 || password.length > 1_024) {
    throw new Error("Password must contain between 12 and 1024 characters.");
  }
  return normalizedEmail;
}

export async function issueAlphaInvitation(
  database,
  { email, createdByUserId = null, ttlSeconds = ALPHA_INVITATION_DEFAULT_TTL_SECONDS },
) {
  const normalizedEmail = validateEmail(email);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 3_600 || ttlSeconds > 30 * 24 * 60 * 60) {
    throw new Error("Invitation lifetime must be between one hour and 30 days.");
  }
  const token = `alice_invite_${randomBytes(32).toString("base64url")}`;
  const invitationId = `invite_${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1_000) + ttlSeconds;
  await database
    .prepare(
      `INSERT INTO alpha_invitations
        (id, email, token_hash, created_by_user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(invitationId, normalizedEmail, sha256(token), createdByUserId, expiresAt, createdAt);
  return { id: invitationId, email: normalizedEmail, token, expires_at: expiresAt };
}

export async function alphaInvitationForToken(database, token) {
  if (typeof token !== "string" || !token.startsWith("alice_invite_") || token.length > 128) {
    return undefined;
  }
  const invitation = await database
    .prepare(
      `SELECT id, email, expires_at
       FROM alpha_invitations
       WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(sha256(token), Math.floor(Date.now() / 1_000));
  return invitation || undefined;
}

export async function registerUser(database, { email, password, invitationToken }) {
  const normalizedEmail = validateCredentials(email, password);
  const userId = `user_${randomUUID()}`;
  const workspaceId = `workspace_${randomUUID()}`;
  const createdAt = new Date().toISOString();

  try {
    await database.transaction(async () => {
      const invitation = await database
        .prepare(
          `SELECT id, email
           FROM alpha_invitations
           WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
           FOR UPDATE`,
        )
        .get(sha256(String(invitationToken || "")), Math.floor(Date.now() / 1_000));
      if (!invitation || normalizeEmail(invitation.email) !== normalizedEmail) {
        throw new Error("A valid alpha invitation for this email address is required.");
      }
      await database
        .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
        .run(userId, normalizedEmail, encodePassword(password), createdAt);
      await database
        .prepare("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
        .run(workspaceId, userId, "Private workspace", createdAt);
      await appendAuditEvent(database, {
        workspaceId,
        action: "user_registered",
        actorType: "human_user",
        actorId: userId,
        correlationId: `registration_${randomUUID()}`,
        metadata: { user_id: userId, workspace_id: workspaceId },
      });
      const accepted = await database
        .prepare(
          `UPDATE alpha_invitations
           SET accepted_by_user_id = ?, accepted_at = ?
           WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
        )
        .run(userId, createdAt, invitation.id);
      if (accepted.changes !== 1) throw new Error("The alpha invitation is no longer available.");
    });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505") {
      throw new Error("An account already exists for this email address.", { cause: error });
    }
    throw error;
  }

  return { id: userId, email: normalizedEmail, workspace_id: workspaceId, created_at: createdAt };
}

export async function authenticateUser(database, { email, password }) {
  const normalizedEmail = normalizeEmail(email);
  const user = await database
    .prepare(
      `SELECT users.id, users.email, users.password_hash, workspaces.id AS workspace_id
       FROM users
       JOIN workspaces ON workspaces.user_id = users.id
       WHERE users.email = ?`,
    )
    .get(normalizedEmail);
  if (!user || !verifyPassword(String(password), user.password_hash)) return undefined;
  return { id: user.id, email: user.email, workspace_id: user.workspace_id };
}

export async function createUserSession(database, userId) {
  const token = `alice_session_${randomBytes(32).toString("base64url")}`;
  const now = Math.floor(Date.now() / 1000);
  const workspace = await database
    .prepare("SELECT id FROM workspaces WHERE user_id = ?")
    .get(userId);
  await database.transaction(async () => {
    await database
      .prepare(
        "INSERT INTO web_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(sha256(token), userId, now + SESSION_TTL_SECONDS, new Date().toISOString());
    await appendAuditEvent(database, {
      workspaceId: workspace.id,
      action: "user_session_created",
      actorType: "human_user",
      actorId: userId,
      correlationId: `session_${randomUUID()}`,
    });
  });
  return { token, maxAge: SESSION_TTL_SECONDS };
}

export async function userForSession(database, token) {
  if (!token) return undefined;
  return await database
    .prepare(
      `SELECT users.id, users.email, workspaces.id AS workspace_id
       FROM web_sessions
       JOIN users ON users.id = web_sessions.user_id
       JOIN workspaces ON workspaces.user_id = users.id
       WHERE web_sessions.token_hash = ? AND web_sessions.expires_at > ?`,
    )
    .get(sha256(token), Math.floor(Date.now() / 1000));
}

export async function revokeUserSession(database, token) {
  if (!token) return;
  const tokenHash = sha256(token);
  const session = await database
    .prepare(
      `SELECT web_sessions.user_id, workspaces.id AS workspace_id
       FROM web_sessions
       JOIN workspaces ON workspaces.user_id = web_sessions.user_id
       WHERE web_sessions.token_hash = ?`,
    )
    .get(tokenHash);
  if (!session) return;
  await database.transaction(async () => {
    await database.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(tokenHash);
    await appendAuditEvent(database, {
      workspaceId: session.workspace_id,
      action: "user_session_revoked",
      actorType: "human_user",
      actorId: session.user_id,
      correlationId: `session_${randomUUID()}`,
    });
  });
}
