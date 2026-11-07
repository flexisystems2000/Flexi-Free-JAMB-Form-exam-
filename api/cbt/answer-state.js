"use strict";

const { getFirestore, admin } = require("../../lib/firebase-admin");
const {
  requireCandidateSession,
  CbtAuthError
} = require("../../lib/cbt-auth");

const EXAM_ID = process.env.CBT_EXAM_ID || "jamb-2026-11-28";

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

    const [attemptSnap, snapshotDoc] = await Promise.all([
      attemptRef.get(),
      snapshotRef.get()
    ]);

    if (!attemptSnap.exists) return send(res, 404, { ok: false, code: "ATTEMPT_NOT_FOUND" });
    if (!snapshotDoc.exists) return send(res, 409, { ok: false, code: "QUESTION_SNAPSHOT_NOT_FOUND" });

    const attempt = attemptSnap.data() || {};
    const snapshot = snapshotDoc.data() || {};

    if (
      attempt.candidateId !== session.candidateId ||
      attempt.examId !== EXAM_ID ||
      snapshot.candidateId !== session.candidateId ||
      snapshot.examId !== EXAM_ID
    ) {
      return send(res, 403, { ok: false, code: "ATTEMPT_IDENTITY_MISMATCH" });
    }

    if (attempt.status === "submitted") {
      return send(res, 409, { ok: false, code: "ATTEMPT_ALREADY_SUBMITTED" });
    }
    if (attempt.status === "expired") {
      return send(res, 409, { ok: false, code: "ATTEMPT_EXPIRED" });
    }
    if (attempt.status !== "in_progress") {
      return send(res, 409, { ok: false, code: "ATTEMPT_NOT_ACTIVE" });
    }

    const deadline = toMillis(attempt.deadlineAt);
    if (!deadline) return send(res, 409, { ok: false, code: "INVALID_ATTEMPT_DEADLINE" });

    if (Date.now() >= deadline) {
      await attemptRef.update({
        status: "expired",
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        expiryReason: "BATCH_DEADLINE_REACHED"
      });
      return send(res, 409, { ok: false, code: "ATTEMPT_EXPIRED" });
    }

    const subjects = Array.isArray(snapshot.subjects) ? snapshot.subjects : [];
    const questionIds = [];

    for (const subject of subjects) {
      const questions = snapshot.questions?.[subject];
      if (!Array.isArray(questions)) {
        return send(res, 409, { ok: false, code: "INVALID_QUESTION_SNAPSHOT" });
      }
      for (const q of questions) {
        if (!q.id) return send(res, 409, { ok: false, code: "INVALID_QUESTION_SNAPSHOT" });
        questionIds.push(q.id);
      }
    }

    const answerSnap = await attemptRef.collection("answers").get();
    const validIds = new Set(questionIds);
    const savedAnswers = {};

    for (const doc of answerSnap.docs) {
      if (!validIds.has(doc.id)) continue;
      const data = doc.data() || {};
      if (
        data.attemptId !== session.attemptId ||
        data.candidateId !== session.candidateId
      ) continue;

      savedAnswers[doc.id] = {
        questionId: doc.id,
        selectedOption: data.selectedOption ?? null,
        subject: data.subject || null,
        savedAt: toMillis(data.savedAt)
          ? new Date(toMillis(data.savedAt)).toISOString()
          : null
      };
    }

    const answeredCount = Object.values(savedAnswers)
      .filter(a => a.selectedOption !== null).length;

    return send(res, 200, {
      ok: true,
      code: "ANSWER_STATE_RESTORED",
      attemptId: session.attemptId,
      status: attempt.status,
      deadlineAt: new Date(deadline).toISOString(),
      serverTime: new Date().toISOString(),
      totalQuestions: questionIds.length,
      answeredCount,
      unansweredCount: questionIds.length - answeredCount,
      answers: savedAnswers
    });
  } catch (error) {
    if (error instanceof CbtAuthError) {
      return send(res, error.status || 401, { ok: false, code: error.code });
    }
    console.error("CBT ANSWER STATE ERROR:", error);
    return send(res, 500, { ok: false, code: "ANSWER_STATE_LOAD_FAILED" });
  }
};
