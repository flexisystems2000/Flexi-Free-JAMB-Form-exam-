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

  return cleaned.every(Boolean) &&
    new Set(cleaned).size === 4;
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

  // Saved schedule is WAT (UTC+1).
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

function candidateMatches(candidate, lookup) {
  const digits = normalizePhone(lookup);
  const registrationLookup = String(lookup)
    .trim()
    .toUpperCase();

  const storedPhone = normalizePhone(
    candidate.whatsappNumber
  );

  const storedRegistration = String(
    candidate.registrationNumber || ""
  ).trim().toUpperCase();

  return (
    (digits.length >= 8 && storedPhone === digits) ||
    (
      registrationLookup &&
      storedRegistration === registrationLookup
    )
  );
}

function validSchedule(schedule) {
  return Boolean(
    schedule &&
    schedule.batch &&
    schedule.examDate === EXAM_DATE &&
    (
      !schedule.timeZone ||
      schedule.timeZone === "Africa/Lagos"
    )
  );
}

function getEntryWindowSeconds() {
  const configured = Number.parseInt(
    process.env.CBT_START_WINDOW_SECONDS || "60",
    10
  );

  if (!Number.isFinite(configured) || configured < 0) {
    return 60;
  }

  return Math.min(configured, 300);
}

function respond(res, status, data) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");

  return res.status(status).json(data);
}

function candidateResponse(candidate) {
  return {
    registrationNumber: candidate.registrationNumber,
    fullName: getCandidateName(candidate),
    jambSubjects: candidate.jambSubjects
  };
}

function scheduleResponse(schedule, scheduledAt) {
  return {
    batch: schedule.batch,
    time: schedule.time || null,
    time24: schedule.time24 || null,
    examDate: schedule.examDate,
    timeZone: schedule.timeZone || "Africa/Lagos",
    scheduledAt: new Date(scheduledAt).toISOString()
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

    const matches = registrations.docs.filter(doc => {
      return candidateMatches(doc.data() || {}, lookup);
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

      // Revalidate the lookup against the latest registration.
      if (!candidateMatches(candidate, lookup)) {
        outcome = {
          status: 409,
          body: {
            ok: false,
            code: "REGISTRATION_CHANGED"
          }
        };
        return;
      }

      const fullName = getCandidateName(candidate);

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

      const schedule = candidate.examSchedule || {};

      if (!validSchedule(schedule)) {
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
      const durationMillis = DURATION_SECONDS * 1000;
      const batchDeadline = scheduledAt + durationMillis;

      // Existing attempt: never create a replacement.
      if (attemptSnapshot.exists) {
        const attempt = attemptSnapshot.data() || {};

        if (
          attempt.attemptId !== attemptId ||
          attempt.examId !== examId ||
          attempt.candidateId !== registrationDoc.id
        ) {
          transaction.update(attemptRef, {
            status: "review_required",
            reviewReason: "ATTEMPT_IDENTITY_MISMATCH",
            reviewRequiredAt:
              admin.firestore.FieldValue.serverTimestamp(),
            updatedAt:
              admin.firestore.FieldValue.serverTimestamp()
          });

          outcome = {
            status: 409,
            body: {
              ok: false,
              code: "ATTEMPT_REQUIRES_ADMIN_REVIEW"
            }
          };
          return;
        }

        if (
          attempt.status === "submitted" ||
          attempt.status === "expired"
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

        if (attempt.status === "in_progress") {
          const startedAt = toMillis(attempt.startedAt);
          const deadlineAt = toMillis(attempt.deadlineAt);
          const savedSchedule = toMillis(attempt.scheduledAt);

          const timestampsValid =
            startedAt !== null &&
            deadlineAt !== null &&
            savedSchedule !== null &&
            savedSchedule === scheduledAt &&
            startedAt >= scheduledAt &&
            startedAt <= now &&
            deadlineAt === batchDeadline;

          if (!timestampsValid) {
            transaction.update(attemptRef, {
              status: "review_required",
              reviewReason: "INVALID_ATTEMPT_TIMESTAMPS",
              reviewRequiredAt:
                admin.firestore.FieldValue.serverTimestamp(),
              updatedAt:
                admin.firestore.FieldValue.serverTimestamp()
            });

            outcome = {
              status: 409,
              body: {
                ok: false,
                code: "ATTEMPT_REQUIRES_ADMIN_REVIEW"
              }
            };
            return;
          }

          if (now >= deadlineAt) {
            transaction.update(attemptRef, {
              status: "expired",
              expiredAt:
                admin.firestore.FieldValue.serverTimestamp(),
              updatedAt:
                admin.firestore.FieldValue.serverTimestamp(),
              expiryReason: "BATCH_DEADLINE_REACHED"
            });

            outcome = {
              status: 409,
              body: {
                ok: false,
                code: "ATTEMPT_ALREADY_USED"
              }
            };
            return;
          }

          // Active attempts can resume even after the entry
          // grace window, provided the original deadline remains.
          outcome = {
            status: 200,
            body: {
              ok: true,
              code: "ATTEMPT_IN_PROGRESS",
              canResume: true,

              candidate: candidateResponse(candidate),

              schedule: scheduleResponse(
                schedule,
                scheduledAt
              )
            }
          };
          return;
        }

        // Unknown or previously flagged status.
        if (attempt.status !== "review_required") {
          transaction.update(attemptRef, {
            status: "review_required",
            reviewReason: "UNKNOWN_ATTEMPT_STATUS",
            reviewRequiredAt:
              admin.firestore.FieldValue.serverTimestamp(),
            updatedAt:
              admin.firestore.FieldValue.serverTimestamp()
          });
        }

        outcome = {
          status: 409,
          body: {
            ok: false,
            code: "ATTEMPT_REQUIRES_ADMIN_REVIEW"
          }
        };
        return;
      }

      // Only new attempts must pass the entry window.
      const entryEndsAt =
        scheduledAt + getEntryWindowSeconds() * 1000;

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
            code: "ENTRY_WINDOW_CLOSED",
            scheduledAt: new Date(scheduledAt).toISOString()
          }
        };
        return;
      }

      if (now >= batchDeadline) {
        outcome = {
          status: 403,
          body: {
            ok: false,
            code: "BATCH_DEADLINE_REACHED"
          }
        };
        return;
      }

      outcome = {
        status: 200,
        body: {
          ok: true,
          code: "ELIGIBLE_TO_CONTINUE",
          canResume: false,

          candidate: candidateResponse(candidate),

          schedule: scheduleResponse(
            schedule,
            scheduledAt
          )
        }
      };
    });

    return respond(res, outcome.status, outcome.body);

  } catch (error) {
    console.error("Candidate verification failed:", error);

    return respond(res, 500, {
      ok: false,
      code: "VERIFICATION_FAILED"
    });
  }
};
