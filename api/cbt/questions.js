"use strict";

const { getFirestore, admin } = require("../../lib/firebase-admin");
const {
  getQuestionsForSubject,
  getSubjectBankStatus,
  toCandidateQuestion
} = require("../../lib/question-bank");
const {
  requireCandidateSession,
  CbtAuthError
} = require("../../lib/cbt-auth");

const EXAM_ID = process.env.CBT_EXAM_ID || "jamb-2026-11-28";
const PER_SUBJECT = 40;

function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  return res.status(status).json(body);
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = require("crypto").randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

async function buildSnapshot(subjects) {
  const result = {};
  const used = new Set();

  for (const subject of subjects) {
    const selected = [];
    for (const q of shuffle(await getQuestionsForSubject(subject))) {
      if (used.has(q.id)) continue;
      used.add(q.id);
      selected.push({
        id: q.id,
        subject,
        question: q.question,
        options: q.options,
        answer: q.answer,
        year: q.year || null,
        sourceFile: q.sourceFile || null
      });
      if (selected.length === PER_SUBJECT) break;
    }
    if (selected.length !== PER_SUBJECT) {
      throw Object.assign(new Error("QUESTION_BANK_INSUFFICIENT"), { subject });
    }
    result[subject] = selected;
  }
  return result;
}

function sanitize(questions) {
  return questions.map((q, index) =>
    toCandidateQuestion({ ...q, position: index + 1 })
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  }

  try {
    const session = await requireCandidateSession(req);
    if (session.examId !== EXAM_ID) {
      return send(res, 403, { ok: false, code: "SESSION_EXAM_MISMATCH" });
    }

    const db = getFirestore();
    const attemptRef = db.collection("cbt_attempts").doc(session.attemptId);
    const registrationRef = db.collection("jamb_registrations").doc(session.candidateId);

    const [attemptSnap, registrationSnap] = await Promise.all([
      attemptRef.get(),
      registrationRef.get()
    ]);

    if (!attemptSnap.exists || !registrationSnap.exists) {
      return send(res, 404, { ok: false, code: "ATTEMPT_OR_CANDIDATE_NOT_FOUND" });
    }

    const attempt = attemptSnap.data() || {};
    const candidate = registrationSnap.data() || {};

    if (
      attempt.candidateId !== session.candidateId ||
      attempt.examId !== EXAM_ID ||
      attempt.registrationNumber !== candidate.registrationNumber
    ) {
      return send(res, 403, { ok: false, code: "ATTEMPT_IDENTITY_MISMATCH" });
    }

    if (attempt.status !== "in_progress") {
      return send(res, 409, { ok: false, code: "ATTEMPT_NOT_ACTIVE" });
    }

    const deadline = toMillis(attempt.deadlineAt);
    if (!deadline || Date.now() >= deadline) {
      return send(res, 409, { ok: false, code: "EXAM_TIME_EXPIRED" });
    }

    const subjects = Array.isArray(attempt.subjects)
      ? attempt.subjects.map(x => String(x || "").trim())
      : [];

    const bankStatus = getSubjectBankStatus(subjects);
    if (!bankStatus.ready) {
      return send(res, 422, {
        ok: false,
        code: "UNSUPPORTED_SUBJECTS",
        unsupportedSubjects: bankStatus.unsupported
      });
    }

    const snapshotRef = attemptRef.collection("private").doc("question_snapshot");
    let snapshotDoc = await snapshotRef.get();

    if (!snapshotDoc.exists) {
      const generated = await buildSnapshot(subjects);
      const snapshotData = {
        examId: EXAM_ID,
        candidateId: session.candidateId,
        registrationNumber: attempt.registrationNumber,
        subjects,
        questions: generated,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      try {
        await snapshotRef.create(snapshotData);
        snapshotDoc = await snapshotRef.get();
      } catch (error) {
        // Another request may have created the stable snapshot first.
        if (error.code !== 6 && error.code !== "already-exists") throw error;
        snapshotDoc = await snapshotRef.get();
      }
    }

    const snapshot = snapshotDoc.data() || {};
    if (
      snapshot.examId !== EXAM_ID ||
      snapshot.candidateId !== session.candidateId ||
      snapshot.registrationNumber !== attempt.registrationNumber ||
      !Array.isArray(snapshot.subjects) ||
      subjects.some(s => !snapshot.subjects.includes(s))
    ) {
      return send(res, 409, { ok: false, code: "INVALID_QUESTION_SNAPSHOT" });
    }

    const questions = snapshot.questions || {};
    const candidateQuestions = {};

    for (const subject of subjects) {
      if (!Array.isArray(questions[subject]) || questions[subject].length !== PER_SUBJECT) {
        return send(res, 409, { ok: false, code: "INVALID_QUESTION_SNAPSHOT" });
      }
      candidateQuestions[subject] = sanitize(questions[subject]);
    }

    return send(res, 200, {
      ok: true,
      code: "QUESTIONS_LOADED",
      examId: EXAM_ID,
      candidate: {
        name: String(candidate.fullName || candidate.name || ""),
        registrationNumber: attempt.registrationNumber
      },
      durationMinutes: 50,
      deadlineAt: new Date(deadline).toISOString(),
      totalSubjects: 4,
      totalQuestions: 160,
      questions: candidateQuestions
    });
  } catch (error) {
    if (error instanceof CbtAuthError) {
      return send(res, error.status || 401, { ok: false, code: error.code });
    }
    if (error.message === "QUESTION_BANK_INSUFFICIENT") {
      return send(res, 503, {
        ok: false,
        code: "QUESTION_BANK_INSUFFICIENT",
        subject: error.subject || null
      });
    }
    console.error("CBT QUESTIONS ERROR:", error);
    return send(res, 500, { ok: false, code: "QUESTIONS_LOAD_FAILED" });
  }
};
