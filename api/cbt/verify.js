"use strict";

const {
  getFirebaseAdmin
} = require("../../lib/firebase-admin");

const EXAM_DATE = "2026-11-28";
const DEFAULT_EXAM_ID = "jamb-2026-11-28";

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function validSubjects(subjects) {
  if (!Array.isArray(subjects) || subjects.length !== 4) {
    return false;
  }

  const cleaned = subjects.map(subject =>
    String(subject || "").trim().toLowerCase()
  );

  return (
    cleaned.every(Boolean) &&
    new Set(cleaned).size === 4
  );
}

function toMillis(value) {
  if (!value) return null;

  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (typeof value.toDate === "function") {
    return value.toDate().getTime();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getScheduleStartMillis(schedule) {
  const savedTimestamp = toMillis(schedule.scheduledAt);

  if (savedTimestamp !== null) {
    return savedTimestamp;
  }

  // Fallback for older schedule records without scheduledAt.
  // Africa/Lagos is UTC+1.

  if (schedule.examDate !== EXAM_DATE) {
    return null;
  }

  const time24 = String(schedule.time24 || "").trim();

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time24)) {
    return null;
  }

  const [hour, minute] = time24.split(":").map(Number);

  return Date.UTC(
    2026,
    10,
    28,
    hour - 1,
    minute,
    0
  );
}

function respond(res, status, data) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");

  return res.status(status).json(data);
}

function getCandidateName(candidate) {
  if (candidate.fullName) {
    return String(candidate.fullName).trim();
  }

  if (candidate.name) {
    return String(candidate.name).trim();
  }

  return [
    candidate.firstName,
    candidate.lastName
  ].filter(Boolean).join(" ").trim();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return respond(res, 405, {
      ok: false,
      code: "METHOD_NOT_ALLOWED"
    });
  }

  const lookup = String(
    req.body?.whatsappNumber ||
    req.body?.registrationNumber ||
    ""
  ).trim();

  if (!lookup || lookup.length > 40) {
    return respond(res, 400, {
      ok: false,
      code: "INVALID_LOOKUP"
    });
  }

  let admin;

  try {
    admin = getFirebaseAdmin();
  } catch (error) {
    console.error(
      "Firebase initialisation error:",
      error.code || error.message
    );

    return respond(res, 503, {
      ok: false,
      code: "SERVICE_NOT_CONFIGURED"
    });
  }

  try {
    const db = admin.firestore();

    const registrations = await db
      .collection("jamb_registrations")
      .get();

    const digits = normalizePhone(lookup);
    const registrationLookup = lookup.toUpperCase();

    const matches = registrations.docs.filter(doc => {
      const candidate = doc.data() || {};

      const storedPhone = normalizePhone(
        candidate.whatsappNumber
      );

      const storedRegistration = String(
        candidate.registrationNumber || ""
      ).trim().toUpperCase();

      const phoneMatches =
        digits.length >= 8 &&
        storedPhone === digits;

      const registrationMatches =
        storedRegistration === registrationLookup;

      return phoneMatches || registrationMatches;
    });

    if (matches.length === 0) {
      return respond(res, 404, {
        ok: false,
        code: "CANDIDATE_NOT_FOUND"
      });
    }

    if (matches.length > 1) {
      return respond(res, 409, {
        ok: false,
        code: "AMBIGUOUS_CANDIDATE"
      });
    }

    const registrationDoc = matches[0];
    const candidate = registrationDoc.data() || {};

    const fullName = getCandidateName(candidate);

    if (
      !candidate.registrationNumber ||
      !fullName ||
      !validSubjects(candidate.jambSubjects)
    ) {
      return respond(res, 422, {
        ok: false,
        code: "INCOMPLETE_REGISTRATION"
      });
    }

    const schedule = candidate.examSchedule || {};

    if (
      !schedule.batch ||
      schedule.examDate !== EXAM_DATE ||
      (
        schedule.timeZone &&
        schedule.timeZone !== "Africa/Lagos"
      )
    ) {
      return respond(res, 422, {
        ok: false,
        code: "INVALID_OR_MISSING_SCHEDULE"
      });
    }

    const scheduledAt = getScheduleStartMillis(schedule);

    if (scheduledAt === null) {
      return respond(res, 422, {
        ok: false,
        code: "INVALID_SCHEDULE_TIME"
      });
    }

    // Server clock is authoritative.
    const now = Date.now();

    /*
      PROVISIONAL ENTRY WINDOW:

      The current default is 60 seconds because the saved
      schedule is expressed to the minute.

      Confirm the exact entry-window policy before production.
      This endpoint does not start or lock an exam attempt.
    */

    const configuredWindow = Number.parseInt(
      process.env.CBT_START_WINDOW_SECONDS || "60",
      10
    );

    const windowSeconds =
      Number.isFinite(configuredWindow) &&
      configuredWindow >= 0
        ? Math.min(configuredWindow, 300)
        : 60;

    const entryEndsAt =
      scheduledAt + windowSeconds * 1000;

    if (now < scheduledAt) {
      return respond(res, 403, {
        ok: false,
        code: "TOO_EARLY",
        scheduledAt: new Date(scheduledAt).toISOString()
      });
    }

    if (now > entryEndsAt) {
      return respond(res, 403, {
        ok: false,
        code: "ENTRY_WINDOW_CLOSED",
        scheduledAt: new Date(scheduledAt).toISOString()
      });
    }

    const examId =
      process.env.CBT_EXAM_ID || DEFAULT_EXAM_ID;

    /*
      This checks the deterministic attempt ID reserved
      for the future attempt-creation implementation.

      Actual attempt creation must use a Firestore transaction
      to prevent two devices starting the same candidate's exam.
    */

    const attemptId = `${examId}_${registrationDoc.id}`;

    const attemptRef = db
      .collection("cbt_attempts")
      .doc(attemptId);

    const attemptSnapshot = await attemptRef.get();

    if (attemptSnapshot.exists) {
      const attempt = attemptSnapshot.data() || {};

      const code =
        attempt.status === "submitted" ||
        attempt.status === "expired"
          ? "ATTEMPT_ALREADY_USED"
          : "ATTEMPT_ALREADY_EXISTS";

      return respond(res, 409, {
        ok: false,
        code
      });
    }

    return respond(res, 200, {
      ok: true,
      code: "ELIGIBLE_TO_CONTINUE",

      candidate: {
        registrationNumber: candidate.registrationNumber,
        fullName,
        jambSubjects: candidate.jambSubjects
      },

      schedule: {
        batch: schedule.batch,
        time: schedule.time || null,
        time24: schedule.time24 || null,
        examDate: schedule.examDate,
        timeZone: schedule.timeZone || "Africa/Lagos",
        scheduledAt: new Date(scheduledAt).toISOString()
      }
    });

  } catch (error) {
    console.error("Candidate verification failed:", error);

    return respond(res, 500, {
      ok: false,
      code: "VERIFICATION_FAILED"
    });
  }
};
