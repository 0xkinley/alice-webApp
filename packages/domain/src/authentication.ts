import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { appendAuditEvent } from "./audit.ts";

const PASSWORD_ALGORITHM = "scrypt-v1";
const PASSWORD_KEY_LENGTH = 64;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
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
  const normalizedEmail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    throw new Error("Enter a valid email address.");
  }
  if (typeof password !== "string" || password.length < 12 || password.length > 1_024) {
    throw new Error("Password must contain between 12 and 1024 characters.");
  }
  return normalizedEmail;
}

export function registerUser(database, { email, password }) {
  const normalizedEmail = validateCredentials(email, password);
  const userId = `user_${randomUUID()}`;
  const workspaceId = `workspace_${randomUUID()}`;
  const createdAt = new Date().toISOString();

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(userId, normalizedEmail, encodePassword(password), createdAt);
    database
      .prepare("INSERT INTO workspaces (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
      .run(workspaceId, userId, "Private workspace", createdAt);
    appendAuditEvent(database, {
      workspaceId,
      action: "user_registered",
      actorType: "human_user",
      actorId: userId,
      correlationId: `registration_${randomUUID()}`,
      metadata: { user_id: userId, workspace_id: workspaceId },
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    if (String(error).includes("UNIQUE constraint failed: users.email")) {
      throw new Error("An account already exists for this email address.", { cause: error });
    }
    throw error;
  }

  return { id: userId, email: normalizedEmail, workspace_id: workspaceId, created_at: createdAt };
}

export function authenticateUser(database, { email, password }) {
  const normalizedEmail = normalizeEmail(email);
  const user = database
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

export function createUserSession(database, userId) {
  const token = `alice_session_${randomBytes(32).toString("base64url")}`;
  const now = Math.floor(Date.now() / 1000);
  const workspace = database.prepare("SELECT id FROM workspaces WHERE user_id = ?").get(userId);
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        "INSERT INTO web_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(sha256(token), userId, now + SESSION_TTL_SECONDS, new Date().toISOString());
    appendAuditEvent(database, {
      workspaceId: workspace.id,
      action: "user_session_created",
      actorType: "human_user",
      actorId: userId,
      correlationId: `session_${randomUUID()}`,
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return { token, maxAge: SESSION_TTL_SECONDS };
}

export function userForSession(database, token) {
  if (!token) return undefined;
  return database
    .prepare(
      `SELECT users.id, users.email, workspaces.id AS workspace_id
       FROM web_sessions
       JOIN users ON users.id = web_sessions.user_id
       JOIN workspaces ON workspaces.user_id = users.id
       WHERE web_sessions.token_hash = ? AND web_sessions.expires_at > ?`,
    )
    .get(sha256(token), Math.floor(Date.now() / 1000));
}

export function revokeUserSession(database, token) {
  if (!token) return;
  const tokenHash = sha256(token);
  const session = database
    .prepare(
      `SELECT web_sessions.user_id, workspaces.id AS workspace_id
       FROM web_sessions
       JOIN workspaces ON workspaces.user_id = web_sessions.user_id
       WHERE web_sessions.token_hash = ?`,
    )
    .get(tokenHash);
  if (!session) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(tokenHash);
    appendAuditEvent(database, {
      workspaceId: session.workspace_id,
      action: "user_session_revoked",
      actorType: "human_user",
      actorId: session.user_id,
      correlationId: `session_${randomUUID()}`,
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
