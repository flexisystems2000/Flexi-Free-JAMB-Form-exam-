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

function validatePayload(answers) {
  if (!Array.isArray(answers) || answers.length < 1) return "INVALID_ANSWERS";
  if (answers.length > 40) return "TOO_MANY_ANSWERS";

  const seen = new Set();
  for (const item of answers) {
    if (
      !item ||
      typeof item.questionId !== "string" ||
      !item.questionId.trim() ||
      item.questionId.length > 150
    ) return "INVALID_QUESTION_ID";

    if (seen.has(item.questionId)) return "DUPLICATE_QUESTION_ID";
    seen.add(item.questionId);

    if (
      item.selectedOption !== null &&
      !["A", "B", "C", "D"].includes(String(item.selectedOption).toUpperCase())
    ) return "INVALID_SELECTED_OPTION";
  }
  return null;
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

  const answers = req.body?.answers;
  const validationError = validatePayload(answers);
  if (validationError) return send(res, 400, { ok: false, code: validationError });

  try {
    const session = await requireCandidateSession(req);
    if (session.examId !== EXAM_ID) {
      return send(res, 403, { ok: false, code: "SESSION_EXAM_MISMATCH" });
    }

    const db = getFirestore();
    const attemptRef = db.collection("cbt_attempts").doc(session.attemptId);
    const snapshotRef = attemptRef.collection("private").doc("question_snapshot");
    const snapshotDoc = await snapshotRef.get();

    if (!snapshotDoc.exists) {
      return send(res, 409, { ok: false, code: "QUESTION_SNAPSHOT_NOT_FOUND" });
    }

    const snapshot = snapshotDoc.data() || {};
    if (
      snapshot.candidateId !== session.candidateId ||
      snapshot.examId !== EXAM_ID ||
      !Array.isArray(snapshot.subjects)
    ) {
      return send(res, 403, { ok: false, code: "QUESTION_SNAPSHOT_IDENTITY_MISMATCH" });
    }

    const questionMap = new Map();
    for (const subject of snapshot.subjects) {
      for (const q of snapshot.questions?.[subject] || []) {
        if (!q.id) return send(res, 409, { ok: false, code: "INVALID_QUESTION_SNAPSHOT" });
        questionMap.set(q.id, subject);
      }
    }

    for (const item of answers) {
      if (!questionMap.has(item.questionId)) {
        return send(res, 400, {
          ok: false,
          code: "QUESTION_NOT_IN_ATTEMPT",
          questionId: item.questionId
        });
      }
    }

    const answerRefs = answers.map(item =>
      attemptRef.collection("answers").doc(item.questionId)
    );

    const result = await db.runTransaction(async tx => {
      const attemptSnap = await tx.get(attemptRef);
      if (!attemptSnap.exists) {
        throw Object.assign(new Error("ATTEMPT_NOT_FOUND"), { status: 404 });
      }

      const attempt = attemptSnap.data() || {};
      if (
        attempt.candidateId !== session.candidateId ||
        attempt.examId !== EXAM_ID ||
        attempt.attemptId !== session.attemptId
      ) {
        throw Object.assign(new Error("ATTEMPT_IDENTITY_MISMATCH"), { status: 403 });
      }

      if (attempt.status !== "in_progress") {
        throw Object.assign(new Error("ATTEMPT_NOT_ACTIVE"), { status: 409 });
      }

      const deadline = toMillis(attempt.deadlineAt);
      if (!deadline) {
        throw Object.assign(new Error("INVALID_ATTEMPT_DEADLINE"), { status: 409 });
      }

      if (Date.now() >= deadline) {
        // Leave finalization to submit.js; never set "expired" without scoring.
        return { expired: true, saved: [] };
      }

      const previous = [];
      for (const ref of answerRefs) previous.push(await tx.get(ref));

      const stamp = admin.firestore.FieldValue.serverTimestamp();
      const saved = [];

      answers.forEach((item, index) => {
        const selectedOption = item.selectedOption === null
          ? null
          : String(item.selectedOption).toUpperCase();

        const data = {
          attemptId: session.attemptId,
          candidateId: session.candidateId,
          questionId: item.questionId,
          subject: questionMap.get(item.questionId),
          selectedOption,
          savedAt: stamp
        };

        if (previous[index].exists) tx.update(answerRefs[index], data);
        else tx.create(answerRefs[index], data);

        saved.push({ questionId: item.questionId, selectedOption });
      });

      tx.update(attemptRef, {
        lastAnswerSavedAt: stamp,
        updatedAt: stamp
      });

      return { expired: false, saved };
    });

    if (result.expired) {
      return send(res, 409, { ok: false, code: "EXAM_TIME_EXPIRED" });
    }

    return send(res, 200, {
      ok: true,
      code: "ANSWERS_SAVED",
      savedCount: result.saved.length,
      answers: result.saved
    });
  } catch (error) {
    if (error instanceof CbtAuthError) {
      return send(res, error.status || 401, { ok: false, code: error.code });
    }

    const code = String(error.message || "");
    const known = {
      ATTEMPT_NOT_FOUND: 404,
      ATTEMPT_IDENTITY_MISMATCH: 403,
      ATTEMPT_NOT_ACTIVE: 409,
      INVALID_ATTEMPT_DEADLINE: 409
    };

    if (known[code]) return send(res, known[code], { ok: false, code });
    console.error("CBT ANSWERS ERROR:", error);
    return send(res, 500, { ok: false, code: "ANSWERS_SAVE_FAILED" });
  }
};
