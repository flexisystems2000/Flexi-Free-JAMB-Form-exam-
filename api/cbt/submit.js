"use strict";

const { getFirestore, admin } = require("../../lib/firebase-admin");
const {
  requireCandidateSession,
  CbtAuthError
} = require("../../lib/cbt-auth");

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
      if (
        !question.id ||
        !["A", "B", "C", "D"].includes(key)
      ) throw new Error("INVALID_ANSWER_KEY");

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
    const session = await requireCandidateSession(req);
    if (session.examId !== EXAM_ID) {
      return send(res, 403, { ok: false, code: "SESSION_EXAM_MISMATCH" });
    }

    const db = getFirestore();
    const attemptRef = db.collection("cbt_attempts").doc(session.attemptId);
    const snapshotRef = attemptRef.collection("private").doc("question_snapshot");
    const answersRef = attemptRef.collection("answers");

    const final = await db.runTransaction(async tx => {
      // Read all transaction inputs before writing. This ensures an answer
      // save racing with submission either commits first or is rejected.
      const [attemptSnap, questionSnap, answersSnap] = await Promise.all([
        tx.get(attemptRef),
        tx.get(snapshotRef),
        tx.get(answersRef)
      ]);

      if (!attemptSnap.exists) throw Object.assign(new Error("ATTEMPT_NOT_FOUND"), { status: 404 });
      if (!questionSnap.exists) throw Object.assign(new Error("QUESTION_SNAPSHOT_NOT_FOUND"), { status: 409 });

      const attempt = attemptSnap.data() || {};
      const snapshot = questionSnap.data() || {};

      if (
        attempt.candidateId !== session.candidateId ||
        attempt.examId !== EXAM_ID ||
        attempt.attemptId !== session.attemptId ||
        snapshot.candidateId !== session.candidateId ||
        snapshot.examId !== EXAM_ID
      ) throw Object.assign(new Error("ATTEMPT_IDENTITY_MISMATCH"), { status: 403 });

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
      if (!deadline) throw Object.assign(new Error("INVALID_ATTEMPT_DEADLINE"), { status: 409 });

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

      // Manual submit is allowed before the deadline. If the endpoint is
      // invoked at/after the deadline, it finalizes the attempt as well.
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

      return {
        alreadySubmitted: false,
        submittedAt: new Date(now).toISOString()
      };
    });

    // Candidate receives a receipt only. Detailed scores remain server-side
    // until an authorized results-release process is implemented.
    return send(res, 200, {
      ok: true,
      code: final.alreadySubmitted ? "ATTEMPT_ALREADY_SUBMITTED" : "EXAM_SUBMITTED",
      attemptId: session.attemptId,
      submittedAt: final.submittedAt
    });
  } catch (error) {
    if (error instanceof CbtAuthError) {
      return send(res, error.status || 401, { ok: false, code: error.code });
    }
    const code = String(error.message || "");
    const known = {
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
