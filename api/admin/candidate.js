"use strict";

const { getFirebaseAdmin } = require("../../lib/firebase-admin");
const { requireAdmin } = require("../../lib/admin-auth");

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();

  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function toISO(value) {
  const millis = toMillis(value);
  return millis === null ? null : new Date(millis).toISOString();
}

function getName(candidate) {
  return String(
    candidate.fullName ||
    candidate.name ||
    [candidate.firstName, candidate.lastName].filter(Boolean).join(" ") ||
    ""
  ).trim();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
      code: "METHOD_NOT_ALLOWED"
    });
  }

  const adminUser = await requireAdmin(req, res);
  if (!adminUser) return;

  try {
    const firebase = getFirebaseAdmin();
    const db = firebase.firestore();
    const examId = process.env.CBT_EXAM_ID || "jamb-2026-11-28";

    const candidateId = String(req.query.candidateId || "").trim();
    const registrationNumber = String(
      req.query.registrationNumber || ""
    ).trim().toLowerCase();

    if (!candidateId && !registrationNumber) {
      return res.status(400).json({
        ok: false,
        code: "CANDIDATE_IDENTIFIER_REQUIRED"
      });
    }

    let registrationDoc = null;

    if (candidateId) {
      registrationDoc = await db
        .collection("jamb_registrations")
        .doc(candidateId)
        .get();
    } else {
      const registrations = await db
        .collection("jamb_registrations")
        .get();

      const matches = registrations.docs.filter(doc =>
        String(doc.data().registrationNumber || "")
          .trim()
          .toLowerCase() === registrationNumber
      );

      if (matches.length > 1) {
        return res.status(409).json({
          ok: false,
          code: "AMBIGUOUS_CANDIDATE"
        });
      }

      registrationDoc = matches[0] || null;
    }

    if (!registrationDoc || !registrationDoc.exists) {
      return res.status(404).json({
        ok: false,
        code: "CANDIDATE_NOT_FOUND"
      });
    }

    const candidate = registrationDoc.data() || {};
    const actualCandidateId = registrationDoc.id;
    const attemptId = `${examId}_${actualCandidateId}`;

    const attemptRef = db.collection("cbt_attempts").doc(attemptId);

    const [attemptSnap, questionSnap, answersSnap] = await Promise.all([
      attemptRef.get(),
      attemptRef.collection("private").doc("question_snapshot").get(),
      attemptRef.collection("answers").get()
    ]);

    const attempt = attemptSnap.exists ? attemptSnap.data() : null;
    const snapshot = questionSnap.exists ? questionSnap.data() : null;

    const answerMap = {};

    for (const doc of answersSnap.docs) {
      const answer = doc.data() || {};

      if (
        answer.candidateId === actualCandidateId &&
        answer.attemptId === attemptId
      ) {
        answerMap[doc.id] = answer.selectedOption || null;
      }
    }

    const subjectReview = {};

    if (snapshot && snapshot.questions) {
      for (const [subject, questions] of Object.entries(snapshot.questions)) {
        if (!Array.isArray(questions)) continue;

        subjectReview[subject] = questions.map(question => {
          const selectedOption = answerMap[question.id] || null;
          const correctAnswer = String(
            question.answer || ""
          ).toUpperCase();

          return {
            questionId: question.id,
            question: question.question,
            options: question.options,
            selectedOption,
            correctAnswer,
            isCorrect: selectedOption
              ? String(selectedOption).toUpperCase() === correctAnswer
              : false,
            year: question.year || null
          };
        });
      }
    }

    return res.status(200).json({
      ok: true,
      examId,
      candidate: {
        candidateId: actualCandidateId,
        fullName: getName(candidate),
        registrationNumber: candidate.registrationNumber || null,
        whatsappNumber: candidate.whatsappNumber || null,
        subjects: candidate.jambSubjects || [],
        schedule: candidate.examSchedule || {}
      },
      attempt: attempt ? {
        attemptId,
        status: attempt.status || null,
        startedAt: toISO(attempt.startedAt),
        deadlineAt: toISO(attempt.deadlineAt),
        submittedAt: toISO(attempt.submittedAt),
        submissionReason: attempt.submissionReason || null,
        totalScore: attempt.totalScore ?? null,
        percentage: attempt.percentage ?? null,
        results: attempt.results || null
      } : null,
      answers: {
        answeredCount: Object.keys(answerMap).length,
        subjectReview
      }
    });

  } catch (error) {
    console.error("ADMIN CANDIDATE DETAIL ERROR:", error);

    return res.status(500).json({
      ok: false,
      code: "ADMIN_CANDIDATE_DETAIL_FAILED"
    });
  }
};
