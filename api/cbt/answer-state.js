
"use strict";

const {
  getFirestore,
  admin
} = require("../../lib/firebase-admin");

const EXAM_ID =
  process.env.CBT_EXAM_ID || "jamb-2026-11-28";

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

    // 2. Locate candidate's examination attempt.
    const attemptId = `${EXAM_ID}_${candidate.id}`;

    const attemptRef = db
      .collection("cbt_attempts")
      .doc(attemptId);

    const attemptDoc = await attemptRef.get();

    if (!attemptDoc.exists) {
      return send(res, 404, {
        ok: false,
        code: "ATTEMPT_NOT_FOUND"
      });
    }

    const attempt = attemptDoc.data();

    // 3. Verify ownership.
    if (
      attempt.candidateId !== candidate.id ||
      attempt.registrationNumber !==
        candidate.registrationNumber ||
      attempt.examId !== EXAM_ID
    ) {
      return send(res, 403, {
        ok: false,
        code: "ATTEMPT_IDENTITY_MISMATCH"
      });
    }

    // 4. Check attempt status.
    if (attempt.status === "submitted") {
      return send(res, 409, {
        ok: false,
        code: "ATTEMPT_ALREADY_SUBMITTED"
      });
    }

    if (attempt.status === "expired") {
      return send(res, 409, {
        ok: false,
        code: "ATTEMPT_EXPIRED"
      });
    }

    if (attempt.status !== "in_progress") {
      return send(res, 409, {
        ok: false,
        code: "ATTEMPT_NOT_ACTIVE"
      });
    }

    // 5. Enforce original deadline.
    const deadlineAt = validDate(attempt.deadlineAt);

    if (!deadlineAt) {
      return send(res, 409, {
        ok: false,
        code: "INVALID_ATTEMPT_DEADLINE"
      });
    }

    if (Date.now() >= deadlineAt.getTime()) {
      await attemptRef.update({
        status: "expired",
        expiredAt:
          admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      });

      return send(res, 409, {
        ok: false,
        code: "ATTEMPT_EXPIRED"
      });
    }

    // 6. Load the saved question snapshot.
    const snapshotRef = attemptRef
      .collection("private")
      .doc("question_snapshot");

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
      snapshot.examId !== EXAM_ID
    ) {
      return send(res, 403, {
        ok: false,
        code: "QUESTION_SNAPSHOT_IDENTITY_MISMATCH"
      });
    }

    // 7. Read saved answers.
    const answersSnapshot = await attemptRef
      .collection("answers")
      .get();

    const savedAnswers = {};

    for (const doc of answersSnapshot.docs) {
      const data = doc.data();

      if (
        data.attemptId !== attemptId ||
        data.candidateId !== candidate.id
      ) {
        continue;
      }

      savedAnswers[doc.id] = {
        questionId: doc.id,
        selectedOption: data.selectedOption || null,
        subject: data.subject,
        savedAt: validDate(data.savedAt)?.toISOString() || null
      };
    }

    // 8. Count answered and unanswered questions.
    const subjects = Array.isArray(snapshot.subjects)
      ? snapshot.subjects
      : [];

    const questionIds = [];

    for (const subject of subjects) {
      const questions = snapshot.questions?.[subject];

      if (!Array.isArray(questions)) {
        return send(res, 409, {
          ok: false,
          code: "INVALID_QUESTION_SNAPSHOT"
        });
      }

      for (const question of questions) {
        questionIds.push(question.id);
      }
    }

    const validQuestionIds = new Set(questionIds);

    const filteredAnswers = {};

    for (const [questionId, answer] of Object.entries(savedAnswers)) {
      if (validQuestionIds.has(questionId)) {
        filteredAnswers[questionId] = answer;
      }
    }

    const answeredCount = Object.values(filteredAnswers)
      .filter(answer => answer.selectedOption !== null)
      .length;

    const totalQuestions = questionIds.length;

    // 9. Return restored progress.
    return send(res, 200, {
      ok: true,
      code: "ANSWER_STATE_RESTORED",
      attemptId,
      status: attempt.status,
      deadlineAt: deadlineAt.toISOString(),
      serverTime: new Date().toISOString(),
      totalQuestions,
      answeredCount,
      unansweredCount: totalQuestions - answeredCount,
      answers: filteredAnswers
    });

  } catch (error) {
    console.error("CBT ANSWER STATE ERROR:", error);

    return send(res, 500, {
      ok: false,
      code: "ANSWER_STATE_LOAD_FAILED"
    });
  }
};
