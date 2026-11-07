
"use strict";

const {
  getFirestore,
  admin
} = require("../../lib/firebase-admin");

const {
  getQuestionsForSubject,
  getSubjectBankStatus,
  toCandidateQuestion
} = require("../../lib/question-bank");

const EXAM_ID =
  process.env.CBT_EXAM_ID || "jamb-2026-11-28";

const TOTAL_QUESTIONS_PER_SUBJECT = 40;

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

function getCandidateName(data) {
  return (
    data.fullName ||
    data.name ||
    [data.firstName, data.lastName]
      .filter(Boolean)
      .join(" ")
  );
}

function validDate(value) {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    return value.toDate();
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

function sameIdentity(attempt, candidate) {
  return (
    attempt.candidateId === candidate.id &&
    attempt.registrationNumber ===
      candidate.registrationNumber
  );
}

function shuffleArray(items) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [result[i], result[j]] =
      [result[j], result[i]];
  }

  return result;
}

async function findCandidate(db, lookup) {
  const registrations = await db
    .collection("jamb_registrations")
    .get();

  const normalized = normalizePhone(lookup);
  const upperLookup = lookup.toUpperCase();

  const matches = [];

  for (const doc of registrations.docs) {
    const data = doc.data();

    const phoneMatches =
      normalized &&
      normalizePhone(data.whatsappNumber) === normalized;

    const registrationMatches =
      String(data.registrationNumber || "")
        .trim()
        .toUpperCase() === upperLookup;

    if (phoneMatches || registrationMatches) {
      matches.push({
        id: doc.id,
        ...data
      });
    }
  }

  if (matches.length === 0) {
    return {
      error: "CANDIDATE_NOT_FOUND"
    };
  }

  if (matches.length > 1) {
    return {
      error: "AMBIGUOUS_CANDIDATE"
    };
  }

  return {
    candidate: matches[0]
  };
}

async function generateExamSnapshot(subjects) {
  const snapshot = {};
  const usedQuestionIds = new Set();

  for (const subject of subjects) {
    const questions =
      await getQuestionsForSubject(subject);

    const uniqueQuestions = [];

    for (const question of shuffleArray(questions)) {
      if (usedQuestionIds.has(question.id)) {
        continue;
      }

      usedQuestionIds.add(question.id);

      uniqueQuestions.push({
        id: question.id,
        subject: question.subject,
        question: question.question,
        options: question.options,
        answer: question.answer,
        year: question.year || null,
        sourceFile: question.sourceFile || null
      });

      if (
        uniqueQuestions.length ===
        TOTAL_QUESTIONS_PER_SUBJECT
      ) {
        break;
      }
    }

    if (
      uniqueQuestions.length !==
      TOTAL_QUESTIONS_PER_SUBJECT
    ) {
      throw new Error(
        `INSUFFICIENT_UNIQUE_QUESTIONS:${subject}`
      );
    }

    snapshot[subject] = uniqueQuestions;
  }

  return snapshot;
}

function removeAnswerKey(questions) {
  return questions.map((question, index) =>
    toCandidateQuestion({
      ...question,
      position: index + 1
    })
  );
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

    // 1. Find the registered candidate.
    const result = await findCandidate(db, lookup);

    if (result.error) {
      const status =
        result.error === "CANDIDATE_NOT_FOUND"
          ? 404
          : 409;

      return send(res, status, {
        ok: false,
        code: result.error
      });
    }

    const candidate = result.candidate;

    // 2. Validate candidate registration.
    const registrationNumber =
      String(candidate.registrationNumber || "").trim();

    const candidateName = getCandidateName(candidate);

    const subjects = Array.isArray(candidate.jambSubjects)
      ? candidate.jambSubjects
          .map(subject => String(subject).trim())
          .filter(Boolean)
      : [];

    if (
      !registrationNumber ||
      !candidateName ||
      subjects.length !== 4 ||
      new Set(subjects).size !== 4
    ) {
      return send(res, 422, {
        ok: false,
        code: "INCOMPLETE_REGISTRATION"
      });
    }

    // 3. Confirm all four subjects have question banks.
    const bankStatus =
      getSubjectBankStatus(subjects);

    if (!bankStatus.ready) {
      return send(res, 422, {
        ok: false,
        code: "UNSUPPORTED_SUBJECTS",
        unsupportedSubjects: bankStatus.unsupported
      });
    }

    // 4. Locate the candidate's deterministic attempt.
    const attemptId = `${EXAM_ID}_${candidate.id}`;

    const attemptRef = db
      .collection("cbt_attempts")
      .doc(attemptId);

    const attemptDoc = await attemptRef.get();

    if (!attemptDoc.exists) {
      return send(res, 403, {
        ok: false,
        code: "ATTEMPT_NOT_STARTED"
      });
    }

    const attempt = attemptDoc.data();

    // 5. Verify attempt identity and exam.
    if (
      !sameIdentity(attempt, candidate) ||
      attempt.examId !== EXAM_ID
    ) {
      return send(res, 403, {
        ok: false,
        code: "ATTEMPT_IDENTITY_MISMATCH"
      });
    }

    // 6. Only an active attempt can retrieve questions.
    if (attempt.status !== "in_progress") {
      return send(res, 409, {
        ok: false,
        code: "ATTEMPT_NOT_ACTIVE"
      });
    }

    // 7. Enforce the original server-controlled deadline.
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
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return send(res, 409, {
        ok: false,
        code: "EXAM_TIME_EXPIRED"
      });
    }

    // 8. Confirm the subjects match the saved attempt.
    const savedSubjects = Array.isArray(attempt.subjects)
      ? attempt.subjects
      : [];

    if (
      savedSubjects.length !== 4 ||
      subjects.some(subject => !savedSubjects.includes(subject))
    ) {
      return send(res, 409, {
        ok: false,
        code: "ATTEMPT_SUBJECT_MISMATCH"
      });
    }

    // 9. Reuse an existing question snapshot.
    const snapshotRef = attemptRef
      .collection("private")
      .doc("question_snapshot");

    const existingSnapshot = await snapshotRef.get();

    let questionSnapshot;

    if (existingSnapshot.exists) {
      questionSnapshot = existingSnapshot.data().questions;

      if (
        !questionSnapshot ||
        subjects.some(
          subject =>
            !Array.isArray(questionSnapshot[subject]) ||
            questionSnapshot[subject].length !==
              TOTAL_QUESTIONS_PER_SUBJECT
        )
      ) {
        return send(res, 409, {
          ok: false,
          code: "INVALID_QUESTION_SNAPSHOT"
        });
      }
    } else {
      // 10. Generate the questions only once.
      questionSnapshot =
        await generateExamSnapshot(subjects);

      // 11. Save question snapshot and answer keys privately.
      await snapshotRef.create({
        examId: EXAM_ID,
        candidateId: candidate.id,
        registrationNumber,
        subjects,
        questions: questionSnapshot,
        createdAt:
          admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // 12. Remove all answer keys before returning questions.
    const candidateQuestions = {};

    for (const subject of subjects) {
      candidateQuestions[subject] =
        removeAnswerKey(questionSnapshot[subject]);
    }

    return send(res, 200, {
      ok: true,
      code: "QUESTIONS_LOADED",
      examId: EXAM_ID,
      candidate: {
        name: candidateName,
        registrationNumber
      },
      durationMinutes: 50,
      deadlineAt: deadlineAt.toISOString(),
      totalSubjects: 4,
      totalQuestions: 160,
      questions: candidateQuestions
    });

  } catch (error) {
    console.error("CBT QUESTIONS ERROR:", error);

    const message = String(error.message || "");

    if (message.startsWith("INSUFFICIENT_UNIQUE_QUESTIONS:")) {
      return send(res, 503, {
        ok: false,
        code: "QUESTION_BANK_INSUFFICIENT",
        subject: message.split(":")[1]
      });
    }

    return send(res, 500, {
      ok: false,
      code: "QUESTIONS_LOAD_FAILED"
    });
  }
};
