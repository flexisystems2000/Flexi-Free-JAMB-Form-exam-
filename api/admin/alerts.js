"use strict";

const { getFirebaseAdmin, admin } = require("../../lib/firebase-admin");
const { requireAdmin } = require("../../lib/admin-auth");

const EXAM_ID = process.env.CBT_EXAM_ID || "jamb-2026-11-28";
const MAX_ALERTS = 100;

function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  return res.status(status).json(body);
}

function toISO(value) {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }

  if (typeof value.toMillis === "function") {
    return new Date(value.toMillis()).toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "GET" && req.method !== "PATCH") {
    res.setHeader("Allow", "GET, PATCH");
    return send(res, 405, {
      ok: false,
      code: "METHOD_NOT_ALLOWED"
    });
  }

  const adminUser = await requireAdmin(req, res);
  if (!adminUser) return;

  try {
    const firebase = getFirebaseAdmin();
    const db = firebase.firestore();

    // Resolve a specific alert.
    if (req.method === "PATCH") {
      const alertId = String(req.body?.alertId || "").trim();
      const action = String(req.body?.action || "").trim().toLowerCase();

      if (!alertId || alertId.length > 150) {
        return send(res, 400, {
          ok: false,
          code: "INVALID_ALERT_ID"
        });
      }

      if (action !== "resolve") {
        return send(res, 400, {
          ok: false,
          code: "INVALID_ALERT_ACTION"
        });
      }

      const alertRef = db.collection("cbt_alerts").doc(alertId);

      const result = await db.runTransaction(async tx => {
        const snap = await tx.get(alertRef);

        if (!snap.exists) {
          return { missing: true };
        }

        const alert = snap.data() || {};

        if (alert.examId !== EXAM_ID) {
          return { forbidden: true };
        }

        if (alert.status === "resolved") {
          return { alreadyResolved: true };
        }

        const stamp = admin.firestore.FieldValue.serverTimestamp();

        tx.update(alertRef, {
          status: "resolved",
          resolvedAt: stamp,
          resolvedBy: adminUser.email,
          updatedAt: stamp
        });

        return { resolved: true };
      });

      if (result.missing) {
        return send(res, 404, {
          ok: false,
          code: "ALERT_NOT_FOUND"
        });
      }

      if (result.forbidden) {
        return send(res, 403, {
          ok: false,
          code: "ALERT_EXAM_MISMATCH"
        });
      }

      return send(res, 200, {
        ok: true,
        code: result.alreadyResolved
          ? "ALERT_ALREADY_RESOLVED"
          : "ALERT_RESOLVED"
      });
    }

    // Retrieve recent alerts.
    const requestedStatus = String(req.query.status || "all")
      .trim()
      .toLowerCase();

    if (!["all", "open", "resolved"].includes(requestedStatus)) {
      return send(res, 400, {
        ok: false,
        code: "INVALID_ALERT_STATUS"
      });
    }

    const snapshot = await db.collection("cbt_alerts")
      .where("examId", "==", EXAM_ID)
      .orderBy("createdAt", "desc")
      .limit(MAX_ALERTS)
      .get();

    let alerts = snapshot.docs.map(doc => {
      const item = doc.data() || {};

      return {
        alertId: doc.id,
        candidateId: item.candidateId || null,
        candidateName: item.candidateName || null,
        registrationNumber: item.registrationNumber || null,
        attemptId: item.attemptId || null,
        batch: item.batch || null,
        eventType: item.eventType || null,
        severity: item.severity || "medium",
        message: item.message || "Examination warning",
        status: item.status || "open",
        createdAt: toISO(item.createdAt),
        resolvedAt: toISO(item.resolvedAt),
        resolvedBy: item.resolvedBy || null
      };
    });

    if (requestedStatus !== "all") {
      alerts = alerts.filter(alert =>
        alert.status === requestedStatus
      );
    }

    const counts = {
      returned: alerts.length,
      open: alerts.filter(alert => alert.status === "open").length,
      resolved: alerts.filter(alert => alert.status === "resolved").length
    };

    return send(res, 200, {
      ok: true,
      examId: EXAM_ID,
      counts,
      alerts
    });

  } catch (error) {
    console.error("ADMIN ALERTS ERROR:", error);

    return send(res, 500, {
      ok: false,
      code: "ADMIN_ALERTS_FAILED"
    });
  }
};
