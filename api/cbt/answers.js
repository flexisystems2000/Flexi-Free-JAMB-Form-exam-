
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

function getQuestionMap(snapshot, subjects) {
  const map = new Map();

  for (const subject of subjects) {
    const questions = snapshot[subject];

    if (!Array.isArray(questions)) {
      throw new Error("INVALID_QUESTION_SNAPSHOT");
    }

    for (const question of questions) {
      if (!question.id) {
        throw new Error("INVALID_QUESTION_ID");
      }

      map.set(question.id, {
        ...question,
        subject
      });
    }
  }

  return map;
}

function validateAnswerPayload(answers) {
  if (!Array.isArray(answers) || answers.length < 1) {
    return "INVALID_ANSWERS";
  }

  if (answers.length > 40) {
    return "TOO_MANY_ANSWERS";
  }

  const seen = new Set();

  for (const item of answers) {
    if (
      !item ||
      typeof item.questionId !== "string" ||
      !item.questionId.trim() ||
      item.questionId.length > 150
    ) {
      return "INVALID_QUESTION_ID";
    }

    if (seen.has(item.questionId)) {
      return "DUPLICATE_QUESTION_ID";
    }

    seen.add(item.questionId);

    if (
      item.selectedOption !== null &&
      !["A", "B", "C", "D"].includes(
        String(item.selectedOption).toUpperCase()
      )
    ) {
      return "INVALID_SELECTED_OPTION";
    }
  }

  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return send(res, 405, {
      ok: false,
      code: "METHOD_NOT_ALLOWED"
    });
  }

  const lookup = getLookup(req.body);
  const answers = req.body?.answers;

  if (!lookup || lookup.length > 40) {
    return send(res, 400, {
      ok: false,
      code: "INVALID_LOOKUP"
    });
  }

  const validationError = validateAnswerPayload(answers);

  if (validationError) {
    return send(res, 400, {
      ok: false,
      code: validationError
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

    // 2. Locate deterministic attempt.
    const attemptId = `${EXAM_ID}_${candidate.id}`;

    const attemptRef = db
      .collection("cbt_attempts")
      .doc(attemptId);

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

    const snapshotData = snapshotDoc.data();

    if (
      snapshotData.candidateId !== candidate.id ||
      snapshotData.examId !== EXAM_ID ||
      snapshotData.registrationNumber !==
        candidate.registrationNumber
    ) {
      return send(res, 403, {
        ok: false,
        code: "QUESTION_SNAPSHOT_IDENTITY_MISMATCH"
      });
    }

    const subjects = Array.isArray(snapshotData.subjects)
      ? snapshotData.subjects
      : [];

    const questionMap = getQuestionMap(
      snapshotData.questions || {},
      subjects
    );

    // 3. Validate that every question belongs to this exam.
    for (const item of answers) {
      if (!questionMap.has(item.questionId)) {
        return send(res, 400, {
          ok: false,
          code: "QUESTION_NOT_IN_ATTEMPT",
          questionId: item.questionId
        });
      }
    }

    // 4. Save answers atomically while checking attempt status.
    const answerRefs = answers.map(item =>
      attemptRef
        .collection("answers")
        .doc(item.questionId)
    );

    const savedAnswers = await db.runTransaction(
      async transaction => {
        const attemptDoc = await transaction.get(attemptRef);

        if (!attemptDoc.exists) {
          throw new Error("ATTEMPT_NOT_FOUND");
        }

        const attempt = attemptDoc.data();

        if (
          attempt.candidateId !== candidate.id ||
          attempt.registrationNumber !==
            candidate.registrationNumber ||
          attempt.examId !== EXAM_ID
        ) {
          throw new Error("ATTEMPT_IDENTITY_MISMATCH");
        }

        if (attempt.status !== "in_progress") {
          throw new Error("ATTEMPT_NOT_ACTIVE");
        }

        const deadlineAt = validDate(attempt.deadlineAt);

        if (!deadlineAt) {
          throw new Error("INVALID_ATTEMPT_DEADLINE");
        }

        if (Date.now() >= deadlineAt.getTime()) {
          transaction.update(attemptRef, {
            status: "expired",
            expiredAt:
              admin.firestore.FieldValue.serverTimestamp(),
            updatedAt:
              admin.firestore.FieldValue.serverTimestamp()
          });

          throw new Error("EXAM_TIME_EXPIRED");
        }

        const previousDocs = [];

        for (const ref of answerRefs) {
          previousDocs.push(
            await transaction.get(ref)
          );
        }

        const now =
          admin.firestore.FieldValue.serverTimestamp();

        const response = [];

        answers.forEach((item, index) => {
          const selectedOption =
            item.selectedOption === null
              ? null
              : String(item.selectedOption).toUpperCase();

          const question = questionMap.get(item.questionId);

          const answerData = {
            attemptId,
            candidateId: candidate.id,
            questionId: item.questionId,
            subject: question.subject,
            selectedOption,
            savedAt: now
          };

          if (previousDocs[index].exists) {
            transaction.update(
              answerRefs[index],
              answerData
            );
          } else {
            transaction.create(
              answerRefs[index],
              answerData
            );
          }

          response.push({
            questionId: item.questionId,
            selectedOption
          });
        });

        transaction.update(attemptRef, {
          lastAnswerSavedAt: now,
          updatedAt: now
        });

        return response;
      }
    );

    return send(res, 200, {
      ok: true,
      code: "ANSWERS_SAVED",
      savedCount: savedAnswers.length,
      answers: savedAnswers
    });

  } catch (error) {
    const code = String(error.message || "");

    const knownErrors = {
      ATTEMPT_NOT_FOUND: [404, "ATTEMPT_NOT_FOUND"],
      ATTEMPT_NOT_ACTIVE: [409, "ATTEMPT_NOT_ACTIVE"],
      ATTEMPT_IDENTITY_MISMATCH: [403, "ATTEMPT_IDENTITY_MISMATCH"],
      INVALID_ATTEMPT_DEADLINE: [409, "INVALID_ATTEMPT_DEADLINE"],
      EXAM_TIME_EXPIRED: [409, "EXAM_TIME_EXPIRED"],
      INVALID_QUESTION_SNAPSHOT: [409, "INVALID_QUESTION_SNAPSHOT"],
      INVALID_QUESTION_ID: [409, "INVALID_QUESTION_ID"]
    };

    if (knownErrors[code]) {
      return send(res, knownErrors[code][0], {
        ok: false,
        code: knownErrors[code][1]
      });
    }

    console.error("CBT ANSWERS ERROR:", error);

    return send(res, 500, {
      ok: false,
      code: "ANSWERS_SAVE_FAILED"
    });
  }
};
