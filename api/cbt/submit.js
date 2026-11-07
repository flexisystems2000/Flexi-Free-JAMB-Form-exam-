
"use strict";

const {
  getFirestore,
  admin
} = require("../../lib/firebase-admin");

const EXAM_ID =
  process.env.CBT_EXAM_ID || "jamb-2026-11-28";

const SUBJECT_QUESTION_COUNT = 40;

function send(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  return res.status(status).json(payload);
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function getLookup(body) {
  return String(
    body?.whatsappNumber ||
    body?.registrationNumber ||
    ""
  ).trim();
}

function validDate(value) {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    return value.toDate();
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

async function findCandidate(db, lookup) {
  const registrations = await db
    .collection("jamb_registrations")
    .get();

  const phone = normalizePhone(lookup);
  const registration = lookup.toUpperCase();
  const matches = [];

  for (const doc of registrations.docs) {
    const data = doc.data();

    const phoneMatches =
      phone &&
      normalizePhone(data.whatsappNumber) === phone;

    const registrationMatches =
      String(data.registrationNumber || "")
        .trim()
        .toUpperCase() === registration;

    if (phoneMatches || registrationMatches) {
      matches.push({
        id: doc.id,
        ...data
      });
    }
  }

  if (matches.length === 0) {
    return { error: "CANDIDATE_NOT_FOUND" };
  }

  if (matches.length > 1) {
    return { error: "AMBIGUOUS_CANDIDATE" };
  }

  return { candidate: matches[0] };
}

function calculateScores(questions, answers) {
  const subjectScores = {};
  let totalCorrect = 0;
  let totalQuestions = 0;
  let totalAnswered = 0;

  for (const [subject, subjectQuestions] of Object.entries(questions)) {
    if (
      !Array.isArray(subjectQuestions) ||
      subjectQuestions.length !== SUBJECT_QUESTION_COUNT
    ) {
      throw new Error("INVALID_QUESTION_SNAPSHOT");
    }

    let correct = 0;
    let answered = 0;

    for (const question of subjectQuestions) {
      if (
        !question.id ||
        !["A", "B", "C", "D"].includes(
          String(question.answer || "").toUpperCase()
        )
      ) {
        throw new Error("INVALID_ANSWER_KEY");
      }

      const selected = answers[question.id]?.selectedOption;

      if (
        selected &&
        ["A", "B", "C", "D"].includes(
          String(selected).toUpperCase()
        )
      ) {
        answered++;

        if (
          String(selected).toUpperCase() ===
          String(question.answer).toUpperCase()
        ) {
          correct++;
        }
      }
    }

    subjectScores[subject] = {
      totalQuestions: subjectQuestions.length,
      answered,
      unanswered: subjectQuestions.length - answered,
      correct,
      incorrect: answered - correct,
      score: correct,
      percentage: Number(
        ((correct / subjectQuestions.length) * 100).toFixed(2)
      )
    };

    totalCorrect += correct;
    totalAnswered += answered;
    totalQuestions += subjectQuestions.length;
  }

  return {
    subjectScores,
    totalQuestions,
    totalAnswered,
    totalUnanswered: totalQuestions - totalAnswered,
    totalCorrect,
    totalIncorrect: totalAnswered - totalCorrect,
    totalScore: totalCorrect,
    percentage: Number(
      ((totalCorrect / totalQuestions) * 100).toFixed(2)
    )
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return send(res, 405, {
      ok: false,
      code: "METHOD_NOT_ALLOWED"
    });
  }

  const lookup = getLookup(req.body);

  if (!lookup || lookup.length > 40) {
    return send(res, 400, {
      ok: false,
      code: "INVALID_LOOKUP"
    });
  }

  try {
    const db = getFirestore();

    // 1. Find candidate.
    const result = await findCandidate(db, lookup);

    if (result.error) {
      return send(
        res,
        result.error === "CANDIDATE_NOT_FOUND" ? 404 : 409,
        {
          ok: false,
          code: result.error
        }
      );
    }

    const candidate = result.candidate;

    // 2. Locate attempt.
    const attemptId = `${EXAM_ID}_${candidate.id}`;

    const attemptRef = db
      .collection("cbt_attempts")
      .doc(attemptId);

    const snapshotRef = attemptRef
      .collection("private")
      .doc("question_snapshot");

    // 3. Load private question snapshot.
    const snapshotDoc = await snapshotRef.get();

    if (!snapshotDoc.exists) {
      return send(res, 409, {
        ok: false,
        code: "QUESTION_SNAPSHOT_NOT_FOUND"
      });
    }

    const snapshot = snapshotDoc.data();

    if (
      snapshot.candidateId !== candidate.id ||
      snapshot.examId !== EXAM_ID ||
      snapshot.registrationNumber !== candidate.registrationNumber
    ) {
      return send(res, 403, {
        ok: false,
        code: "QUESTION_SNAPSHOT_IDENTITY_MISMATCH"
      });
    }

    // 4. Load saved answers.
    const answersSnapshot = await attemptRef
      .collection("answers")
      .get();

    const savedAnswers = {};

    for (const doc of answersSnapshot.docs) {
      const data = doc.data();

      if (
        data.attemptId === attemptId &&
        data.candidateId === candidate.id
      ) {
        savedAnswers[doc.id] = {
          selectedOption: data.selectedOption || null
        };
      }
    }

    // 5. Calculate marks on the server.
    const scores = calculateScores(
      snapshot.questions || {},
      savedAnswers
    );

    // 6. Finalize atomically.
    const finalResult = await db.runTransaction(
      async transaction => {
        const attemptDoc = await transaction.get(attemptRef);

        if (!attemptDoc.exists) {
          throw new Error("ATTEMPT_NOT_FOUND");
        }

        const attempt = attemptDoc.data();

        if (
          attempt.candidateId !== candidate.id ||
          attempt.registrationNumber !== candidate.registrationNumber ||
          attempt.examId !== EXAM_ID
        ) {
          throw new Error("ATTEMPT_IDENTITY_MISMATCH");
        }

        // Idempotent response for an already submitted attempt.
        if (attempt.status === "submitted") {
          return {
            alreadySubmitted: true,
            scores: attempt.results || null,
            submittedAt: validDate(attempt.submittedAt)
              ?.toISOString() || null
          };
        }

        if (attempt.status === "expired") {
          throw new Error("ATTEMPT_EXPIRED");
        }

        if (attempt.status !== "in_progress") {
          throw new Error("ATTEMPT_NOT_ACTIVE");
        }

        const deadlineAt = validDate(attempt.deadlineAt);

        if (!deadlineAt) {
          throw new Error("INVALID_ATTEMPT_DEADLINE");
        }

        const now = Date.now();

        // A candidate cannot submit after the official deadline.
        if (now >= deadlineAt.getTime()) {
          transaction.update(attemptRef, {
            status: "expired",
            expiredAt:
              admin.firestore.FieldValue.serverTimestamp(),
            updatedAt:
              admin.firestore.FieldValue.serverTimestamp()
          });

          throw new Error("ATTEMPT_EXPIRED");
        }

        const serverTimestamp =
          admin.firestore.FieldValue.serverTimestamp();

        transaction.update(attemptRef, {
          status: "submitted",
          submittedAt: serverTimestamp,
          updatedAt: serverTimestamp,
          results: scores,
          answerCount: scores.totalAnswered,
          totalScore: scores.totalScore,
          percentage: scores.percentage
        });

        return {
          alreadySubmitted: false,
          scores,
          submittedAt: new Date(now).toISOString()
        };
      }
    );

    // 7. Return result summary.
    return send(res, 200, {
      ok: true,
      code: finalResult.alreadySubmitted
        ? "ATTEMPT_ALREADY_SUBMITTED"
        : "EXAM_SUBMITTED",
      attemptId,
      submittedAt: finalResult.submittedAt,
      results: finalResult.scores
    });

  } catch (error) {
    const code = String(error.message || "");

    const errors = {
      ATTEMPT_NOT_FOUND: [404, "ATTEMPT_NOT_FOUND"],
      ATTEMPT_NOT_ACTIVE: [409, "ATTEMPT_NOT_ACTIVE"],
      ATTEMPT_IDENTITY_MISMATCH: [403, "ATTEMPT_IDENTITY_MISMATCH"],
      INVALID_ATTEMPT_DEADLINE: [409, "INVALID_ATTEMPT_DEADLINE"],
      ATTEMPT_EXPIRED: [409, "ATTEMPT_EXPIRED"],
      INVALID_QUESTION_SNAPSHOT: [409, "INVALID_QUESTION_SNAPSHOT"],
      INVALID_ANSWER_KEY: [409, "INVALID_ANSWER_KEY"]
    };

    if (errors[code]) {
      return send(res, errors[code][0], {
        ok: false,
        code: errors[code][1]
      });
    }

    console.error("CBT SUBMISSION ERROR:", error);

    return send(res, 500, {
      ok: false,
      code: "EXAM_SUBMISSION_FAILED"
    });
  }
};
