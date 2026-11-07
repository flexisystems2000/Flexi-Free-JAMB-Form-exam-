"use strict";

const { getFirebaseAdmin } = require("./firebase-admin");

function sendError(res, status, code, message) {
  return res.status(status).json({
    ok: false,
    code,
    message
  });
}

async function requireAdmin(req, res) {
  try {
    const authorization = req.headers.authorization || "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      sendError(res, 401, "ADMIN_AUTH_REQUIRED", "Admin authentication required.");
      return null;
    }

    const token = match[1].trim();

    if (!token) {
      sendError(res, 401, "INVALID_ADMIN_TOKEN", "Invalid authentication token.");
      return null;
    }

    const firebaseAdmin = getFirebaseAdmin();

    const decoded = await firebaseAdmin.auth().verifyIdToken(token, true);

    const allowedEmails = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(email => email.trim().toLowerCase())
      .filter(Boolean);

    const adminEmail = String(decoded.email || "").toLowerCase();

    if (
      !adminEmail ||
      !allowedEmails.includes(adminEmail)
    ) {
      sendError(res, 403, "ADMIN_ACCESS_DENIED", "You are not authorized to access this resource.");
      return null;
    }

    return {
      uid: decoded.uid,
      email: adminEmail
    };

  } catch (error) {
    console.error("Admin authentication error:", error.message);

    sendError(res, 401, "ADMIN_AUTH_FAILED", "Admin authentication failed.");
    return null;
  }
}

module.exports = {
  requireAdmin
};
