
"use strict";

const crypto = require("crypto");
const { getFirestore, admin } = require("../../lib/firebase-admin");

const EXAM_ID = process.env.CBT_EXAM_ID || "jamb-2026-11-28";
const MAX_ATTEMPTS = 25;

function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(status).json(body);
}

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  const supplied = String(req.headers.authorization || "");

  if (!secret || secret.length < 32) return false;
  if (!supplied.startsWith("Bearer ")) return false;

  const a = Buffer.from(supplied.slice(7));
  const b = Buffer.from(secret);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function toMillis(value) {
  if (!value) return null;

  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (typeof value.toDate === "function") {
    return value.toDate().getTime();
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function calculateScores(snapshot, answerDocs, attemptId, candidateId) {
  const subjects = snapshot.subjects || [];
  const questionsBySubject = snapshot.questions || {};

  if (
    subjects.length !== 4 ||
    new Set(subjects).size !== 4
  ) {
    throw new Error("INVALID_QUESTION_SNAPSHOT_SUBJECTS");
  }

  const subjectScores = {};
  const seenQuestionIds = new Set();

  let totalCorrect = 0;
  let totalAnswered = 0;
  let totalQuestions = 0;

  for (const subject of subjects) {
    const questions = questionsBySubject[subject];

    if (!Array.isArray(questions) || questions.length !== 40) {
      throw new Error("INVALID_QUESTION_SNAPSHOT_" + subject);
    }

    let correct = 0;
    let answered = 0;

    for (const question of questions) {
      const answerKey = String(question.answer || "").toUpperCase();

      if (
        !question.id ||
        !["A", "B", "C", "D"].includes(answerKey)
      ) {
        throw new Error("INVALID_QUESTION_ANSWER_KEY");
      }

      if (seenQuestionIds.has(question.id)) {
        throw new Error("DUPLICATE_QUESTION_ID");
      }

      seenQuestionIds.add(question.id);

      const saved = answerDocs[question.id];

      if (
        !saved ||
        saved.attemptId !== attemptId ||
        saved.candidateId !== candidateId
      ) {
        continue;
      }

      const selected = saved.selectedOption;

      if (selected === null || selected === undefined || selected === "") {
        continue;
      }

      const choice = String(selected).toUpperCase();

      if (!["A", "B", "C", "D"].includes(choice)) {
        continue;
      }

      answered++;

      if (choice === answerKey) {
        correct++;
      }
    }

    subjectScores[subject] = {
      totalQuestions: 40,
      answered,
      unanswered: 40 - answered,
      correct,
      incorrect: answered - correct,
      score: correct,
      percentage: Number((correct / 40 * 100).toFixed(2))
    };

    totalQuestions += 40;
    totalAnswered += answered;
    totalCorrect += correct;
  }

  if (totalQuestions !== 160) {
    throw new Error("INVALID_TOTAL_QUESTIONS");
  }

  return {
    subjectScores,
    totalQuestions,
    totalAnswered,
    totalUnanswered: totalQuestions - totalAnswered,
    totalCorrect,
    totalIncorrect: totalAnswered - totalCorrect,
    totalScore: totalCorrect,
    percentage: Number((totalCorrect / 160 * 100).toFixed(2))
  };
}

async function finalizeAttempt(db, attemptRef, now) {
  const privateRef = attemptRef.collection("private");
  const questionRef = privateRef.doc("question_snapshot");
  const sessionRef = privateRef.doc("session");
  const answersRef = attemptRef.collection("answers");

  return db.runTransaction(async tx => {
    // Read the attempt first.
    const attemptSnap = await tx.get(attemptRef);

    if (!attemptSnap.exists) {
      return { result: "missing" };
    }

    const attempt = attemptSnap.data() || {};

    if (attempt.status === "submitted") {
      return { result: "already_submitted" };
    }

    if (attempt.status !== "in_progress") {
      return { result: "not_active" };
    }

    if (
      attempt.examId !== EXAM_ID ||
      attempt.attemptId !== attemptRef.id ||
      !attempt.candidateId
    ) {
      throw new Error("ATTEMPT_IDENTITY_INVALID");
    }

    const deadline = toMillis(attempt.deadlineAt);

    if (!deadline) {
      throw new Error("INVALID_DEADLINE");
    }

    if (now < deadline) {
      return { result: "not_due" };
    }

    // Read all remaining documents before writing.
    const [questionSnap, answersSnap, sessionSnap] =
      await Promise.all([
        tx.get(questionRef),
        tx.get(answersRef),
        tx.get(sessionRef)
      ]);

    if (!questionSnap.exists) {
      throw new Error("QUESTION_SNAPSHOT_MISSING");
    }

    const questionSnapshot = questionSnap.data() || {};

    if (
      questionSnapshot.examId !== EXAM_ID ||
      questionSnapshot.candidateId !== attempt.candidateId ||
      questionSnapshot.registrationNumber !== attempt.registrationNumber
    ) {
      throw new Error("QUESTION_SNAPSHOT_IDENTITY_MISMATCH");
    }

    const answerDocs = {};

    for (const doc of answersSnap.docs) {
      answerDocs[doc.id] = doc.data() || {};
    }

    const scores = calculateScores(
      questionSnapshot,
      answerDocs,
      attemptRef.id,
      attempt.candidateId
    );

    const timestamp =
      admin.firestore.FieldValue.serverTimestamp();

    tx.update(attemptRef, {
      status: "submitted",
      submittedAt: timestamp,
      updatedAt: timestamp,

      submissionReason: "TIME_EXPIRED",
      finalizedBy: "server_scheduler",

      results: scores,
      answerCount: scores.totalAnswered,
      totalScore: scores.totalScore,
      percentage: scores.percentage
    });

    // Revoke the active candidate session.
    if (sessionSnap.exists) {
      tx.delete(sessionRef);
    }

    return {
      result: "finalized",
      attemptId: attemptRef.id,
      totalScore: scores.totalScore,
      totalQuestions: scores.totalQuestions
    };
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");

    return send(res, 405, {
      ok: false,
      code: "METHOD_NOT_ALLOWED"
    });
  }

  if (!authorized(req)) {
    return send(res, 401, {
      ok: false,
      code: "UNAUTHORIZED"
    });
  }

  try {
    const db = getFirestore();
    const now = Date.now();

    const activeAttempts = await db
      .collection("cbt_attempts")
      .where("status", "==", "in_progress")
      .limit(100)
      .get();

    const dueAttempts = activeAttempts.docs
      .filter(doc => {
        const deadline = toMillis(
          doc.data().deadlineAt
        );

        return deadline !== null && deadline <= now;
      })
      .slice(0, MAX_ATTEMPTS);

    const counts = {
      scanned: activeAttempts.size,
      due: dueAttempts.length,
      finalized: 0,
      alreadySubmitted: 0,
      notDue: 0,
      failed: 0
    };

    const failures = [];
    const finalized = [];

    for (const doc of dueAttempts) {
      try {
        const result = await finalizeAttempt(
          db,
          doc.ref,
          now
        );

        if (result.result === "finalized") {
          counts.finalized++;
          finalized.push(result);
        } else if (result.result === "already_submitted") {
          counts.alreadySubmitted++;
        } else if (result.result === "not_due") {
          counts.notDue++;
        }

      } catch (error) {
        counts.failed++;

        failures.push({
          attemptId: doc.id,
          code: String(error.message || "FINALIZATION_FAILED")
            .slice(0, 120)
        });

        console.error(
          "CBT FINALIZER ATTEMPT ERROR:",
          doc.id,
          error
        );
      }
    }

    return send(res, counts.failed ? 207 : 200, {
      ok: counts.failed === 0,
      code: counts.failed
        ? "FINALIZATION_PARTIAL"
        : "FINALIZATION_CHECK_COMPLETE",

      checkedAt: new Date(now).toISOString(),
      counts,
      finalized,
      failures
    });

  } catch (error) {
    console.error("CBT FINALIZER ERROR:", error);

    return send(res, 500, {
      ok: false,
      code: "FINALIZER_FAILED"
    });
  }
};
