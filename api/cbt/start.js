
"use strict";

const {
  getFirebaseAdmin
} = require("../../lib/firebase-admin");

const EXAM_DATE = "2026-11-28";
const DEFAULT_EXAM_ID = "jamb-2026-11-28";
const DURATION_SECONDS = 50 * 60;

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

  if (schedule.examDate !== EXAM_DATE) {
    return null;
  }

  const time24 = String(schedule.time24 || "").trim();

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time24)) {
    return null;
  }

  const [hour, minute] = time24.split(":").map(Number);

  return Date.UTC(2026, 10, 28, hour - 1, minute, 0);
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

function respond(res, status, data) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");

  return res.status(status).json(data);
}

function candidateResponse(candidate, schedule) {
  return {
    registrationNumber: candidate.registrationNumber,
    fullName: getCandidateName(candidate),
    jambSubjects: candidate.jambSubjects,
    schedule: {
      batch: schedule.batch,
      time: schedule.time || null,
      examDate: schedule.examDate,
      timeZone: schedule.timeZone || "Africa/Lagos"
    }
  };
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

      const phoneMatches =
        digits.length >= 8 &&
        normalizePhone(candidate.whatsappNumber) === digits;

      const registrationMatches =
        String(candidate.registrationNumber || "")
          .trim()
          .toUpperCase() === registrationLookup;

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

    const examId =
      process.env.CBT_EXAM_ID || DEFAULT_EXAM_ID;

    const attemptId = `${examId}_${registrationDoc.id}`;

    const registrationRef = db
      .collection("jamb_registrations")
      .doc(registrationDoc.id);

    const attemptRef = db
      .collection("cbt_attempts")
      .doc(attemptId);

    let outcome;

    await db.runTransaction(async transaction => {
      // All reads happen before any writes.
      const registrationSnapshot =
        await transaction.get(registrationRef);

      const attemptSnapshot =
        await transaction.get(attemptRef);

      if (!registrationSnapshot.exists) {
        outcome = {
          status: 404,
          body: {
            ok: false,
            code: "CANDIDATE_NOT_FOUND"
          }
        };
        return;
      }

      const candidate = registrationSnapshot.data() || {};
      const fullName = getCandidateName(candidate);
      const schedule = candidate.examSchedule || {};

      if (
        !candidate.registrationNumber ||
        !fullName ||
        !validSubjects(candidate.jambSubjects)
      ) {
        outcome = {
          status: 422,
          body: {
            ok: false,
            code: "INCOMPLETE_REGISTRATION"
          }
        };
        return;
      }

      if (
        !schedule.batch ||
        schedule.examDate !== EXAM_DATE ||
        (
          schedule.timeZone &&
          schedule.timeZone !== "Africa/Lagos"
        )
      ) {
        outcome = {
          status: 422,
          body: {
            ok: false,
            code: "INVALID_OR_MISSING_SCHEDULE"
          }
        };
        return;
      }

      const scheduledAt = getScheduleStartMillis(schedule);

      if (scheduledAt === null) {
        outcome = {
          status: 422,
          body: {
            ok: false,
            code: "INVALID_SCHEDULE_TIME"
          }
        };
        return;
      }

      const now = Date.now();

      // Existing attempts must never receive a new timer.
      if (attemptSnapshot.exists) {
        const existing = attemptSnapshot.data() || {};

        if (
          existing.status === "submitted" ||
          existing.status === "expired"
        ) {
          outcome = {
            status: 409,
            body: {
              ok: false,
              code: "ATTEMPT_ALREADY_USED"
            }
          };
          return;
        }

        if (existing.status === "in_progress") {
          const deadline = toMillis(existing.deadlineAt);

          if (deadline !== null && now < deadline) {
            outcome = {
              status: 200,
              body: {
                ok: true,
                code: "ATTEMPT_RESUME",
                resumed: true,
                attempt: {
                  attemptId,
                  status: existing.status,
                  startedAt: new Date(
                    toMillis(existing.startedAt)
                  ).toISOString(),
                  deadlineAt: new Date(deadline).toISOString(),
                  durationSeconds: DURATION_SECONDS
                },
                candidate: candidateResponse(
                  candidate,
                  schedule
                )
              }
            };
            return;
          }

          outcome = {
            status: 409,
            body: {
              ok: false,
              code: "ATTEMPT_TIME_EXPIRED"
            }
          };
          return;
        }

        outcome = {
          status: 409,
          body: {
            ok: false,
            code: "ATTEMPT_ALREADY_EXISTS"
          }
        };
        return;
      }

      // Entry window is still provisional.
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
        outcome = {
          status: 403,
          body: {
            ok: false,
            code: "TOO_EARLY",
            scheduledAt: new Date(scheduledAt).toISOString()
          }
        };
        return;
      }

      if (now > entryEndsAt) {
        outcome = {
          status: 403,
          body: {
            ok: false,
            code: "ENTRY_WINDOW_CLOSED"
          }
        };
        return;
      }

      const Timestamp = admin.firestore.Timestamp;

      const startedAt = Timestamp.fromMillis(now);
      const deadlineAt = Timestamp.fromMillis(
        now + DURATION_SECONDS * 1000
      );

      const attemptData = {
        attemptId,
        examId,
        candidateId: registrationDoc.id,
        registrationNumber: candidate.registrationNumber,
        fullName,

        subjects: candidate.jambSubjects.map(
          subject => String(subject).trim()
        ),

        status: "in_progress",

        scheduledAt: Timestamp.fromMillis(scheduledAt),
        startedAt,
        deadlineAt,

        durationSeconds: DURATION_SECONDS,

        submittedAt: null,
        score: null,
        subjectScores: {},

        createdAt: startedAt,
        updatedAt: startedAt
      };

      // Atomic creation prevents two devices starting separately.
      transaction.create(attemptRef, attemptData);

      outcome = {
        status: 201,
        body: {
          ok: true,
          code: "ATTEMPT_STARTED",
          resumed: false,
          attempt: {
            attemptId,
            status: "in_progress",
            startedAt: startedAt.toDate().toISOString(),
            deadlineAt: deadlineAt.toDate().toISOString(),
            durationSeconds: DURATION_SECONDS
          },
          candidate: candidateResponse(
            candidate,
            schedule
          )
        }
      };
    });

    return respond(
      res,
      outcome.status,
      outcome.body
    );

  } catch (error) {
    console.error("Attempt start failed:", error);

    return respond(res, 500, {
      ok: false,
      code: "ATTEMPT_START_FAILED"
    });
  }
};
