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

    const counts = {
      totalCandidates: registrationsSnap.size,
      notStarted: 0,
      currentlyWriting: 0,
      submitted: 0,
      expired: 0
    };

    const now = Date.now();

    for (const doc of registrationsSnap.docs) {
      const attempt = attempts.get(doc.id);
      const status = getStatus(attempt, now);

      if (status === "not_started") counts.notStarted++;
      if (status === "in_progress") counts.currentlyWriting++;
      if (status === "submitted") counts.submitted++;
      if (status === "expired") counts.expired++;
    }

    return res.status(200).json({
      ok: true,
      examId,
      overview: counts,
      generatedAt: new Date(now).toISOString()
    });

  } catch (error) {
    console.error("ADMIN OVERVIEW ERROR:", error);

    return res.status(500).json({
      ok: false,
      code: "ADMIN_OVERVIEW_FAILED"
    });
  }
};
