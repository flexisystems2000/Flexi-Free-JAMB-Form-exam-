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

function getStatus(attempt, now) {
  if (!attempt) return "not_started";
  if (attempt.status === "submitted") return "submitted";
  if (attempt.status === "expired") return "expired";

  if (attempt.status === "in_progress") {
    const deadline = toMillis(attempt.deadlineAt);
    if (deadline !== null && now >= deadline) return "expired";
    return "in_progress";
  }

  return "not_started";
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

    const search = String(req.query.search || "")
      .trim()
      .toLowerCase()
      .slice(0, 100);

    const [registrationsSnap, attemptsSnap] = await Promise.all([
      db.collection("jamb_registrations").get(),
      db.collection("cbt_attempts")
        .where("examId", "==", examId)
        .get()
    ]);

    const attempts = new Map();

    for (const doc of attemptsSnap.docs) {
      attempts.set(doc.data().candidateId, doc.data());
    }

    const now = Date.now();

    let candidates = registrationsSnap.docs.map(doc => {
      const candidate = doc.data() || {};
      const attempt = attempts.get(doc.id) || null;
      const schedule = candidate.examSchedule || {};

      return {
        candidateId: doc.id,
        fullName: getName(candidate),
        registrationNumber: candidate.registrationNumber || null,
        whatsappNumber: candidate.whatsappNumber || null,
        subjects: Array.isArray(candidate.jambSubjects)
          ? candidate.jambSubjects
          : [],
        batch: schedule.batch || null,
        scheduledTime: schedule.time || schedule.time24 || null,
        examDate: schedule.examDate || null,
        status: getStatus(attempt, now),
        actualAttemptStatus: attempt?.status || null,
        attemptId: attempt?.attemptId || null,
        startedAt: toISO(attempt?.startedAt),
        deadlineAt: toISO(attempt?.deadlineAt),
        submittedAt: toISO(attempt?.submittedAt),
        totalScore: attempt?.totalScore ?? null,
        percentage: attempt?.percentage ?? null
      };
    });

    if (search) {
      candidates = candidates.filter(candidate => {
        const searchable = [
          candidate.fullName,
          candidate.registrationNumber,
          candidate.whatsappNumber
        ].join(" ").toLowerCase();

        return searchable.includes(search);
      });
    }

    candidates.sort((a, b) =>
      a.fullName.localeCompare(b.fullName)
    );

    return res.status(200).json({
      ok: true,
      examId,
      total: candidates.length,
      candidates
    });

  } catch (error) {
    console.error("ADMIN CANDIDATES ERROR:", error);

    return res.status(500).json({
      ok: false,
      code: "ADMIN_CANDIDATES_FAILED"
    });
  }
};
