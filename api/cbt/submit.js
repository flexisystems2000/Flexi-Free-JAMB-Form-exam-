"use strict";

const crypto = require("crypto");
const { getFirestore, admin } = require("../../lib/firebase-admin");

const EXAM_ID = process.env.CBT_EXAM_ID || "jamb-2026-11-28";
const PER_SUBJECT = 40;

function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  return res.status(status).json(body);
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function getSubmissionPayload(req) {
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error("SESSION_REQUIRED"), { status: 401 });

  const token = match[1];
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw Object.assign(new Error("INVALID_SESSION"), { status: 401 });
  }

  const secret = process.env.CBT_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw Object.assign(new Error("SESSION_SECRET_NOT_CONFIGURED"), { status: 503 });
  }

  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac("sha256", secret)
    .update(unsigned)
    .digest("base64url");

  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(parts[2]);

  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    throw Object.assign(new Error("INVALID_SESSION"), { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw Object.assign(new Error("INVALID_SESSION"), { status: 401 });
  }

  if (
    !payload ||
    !payload.candidateId ||
    !payload.attemptId ||
    !payload.examId ||
    !payload.sessionId ||
    !Number.isFinite(payload.expiresAt)
  ) {
    throw Object.assign(new Error("INVALID_SESSION"), { status: 401 });
  }

  // Intentionally do not reject payload.expiresAt here. A candidate's signed
  // token must still be usable to finalize the attempt at its official
  // deadline. The Firestore session and attempt identity are checked below.
  return payload;
}

function calculateScores(questionSnapshot, answerDocs) {
  const subjectScores = {};
  let totalCorrect = 0;
  let totalAnswered = 0;
  let totalQuestions = 0;

  for (const [subject, questions] of Object.entries(questionSnapshot)) {
    if (!Array.isArray(questions) || questions.length !== PER_SUBJECT) {
      throw new Error("INVALID_QUESTION_SNAPSHOT");
    }

    let correct = 0;
    let answered = 0;

    for (const question of questions) {
      const key = String(question.answer || "").toUpperCase();
      if (!question.id || !["A", "B", "C", "D"].includes(key)) {
        throw new Error("INVALID_ANSWER_KEY");
      }

      const selected = answerDocs[question.id]?.selectedOption;
      if (selected !== null && selected !== undefined && selected !== "") {
        const choice = String(selected).toUpperCase();
        if (["A", "B", "C", "D"].includes(choice)) {
          answered++;
          if (choice === key) correct++;
        }
      }
    }

    subjectScores[subject] = {
      totalQuestions: questions.length,
      answered,
      unanswered: questions.length - answered,
      correct,
      incorrect: answered - correct,
      score: correct,
      percentage: Number((correct / questions.length * 100).toFixed(2))
    };

    totalCorrect += correct;
    totalAnswered += answered;
    totalQuestions += questions.length;
  }

  return {
    subjectScores,
    totalQuestions,
    totalAnswered,
    totalUnanswered: totalQuestions - totalAnswered,
    totalCorrect,
    totalIncorrect: totalAnswered - totalCorrect,
    totalScore: totalCorrect,
    percentage: totalQuestions
      ? Number((totalCorrect / totalQuestions * 100).toFixed(2))
      : 0
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  }

  try {
    const session = getSubmissionPayload(req);
    if (session.examId !== EXAM_ID) {
      return send(res, 403, { ok: false, code: "SESSION_EXAM_MISMATCH" });
    }

    const db = getFirestore();
    const attemptRef = db.collection("cbt_attempts").doc(session.attemptId);
    const sessionRef = attemptRef.collection("private").doc("session");
    const snapshotRef = attemptRef.collection("private").doc("question_snapshot");
    const answersRef = attemptRef.collection("answers");

    const final = await db.runTransaction(async tx => {
      const [attemptSnap, sessionSnap, questionSnap, answersSnap] = await Promise.all([
        tx.get(attemptRef),
        tx.get(sessionRef),
        tx.get(snapshotRef),
        tx.get(answersRef)
      ]);

      if (!attemptSnap.exists) {
        throw Object.assign(new Error("ATTEMPT_NOT_FOUND"), { status: 404 });
      }
      if (!sessionSnap.exists) {
        throw Object.assign(new Error("SESSION_NOT_FOUND"), { status: 401 });
      }
      if (!questionSnap.exists) {
        throw Object.assign(new Error("QUESTION_SNAPSHOT_NOT_FOUND"), { status: 409 });
      }

      const attempt = attemptSnap.data() || {};
      const savedSession = sessionSnap.data() || {};
      const snapshot = questionSnap.data() || {};

      if (
        savedSession.sessionId !== session.sessionId ||
        savedSession.candidateId !== session.candidateId ||
        savedSession.attemptId !== session.attemptId ||
        savedSession.examId !== EXAM_ID ||
        attempt.candidateId !== session.candidateId ||
        attempt.examId !== EXAM_ID ||
        attempt.attemptId !== session.attemptId ||
        snapshot.candidateId !== session.candidateId ||
        snapshot.examId !== EXAM_ID ||
        snapshot.registrationNumber !== attempt.registrationNumber
      ) {
        throw Object.assign(new Error("ATTEMPT_IDENTITY_MISMATCH"), { status: 403 });
      }

      if (attempt.status === "submitted") {
        return {
          alreadySubmitted: true,
          submittedAt: toMillis(attempt.submittedAt)
            ? new Date(toMillis(attempt.submittedAt)).toISOString()
            : null
        };
      }

      if (attempt.status === "expired") {
        throw Object.assign(new Error("ATTEMPT_EXPIRED"), { status: 409 });
      }
      if (attempt.status !== "in_progress") {
        throw Object.assign(new Error("ATTEMPT_NOT_ACTIVE"), { status: 409 });
      }

      const deadline = toMillis(attempt.deadlineAt);
      if (!deadline) {
        throw Object.assign(new Error("INVALID_ATTEMPT_DEADLINE"), { status: 409 });
      }

      const answerMap = {};
      for (const doc of answersSnap.docs) {
        const data = doc.data() || {};
        if (
          data.attemptId === session.attemptId &&
          data.candidateId === session.candidateId
        ) {
          answerMap[doc.id] = { selectedOption: data.selectedOption ?? null };
        }
      }

      const scores = calculateScores(snapshot.questions || {}, answerMap);
      const now = Date.now();
      const submittedAt = admin.firestore.FieldValue.serverTimestamp();

      tx.update(attemptRef, {
        status: "submitted",
        submittedAt,
        updatedAt: submittedAt,
        submissionReason: now >= deadline ? "TIME_EXPIRED" : "CANDIDATE_SUBMITTED",
        results: scores,
        answerCount: scores.totalAnswered,
        totalScore: scores.totalScore,
        percentage: scores.percentage
      });

      // Revoke the candidate's active session once the attempt is finalized.
      tx.delete(sessionRef);

      return {
        alreadySubmitted: false,
        submittedAt: new Date(now).toISOString()
      };
    });

    return send(res, 200, {
      ok: true,
      code: final.alreadySubmitted ? "ATTEMPT_ALREADY_SUBMITTED" : "EXAM_SUBMITTED",
      attemptId: session.attemptId,
      submittedAt: final.submittedAt
    });
  } catch (error) {
    const code = String(error.code || error.message || "EXAM_SUBMISSION_FAILED");
    const known = {
      SESSION_REQUIRED: 401,
      INVALID_SESSION: 401,
      SESSION_NOT_FOUND: 401,
      SESSION_SECRET_NOT_CONFIGURED: 503,
      ATTEMPT_NOT_FOUND: 404,
      QUESTION_SNAPSHOT_NOT_FOUND: 409,
      ATTEMPT_IDENTITY_MISMATCH: 403,
      ATTEMPT_NOT_ACTIVE: 409,
      ATTEMPT_EXPIRED: 409,
      INVALID_ATTEMPT_DEADLINE: 409,
      INVALID_QUESTION_SNAPSHOT: 409,
      INVALID_ANSWER_KEY: 409
    };

    if (known[code]) return send(res, known[code], { ok: false, code });
    console.error("CBT SUBMISSION ERROR:", error);
    return send(res, 500, { ok: false, code: "EXAM_SUBMISSION_FAILED" });
  }
};
