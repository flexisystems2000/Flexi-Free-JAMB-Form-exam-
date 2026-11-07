"use strict";

const crypto = require("crypto");
const { getFirebaseAdmin, admin } = require("../../lib/firebase-admin");
const {
  requireCandidateSession,
  CbtAuthError
} = require("../../lib/cbt-auth");

const EXAM_ID = process.env.CBT_EXAM_ID || "jamb-2026-11-28";
const EVENT_COOLDOWN_MS = 10000;

const EVENTS = {
  CAMERA_DISCONNECTED: {
    severity: "high",
    label: "Candidate camera disconnected"
  },
  CAMERA_RECONNECTED: {
    severity: "info",
    label: "Candidate camera reconnected"
  },
  CAMERA_PERMISSION_LOST: {
    severity: "high",
    label: "Camera permission lost"
  },
  MICROPHONE_DISCONNECTED: {
    severity: "high",
    label: "Candidate microphone disconnected"
  },
  MICROPHONE_RECONNECTED: {
    severity: "info",
    label: "Candidate microphone reconnected"
  },
  MICROPHONE_PERMISSION_LOST: {
    severity: "high",
    label: "Microphone permission lost"
  },
  FULLSCREEN_EXITED: {
    severity: "medium",
    label: "Candidate exited fullscreen"
  },
  TAB_HIDDEN: {
    severity: "medium",
    label: "Candidate left the examination tab"
  },
  TAB_VISIBLE: {
    severity: "info",
    label: "Candidate returned to the examination tab"
  },
  NETWORK_DISCONNECTED: {
    severity: "medium",
    label: "Candidate network connection lost"
  },
  NETWORK_RECONNECTED: {
    severity: "info",
    label: "Candidate network connection restored"
  }
};

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

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, {
      ok: false,
      code: "METHOD_NOT_ALLOWED"
    });
  }

  const eventType = String(req.body?.eventType || "")
    .trim()
    .toUpperCase();

  const event = EVENTS[eventType];

  if (!event) {
    return send(res, 400, {
      ok: false,
      code: "INVALID_PROCTOR_EVENT"
    });
  }

  try {
    // Candidate identity comes from the signed session, never the request body.
    const session = await requireCandidateSession(req);

    if (session.examId !== EXAM_ID) {
      return send(res, 403, {
        ok: false,
        code: "SESSION_EXAM_MISMATCH"
      });
    }

    const firebase = getFirebaseAdmin();
    const db = firebase.firestore();

    const attemptRef = db.collection("cbt_attempts")
      .doc(session.attemptId);

    const sessionRef = attemptRef.collection("private")
      .doc("session");

    const stateRef = attemptRef.collection("private")
      .doc("proctor_state");

    const alertRef = db.collection("cbt_alerts")
      .doc(crypto.randomUUID());

    const result = await db.runTransaction(async tx => {
      const [attemptSnap, sessionSnap, stateSnap] = await Promise.all([
        tx.get(attemptRef),
        tx.get(sessionRef),
        tx.get(stateRef)
      ]);

      if (!attemptSnap.exists || !sessionSnap.exists) {
        throw Object.assign(new Error("SESSION_NOT_FOUND"), {
          status: 401
        });
      }

      const attempt = attemptSnap.data() || {};
      const savedSession = sessionSnap.data() || {};

      if (
        attempt.attemptId !== session.attemptId ||
        attempt.candidateId !== session.candidateId ||
        attempt.examId !== EXAM_ID ||
        savedSession.sessionId !== session.sessionId ||
        savedSession.candidateId !== session.candidateId
      ) {
        throw Object.assign(new Error("SESSION_IDENTITY_MISMATCH"), {
          status: 403
        });
      }

      if (attempt.status !== "in_progress") {
        throw Object.assign(new Error("ATTEMPT_NOT_ACTIVE"), {
          status: 409
        });
      }

      const deadline = toMillis(attempt.deadlineAt);
      const now = Date.now();

      if (deadline === null || now >= deadline) {
        throw Object.assign(new Error("EXAM_TIME_EXPIRED"), {
          status: 409
        });
      }

      const state = stateSnap.exists ? stateSnap.data() || {} : {};
      const previousEvents = state.lastEventAtByType || {};
      const lastEventAt = Number(previousEvents[eventType] || 0);

      // Suppress repeated identical events within the cooldown window.
      if (lastEventAt && now - lastEventAt < EVENT_COOLDOWN_MS) {
        return {
          suppressed: true,
          code: "DUPLICATE_EVENT_SUPPRESSED"
        };
      }

      const stamp = admin.firestore.FieldValue.serverTimestamp();

      tx.create(alertRef, {
        examId: EXAM_ID,
        attemptId: session.attemptId,
        candidateId: session.candidateId,
        registrationNumber: attempt.registrationNumber || null,
        candidateName: attempt.fullName || null,
        batch: attempt.batch || null,
        eventType,
        severity: event.severity,
        message: event.label,
        status: "open",
        createdAt: stamp,
        resolvedAt: null,
        resolvedBy: null
      });

      tx.set(stateRef, {
        lastEventAtByType: {
          ...previousEvents,
          [eventType]: now
        },
        updatedAt: stamp
      }, { merge: true });

      return {
        suppressed: false,
        alertId: alertRef.id
      };
    });

    return send(res, 200, {
      ok: true,
      code: result.code || "PROCTOR_EVENT_RECORDED",
      recorded: !result.suppressed,
      alertId: result.alertId || null
    });

  } catch (error) {
    if (error instanceof CbtAuthError) {
      return send(res, error.status || 401, {
        ok: false,
        code: error.code
      });
    }

    const code = String(error.code || error.message || "");
    const known = {
      SESSION_NOT_FOUND: 401,
      SESSION_IDENTITY_MISMATCH: 403,
      ATTEMPT_NOT_ACTIVE: 409,
      EXAM_TIME_EXPIRED: 409
    };

    if (known[code]) {
      return send(res, known[code], {
        ok: false,
        code
      });
    }

    console.error("PROCTOR EVENT ERROR:", error);

    return send(res, 500, {
      ok: false,
      code: "PROCTOR_EVENT_FAILED"
    });
  }
};
