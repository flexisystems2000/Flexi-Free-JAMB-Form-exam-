"use strict";

const crypto = require("crypto");
const { getFirestore, admin } = require("./firebase-admin");

const LEASE_SECONDS = 90;
const TOKEN_HEADER = {
  alg: "HS256",
  typ: "JWT"
};

class CbtAuthError extends Error {
  constructor(code, message, status = 401) {
    super(message);
    this.name = "CbtAuthError";
    this.code = code;
    this.status = status;
  }
}

function getSecret() {
  const secret = process.env.CBT_SESSION_SECRET;

  if (!secret || secret.length < 32) {
    throw new CbtAuthError(
      "SESSION_SECRET_NOT_CONFIGURED",
      "Candidate session security is not configured.",
      503
    );
  }

  return secret;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(value) {
  return crypto
    .createHmac("sha256", getSecret())
    .update(value)
    .digest("base64url");
}

function createToken(payload) {
  const header = encode(TOKEN_HEADER);
  const body = encode(payload);
  const unsigned = `${header}.${body}`;

  return `${unsigned}.${sign(unsigned)}`;
}

function verifyToken(token) {
  if (typeof token !== "string") {
    throw new CbtAuthError("SESSION_REQUIRED", "Session token is required.");
  }

  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new CbtAuthError("INVALID_SESSION", "Invalid session token.");
  }

  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(unsigned));
  const received = Buffer.from(parts[2]);

  if (
    expected.length !== received.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    throw new CbtAuthError("INVALID_SESSION", "Invalid session token.");
  }

  let payload;

  try {
    payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );
  } catch {
    throw new CbtAuthError("INVALID_SESSION", "Invalid session token.");
  }

  if (
    !payload ||
    !payload.attemptId ||
    !payload.candidateId ||
    !payload.sessionId ||
    !payload.examId ||
    !Number.isFinite(payload.expiresAt)
  ) {
    throw new CbtAuthError("INVALID_SESSION", "Invalid session details.");
  }

  if (Date.now() >= payload.expiresAt) {
    throw new CbtAuthError("SESSION_EXPIRED", "Your examination session has expired.");
  }

  return payload;
}

function getSessionDocument(db, attemptId) {
  return db
    .collection("cbt_attempts")
    .doc(attemptId)
    .collection("private")
    .doc("session");
}

/**
 * Creates a candidate session after the examination attempt
 * has been started or successfully resumed.
 *
 * Required:
 * candidateId, attemptId, examId, deadlineAt
 */
async function createCandidateSession({
  candidateId,
  attemptId,
  examId,
  deadlineAt
}) {
  if (!candidateId || !attemptId || !examId || !deadlineAt) {
    throw new CbtAuthError(
      "SESSION_DATA_MISSING",
      "Required session information is missing.",
      400
    );
  }

  const deadline =
    typeof deadlineAt === "number"
      ? deadlineAt
      : new Date(deadlineAt).getTime();

  if (!Number.isFinite(deadline) || deadline <= Date.now()) {
    throw new CbtAuthError(
      "EXAM_TIME_EXPIRED",
      "The examination deadline has passed.",
      403
    );
  }

  const db = getFirestore();
  const sessionRef = getSessionDocument(db, attemptId);

  const sessionId = crypto.randomBytes(32).toString("hex");
  const now = Date.now();

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(sessionRef);

    if (snapshot.exists) {
      const existing = snapshot.data();

      if (
        existing.leaseUntil &&
        existing.leaseUntil.toMillis() > now
      ) {
        throw new CbtAuthError(
          "SESSION_ALREADY_ACTIVE",
          "An active examination session already exists.",
          409
        );
      }
    }

    transaction.set(sessionRef, {
      candidateId,
      attemptId,
      examId,
      sessionId,
      leaseUntil: admin.firestore.Timestamp.fromMillis(
        now + LEASE_SECONDS * 1000
      ),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  const token = createToken({
    candidateId,
    attemptId,
    examId,
    sessionId,
    expiresAt: deadline,
    issuedAt: now
  });

  return {
    token,
    expiresAt: deadline,
    sessionId
  };
}

/**
 * Validates the candidate's Bearer token against the
 * active Firestore session and examination attempt.
 *
 * Call this before protected candidate operations.
 */
async function requireCandidateSession(req) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    throw new CbtAuthError(
      "SESSION_REQUIRED",
      "A valid candidate session is required."
    );
  }

  const payload = verifyToken(match[1]);
  const db = getFirestore();

  const attemptRef = db
    .collection("cbt_attempts")
    .doc(payload.attemptId);

  const sessionRef = getSessionDocument(db, payload.attemptId);

  const now = Date.now();

  const result = await db.runTransaction(async (transaction) => {
    const attemptSnapshot = await transaction.get(attemptRef);
    const sessionSnapshot = await transaction.get(sessionRef);

    if (!attemptSnapshot.exists || !sessionSnapshot.exists) {
      throw new CbtAuthError(
        "SESSION_NOT_FOUND",
        "The examination session could not be found."
      );
    }

    const attempt = attemptSnapshot.data();
    const session = sessionSnapshot.data();

    if (
      session.sessionId !== payload.sessionId ||
      session.candidateId !== payload.candidateId ||
      session.examId !== payload.examId ||
      attempt.candidateId !== payload.candidateId ||
      attempt.examId !== payload.examId
    ) {
      throw new CbtAuthError(
        "SESSION_MISMATCH",
        "This examination session is no longer valid."
      );
    }

    if (attempt.status !== "in_progress") {
      throw new CbtAuthError(
        "ATTEMPT_NOT_ACTIVE",
        "This examination attempt is no longer active.",
        403
      );
    }

    const deadline = attempt.deadlineAt?.toMillis
      ? attempt.deadlineAt.toMillis()
      : new Date(attempt.deadlineAt).getTime();

    if (!Number.isFinite(deadline) || now >= deadline) {
      throw new CbtAuthError(
        "EXAM_TIME_EXPIRED",
        "The examination deadline has passed.",
        403
      );
    }

    transaction.update(sessionRef, {
      leaseUntil: admin.firestore.Timestamp.fromMillis(
        now + LEASE_SECONDS * 1000
      ),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      candidateId: payload.candidateId,
      attemptId: payload.attemptId,
      examId: payload.examId,
      deadlineAt: deadline,
      sessionId: payload.sessionId
    };
  });

  return result;
}

/**
 * Revokes the current session.
 */
async function revokeCandidateSession(req) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    throw new CbtAuthError(
      "SESSION_REQUIRED",
      "A valid candidate session is required."
    );
  }

  const payload = verifyToken(match[1]);
  const db = getFirestore();
  const sessionRef = getSessionDocument(db, payload.attemptId);

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(sessionRef);

    if (!snapshot.exists) return;

    const session = snapshot.data();

    if (session.sessionId === payload.sessionId) {
      transaction.delete(sessionRef);
    }
  });

  return { revoked: true };
}

module.exports = {
  CbtAuthError,
  createCandidateSession,
  requireCandidateSession,
  revokeCandidateSession
};
