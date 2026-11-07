"use strict";

const { getFirebaseAdmin } = require("../../lib/firebase-admin");
const {
  createCandidateSession,
  requireCandidateSession,
  CbtAuthError
} = require("../../lib/cbt-auth");

const EXAM_DATE = "2026-11-28";
const DEFAULT_EXAM_ID = "jamb-2026-11-28";
const DURATION_SECONDS = 50 * 60;
const DURATION_MILLIS = DURATION_SECONDS * 1000;

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getScheduleStartMillis(schedule) {
  const saved = toMillis(schedule.scheduledAt);
  if (saved !== null) return saved;
  if (schedule.examDate !== EXAM_DATE) return null;

  const time24 = String(schedule.time24 || "").trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time24)) return null;

  const [hour, minute] = time24.split(":").map(Number);
  return Date.UTC(2026, 10, 28, hour - 1, minute, 0);
}

function candidateMatches(candidate, lookup) {
  const digits = normalizePhone(lookup);
  const registrationLookup = String(lookup).trim().toUpperCase();
  return (
    (digits.length >= 8 && normalizePhone(candidate.whatsappNumber) === digits) ||
    (registrationLookup &&
      String(candidate.registrationNumber || "").trim().toUpperCase() === registrationLookup)
  );
}

function getCandidateName(candidate) {
  return String(
    candidate.fullName ||
    candidate.name ||
    [candidate.firstName, candidate.lastName].filter(Boolean).join(" ") ||
    ""
  ).trim();
}

function validSubjects(subjects) {
  if (!Array.isArray(subjects) || subjects.length !== 4) return false;
  const cleaned = subjects.map(x => String(x || "").trim().toLowerCase());
  return cleaned.every(Boolean) && new Set(cleaned).size === 4;
}

function getEntryWindowSeconds() {
  const value = Number.parseInt(process.env.CBT_START_WINDOW_SECONDS || "60", 10);
  if (!Number.isFinite(value) || value < 0) return 60;
  return Math.min(value, 300);
}

function validSchedule(schedule) {
  return Boolean(
    schedule &&
    schedule.batch &&
    schedule.examDate === EXAM_DATE &&
    (!schedule.timeZone || schedule.timeZone === "Africa/Lagos")
  );
}

function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  return res.status(status).json(body);
}

function bearerToken(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  }

  const lookup = String(
    req.body?.whatsappNumber || req.body?.registrationNumber || ""
  ).trim();

  if (!lookup || lookup.length > 40) {
    return send(res, 400, { ok: false, code: "INVALID_LOOKUP" });
  }

  try {
    const firebase = getFirebaseAdmin();
    const db = firebase.firestore();
    const registrations = await db.collection("jamb_registrations").get();
    const matches = registrations.docs.filter(doc =>
      candidateMatches(doc.data() || {}, lookup)
    );

    if (!matches.length) return send(res, 404, { ok: false, code: "CANDIDATE_NOT_FOUND" });
    if (matches.length > 1) return send(res, 409, { ok: false, code: "AMBIGUOUS_CANDIDATE" });

    const registrationDoc = matches[0];
    const candidate = registrationDoc.data() || {};
    const candidateId = registrationDoc.id;
    const registrationNumber = String(candidate.registrationNumber || "").trim();
    const fullName = getCandidateName(candidate);
    const subjects = Array.isArray(candidate.jambSubjects)
      ? candidate.jambSubjects.map(x => String(x || "").trim())
      : [];

    if (!registrationNumber || !fullName || !validSubjects(subjects)) {
      return send(res, 422, { ok: false, code: "INCOMPLETE_REGISTRATION" });
    }

    const schedule = candidate.examSchedule || {};
    if (!validSchedule(schedule)) {
      return send(res, 422, { ok: false, code: "INVALID_OR_MISSING_SCHEDULE" });
    }

    const scheduledAt = getScheduleStartMillis(schedule);
    if (scheduledAt === null) {
      return send(res, 422, { ok: false, code: "INVALID_SCHEDULE_TIME" });
    }

    const examId = process.env.CBT_EXAM_ID || DEFAULT_EXAM_ID;
    const attemptId = `${examId}_${candidateId}`;
    const attemptRef = db.collection("cbt_attempts").doc(attemptId);
    const now = Date.now();
    const deadline = scheduledAt + DURATION_MILLIS;
    const existingToken = bearerToken(req);

    let attemptResult;

    if (existingToken) {
      // A page refresh may call start again. Validate and reuse its
      // existing session rather than creating a competing session.
      const session = await requireCandidateSession(req);
      if (session.candidateId !== candidateId || session.attemptId !== attemptId) {
        return send(res, 403, { ok: false, code: "SESSION_IDENTITY_MISMATCH" });
      }
      const attemptSnap = await attemptRef.get();
      if (!attemptSnap.exists) return send(res, 404, { ok: false, code: "ATTEMPT_NOT_FOUND" });
      const attempt = attemptSnap.data() || {};
      if (attempt.status !== "in_progress") {
        return send(res, 409, { ok: false, code: "ATTEMPT_NOT_ACTIVE" });
      }
      attemptResult = {
        resumed: true,
        startedAt: toMillis(attempt.startedAt),
        deadlineAt: toMillis(attempt.deadlineAt),
        token: existingToken
      };
    } else {
      await db.runTransaction(async tx => {
        const snap = await tx.get(attemptRef);

        if (snap.exists) {
          const old = snap.data() || {};
          if (
            old.attemptId !== attemptId ||
            old.examId !== examId ||
            old.candidateId !== candidateId ||
            old.registrationNumber !== registrationNumber
          ) {
            throw Object.assign(new Error("ATTEMPT_REQUIRES_ADMIN_REVIEW"), { status: 409 });
          }

          if (old.status === "submitted" || old.status === "expired") {
            throw Object.assign(new Error("ATTEMPT_ALREADY_USED"), { status: 409 });
          }

          if (old.status !== "in_progress") {
            throw Object.assign(new Error("ATTEMPT_NOT_ACTIVE"), { status: 409 });
          }

          const startedAt = toMillis(old.startedAt);
          const savedDeadline = toMillis(old.deadlineAt);
          const savedSchedule = toMillis(old.scheduledAt);

          if (
            startedAt === null ||
            savedDeadline !== deadline ||
            savedSchedule !== scheduledAt ||
            startedAt < scheduledAt ||
            startedAt > now
          ) {
            throw Object.assign(new Error("ATTEMPT_REQUIRES_ADMIN_REVIEW"), { status: 409 });
          }

          if (now >= savedDeadline) {
            tx.update(attemptRef, {
              status: "expired",
              expiredAt: firebase.firestore.FieldValue.serverTimestamp(),
              updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
              expiryReason: "BATCH_DEADLINE_REACHED"
            });
            throw Object.assign(new Error("ATTEMPT_ALREADY_USED"), { status: 409 });
          }

          attemptResult = { resumed: true, startedAt, deadlineAt: savedDeadline };
          return;
        }

        const entryEndsAt = scheduledAt + getEntryWindowSeconds() * 1000;
        if (now < scheduledAt) {
          throw Object.assign(new Error("TOO_EARLY"), { status: 403 });
        }
        if (now > entryEndsAt) {
          throw Object.assign(new Error("ENTRY_WINDOW_CLOSED"), { status: 403 });
        }
        if (now >= deadline) {
          throw Object.assign(new Error("BATCH_DEADLINE_REACHED"), { status: 403 });
        }

        const Timestamp = firebase.firestore.Timestamp;
        const started = Timestamp.fromMillis(now);
        const deadlineTimestamp = Timestamp.fromMillis(deadline);

        tx.create(attemptRef, {
          attemptId,
          examId,
          candidateId,
          registrationNumber,
          fullName,
          subjects,
          status: "in_progress",
          scheduledAt: Timestamp.fromMillis(scheduledAt),
          startedAt: started,
          deadlineAt: deadlineTimestamp,
          durationSeconds: DURATION_SECONDS,
          submittedAt: null,
          expiredAt: null,
          score: null,
          subjectScores: {},
          createdAt: started,
          updatedAt: started
        });

        attemptResult = {
          resumed: false,
          startedAt: now,
          deadlineAt: deadline
        };
      });

      const session = await createCandidateSession({
        candidateId,
        attemptId,
        examId,
        deadlineAt: attemptResult.deadlineAt
      });
      attemptResult.token = session.token;
    }

    if (
      !Number.isFinite(attemptResult.deadlineAt) ||
      now >= attemptResult.deadlineAt
    ) {
      return send(res, 409, { ok: false, code: "EXAM_TIME_EXPIRED" });
    }

    return send(res, attemptResult.resumed ? 200 : 201, {
      ok: true,
      code: attemptResult.resumed ? "ATTEMPT_RESUME" : "ATTEMPT_STARTED",
      resumed: attemptResult.resumed,
      token: attemptResult.token,
      attempt: {
        attemptId,
        status: "in_progress",
        startedAt: new Date(attemptResult.startedAt).toISOString(),
        deadlineAt: new Date(attemptResult.deadlineAt).toISOString(),
        durationSeconds: DURATION_SECONDS
      },
      candidate: {
        fullName,
        registrationNumber,
        jambSubjects: subjects,
        schedule: {
          batch: schedule.batch,
          time: schedule.time || null,
          time24: schedule.time24 || null,
          examDate: schedule.examDate,
          timeZone: schedule.timeZone || "Africa/Lagos"
        }
      }
    });
  } catch (error) {
    if (error instanceof CbtAuthError) {
      return send(res, error.status || 401, { ok: false, code: error.code });
    }
    const code = String(error.message || "");
    const known = {
      TOO_EARLY: 403,
      ENTRY_WINDOW_CLOSED: 403,
      BATCH_DEADLINE_REACHED: 403,
      ATTEMPT_ALREADY_USED: 409,
      ATTEMPT_NOT_ACTIVE: 409,
      ATTEMPT_REQUIRES_ADMIN_REVIEW: 409,
      SESSION_ALREADY_ACTIVE: 409
    };
    if (known[code]) return send(res, known[code], { ok: false, code });
    console.error("CBT START ERROR:", error);
    return send(res, 500, { ok: false, code: "ATTEMPT_START_FAILED" });
  }
};
