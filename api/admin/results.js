
"use strict";

const { getFirestore } = require("../../lib/firebase-admin");
const { requireAdmin } = require("../../lib/admin-auth");

const EXAM_ID =
  process.env.CBT_EXAM_ID || "jamb-2026-11-28";

function timestampToISO(value) {
  if (!value) return null;

  try {
    if (typeof value.toDate === "function") {
      return value.toDate().toISOString();
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (typeof value === "number") {
      return new Date(value).toISOString();
    }

    if (typeof value === "string") {
      const date = new Date(value);
      return Number.isNaN(date.getTime())
        ? null
        : date.toISOString();
    }

    return null;
  } catch {
    return null;
  }
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function getCandidateName(data = {}) {
  if (data.fullName) return data.fullName;
  if (data.name) return data.name;

  return [
    data.firstName,
    data.lastName
  ].filter(Boolean).join(" ") || "Unknown Candidate";
}

function getSubjectScores(results = {}) {
  if (
    results.subjectScores &&
    typeof results.subjectScores === "object"
  ) {
    return results.subjectScores;
  }

  return {};
}

module.exports = async function handler(req, res) {
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
    const db = getFirestore();

    const [registrationsSnapshot, attemptsSnapshot] =
      await Promise.all([
        db.collection("jamb_registrations").get(),

        db.collection("cbt_attempts")
          .where("examId", "==", EXAM_ID)
          .get()
      ]);

    const registrations = new Map();

    registrationsSnapshot.forEach(doc => {
      registrations.set(doc.id, doc.data() || {});
    });

    const attempts = [];

    attemptsSnapshot.forEach(doc => {
      attempts.push({
        id: doc.id,
        ...doc.data()
      });
    });

    const attemptByCandidate = new Map();

    attempts.forEach(attempt => {
      if (attempt.candidateId) {
        attemptByCandidate.set(
          attempt.candidateId,
          attempt
        );
      }
    });

    const submittedAttempts = attempts.filter(
      attempt => attempt.status === "submitted"
    );

    const currentlyWriting = attempts.filter(
      attempt => attempt.status === "in_progress"
    ).length;

    const expired = attempts.filter(
      attempt => attempt.status === "expired"
    ).length;

    const notStarted = Math.max(
      0,
      registrationsSnapshot.size - attempts.length
    );

    let totalScore = 0;
    let totalPercentage = 0;
    let highestScore = null;
    let lowestScore = null;

    const subjectStats = new Map();
    const candidateResults = [];

    for (const attempt of submittedAttempts) {
      const results = attempt.results || {};

      const score = number(
        results.totalScore ?? attempt.totalScore
      );

      const percentage = number(
        results.percentage ?? attempt.percentage
      );

      const registration =
        registrations.get(attempt.candidateId) || {};

      const subjectScores = getSubjectScores(results);

      totalScore += score;
      totalPercentage += percentage;

      highestScore =
        highestScore === null
          ? score
          : Math.max(highestScore, score);

      lowestScore =
        lowestScore === null
          ? score
          : Math.min(lowestScore, score);

      for (const [subject, data] of Object.entries(
        subjectScores
      )) {
        if (!data || typeof data !== "object") continue;

        if (!subjectStats.has(subject)) {
          subjectStats.set(subject, {
            subject,
            candidates: 0,
            totalQuestions: 0,
            answered: 0,
            unanswered: 0,
            correct: 0,
            incorrect: 0,
            totalScore: 0,
            totalPercentage: 0
          });
        }

        const stat = subjectStats.get(subject);

        stat.candidates += 1;
        stat.totalQuestions += number(data.totalQuestions);
        stat.answered += number(data.answered);
        stat.unanswered += number(data.unanswered);
        stat.correct += number(data.correct);
        stat.incorrect += number(data.incorrect);
        stat.totalScore += number(data.score);
        stat.totalPercentage += number(data.percentage);
      }

      candidateResults.push({
        candidateId: attempt.candidateId || null,

        registrationNumber:
          attempt.registrationNumber ||
          registration.registrationNumber ||
          null,

        candidateName: getCandidateName(registration),

        batch:
          attempt.batch ||
          registration.examSchedule?.batch ||
          null,

        status: attempt.status,

        totalScore: score,
        percentage,

        subjectScores,

        startedAt: timestampToISO(attempt.startedAt),
        submittedAt: timestampToISO(attempt.submittedAt)
      });
    }

    candidateResults.sort((a, b) => {
      if (b.totalScore !== a.totalScore) {
        return b.totalScore - a.totalScore;
      }

      return b.percentage - a.percentage;
    });

    const subjectSummary = Array.from(
      subjectStats.values()
    )
      .map(stat => ({
        ...stat,

        averageScore:
          stat.candidates > 0
            ? Number(
                (stat.totalScore / stat.candidates).toFixed(2)
              )
            : 0,

        averagePercentage:
          stat.candidates > 0
            ? Number(
                (
                  stat.totalPercentage / stat.candidates
                ).toFixed(2)
              )
            : 0
      }))
      .sort((a, b) =>
        a.subject.localeCompare(b.subject)
      );

    const submittedCount = submittedAttempts.length;

    return res.status(200).json({
      ok: true,
      examId: EXAM_ID,

      generatedAt: new Date().toISOString(),

      overview: {
        totalCandidates: registrationsSnapshot.size,
        notStarted,
        currentlyWriting,
        submitted: submittedCount,
        expired,

        averageScore:
          submittedCount > 0
            ? Number(
                (totalScore / submittedCount).toFixed(2)
              )
            : 0,

        averagePercentage:
          submittedCount > 0
            ? Number(
                (totalPercentage / submittedCount).toFixed(2)
              )
            : 0,

        highestScore,
        lowestScore
      },

      subjectSummary,

      candidates: candidateResults
    });

  } catch (error) {
    console.error(
      "Admin results API error:",
      error.message
    );

    return res.status(500).json({
      ok: false,
      code: "RESULTS_FETCH_FAILED",
      message: "Unable to retrieve examination results."
    });
  }
};
