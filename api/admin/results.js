"use strict";

const { requireAdmin } = require("../../lib/admin-auth");

const EXAM_ID = process.env.CBT_EXAM_ID || "jamb-2026-11-28";

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function timestampToISO(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function candidateName(row = {}) {
  return row.full_name || row.fullName || row.name ||
    [row.first_name || row.firstName, row.last_name || row.lastName]
      .filter(Boolean).join(" ") || "Unknown Candidate";
}

async function supabaseRows(table, query, url, key) {
  const response = await fetch(
    `${url}/rest/v1/${table}?${query}`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json"
      }
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    console.error("Supabase results query failed:", table, response.status, detail);
    throw new Error("Unable to retrieve examination results from the database.");
  }

  return response.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, code: "METHOD_NOT_ALLOWED" });
  }

  const adminUser = await requireAdmin(req, res);
  if (!adminUser) return;

  try {
    const supabaseUrl = (
      process.env.SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      ""
    ).replace(/\/$/, "");
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY ||
      "";

    if (!supabaseUrl || !supabaseKey) {
      console.error("Missing SUPABASE_URL or Supabase service-role key in Vercel environment.");
      return res.status(500).json({
        ok: false,
        code: "SUPABASE_CONFIGURATION_MISSING",
        message: "Results database is not configured on the server."
      });
    }

    const [registrations, attempts] = await Promise.all([
      supabaseRows(
        "jamb_registrations",
        "select=firestore_id,full_name,registration_number,exam_schedule,jamb_subjects",
        supabaseUrl,
        supabaseKey
      ),
      supabaseRows(
        "cbt_attempts",
        "select=attempt_id,exam_id,candidate_id,status,started_at,submitted_at,expired_at,total_score,percentage,results,created_at,updated_at&exam_id=eq." + encodeURIComponent(EXAM_ID),
        supabaseUrl,
        supabaseKey
      )
    ]);

    const registrationsById = new Map(
      registrations.map(row => [row.firestore_id, row])
    );

    const latestByCandidate = new Map();
    for (const attempt of attempts) {
      const current = latestByCandidate.get(attempt.candidate_id);
      const currentTime = current
        ? new Date(current.started_at || current.created_at || 0).getTime()
        : -1;
      const nextTime = new Date(attempt.started_at || attempt.created_at || 0).getTime();
      if (!current || nextTime >= currentTime) {
        latestByCandidate.set(attempt.candidate_id, attempt);
      }
    }

    const latestAttempts = Array.from(latestByCandidate.values());
    const currentlyWriting = latestAttempts.filter(a => a.status === "in_progress").length;
    const expired = latestAttempts.filter(a => a.status === "expired").length;
    const submitted = latestAttempts.filter(a => a.status === "submitted").length;

    // Both submitted and expired attempts can have final, persisted scores.
    const scoredAttempts = latestAttempts.filter(a =>
      ["submitted", "expired"].includes(String(a.status || "").toLowerCase()) &&
      (a.results || {}).totalScore !== undefined
    );

    const candidateResults = scoredAttempts.map(attempt => {
      const registration = registrationsById.get(attempt.candidate_id) || {};
      const results = attempt.results || {};
      const subjectScores = results.subjectScores || {};
      const maximumScore = number(results.maximumScore) || 400;

      return {
        candidateId: attempt.candidate_id || null,
        attemptId: attempt.attempt_id || null,
        registrationNumber: registration.registration_number || null,
        candidateName: candidateName(registration),
        batch: registration.exam_schedule?.batch || null,
        status: attempt.status,
        totalScore: number(results.totalScore ?? attempt.total_score),
        maximumScore,
        percentage: number(results.percentage ?? attempt.percentage),
        subjectScores,
        startedAt: timestampToISO(attempt.started_at),
        submittedAt: timestampToISO(attempt.submitted_at),
        expiredAt: timestampToISO(attempt.expired_at),
        completedAt: timestampToISO(attempt.submitted_at || attempt.expired_at)
      };
    });

    candidateResults.sort((a, b) =>
      b.totalScore - a.totalScore || b.percentage - a.percentage
    );

    const subjectStats = new Map();
    for (const candidate of candidateResults) {
      for (const [subject, data] of Object.entries(candidate.subjectScores || {})) {
        if (!data || typeof data !== "object") continue;
        if (!subjectStats.has(subject)) {
          subjectStats.set(subject, {
            subject, candidates: 0, totalQuestions: 0,
            answered: 0, unanswered: 0, correct: 0,
            incorrect: 0, totalScore: 0, totalPercentage: 0
          });
        }
        const stat = subjectStats.get(subject);
        const totalQuestions = number(data.totalQuestions) || 40;
        stat.candidates += 1;
        stat.totalQuestions += totalQuestions;
        stat.answered += number(data.answered);
        stat.unanswered += number(data.unanswered);
        stat.correct += number(data.correct);
        stat.incorrect += number(data.incorrect);
        stat.totalScore += number(data.score);
        stat.totalPercentage += number(data.percentage);
      }
    }

    const subjectSummary = Array.from(subjectStats.values())
      .map(stat => ({
        ...stat,
        averageScore: stat.candidates
          ? Number((stat.totalScore / stat.candidates).toFixed(2)) : 0,
        averagePercentage: stat.candidates
          ? Number((stat.totalPercentage / stat.candidates).toFixed(2)) : 0
      }))
      .sort((a, b) => a.subject.localeCompare(b.subject));

    const totalScore = candidateResults.reduce((sum, row) => sum + row.totalScore, 0);
    const totalPercentage = candidateResults.reduce((sum, row) => sum + row.percentage, 0);
    const count = candidateResults.length;
    const highestScore = count ? Math.max(...candidateResults.map(x => x.totalScore)) : null;
    const lowestScore = count ? Math.min(...candidateResults.map(x => x.totalScore)) : null;
    const attemptedCandidateIds = new Set(latestAttempts.map(a => a.candidate_id));
    const notStarted = Math.max(0, registrations.length - attemptedCandidateIds.size);

    return res.status(200).json({
      ok: true,
      examId: EXAM_ID,
      generatedAt: new Date().toISOString(),
      maximumScore: 400,
      overview: {
        totalCandidates: registrations.length,
        notStarted,
        currentlyWriting,
        submitted,
        expired,
        resultsPublished: count,
        averageScore: count ? Number((totalScore / count).toFixed(2)) : 0,
        averagePercentage: count ? Number((totalPercentage / count).toFixed(2)) : 0,
        highestScore,
        lowestScore
      },
      subjectSummary,
      candidates: candidateResults
    });
  } catch (error) {
    console.error("Admin results API error:", error.message);
    return res.status(500).json({
      ok: false,
      code: "RESULTS_FETCH_FAILED",
      message: "Unable to retrieve examination results."
    });
  }
};
