
"use strict";

const admin = require("firebase-admin");

function getFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return admin;
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    const error = new Error(
      "Firebase service account is not configured."
    );
    error.code = "FIREBASE_CONFIG_MISSING";
    throw error;
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    const error = new Error(
      "Firebase service account JSON is invalid."
    );
    error.code = "FIREBASE_CONFIG_INVALID";
    throw error;
  }

  if (
    serviceAccount.project_id !==
    "free-jamb-form-initiative"
  ) {
    const error = new Error(
      "Incorrect Firebase project configured."
    );
    error.code = "FIREBASE_PROJECT_MISMATCH";
    throw error;
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),

    ...(process.env.FIREBASE_DATABASE_URL
      ? {
          databaseURL: process.env.FIREBASE_DATABASE_URL
        }
      : {})
  });

  return admin;
}

function getFirestore() {
  return getFirebaseAdmin().firestore();
}

module.exports = {
  admin,
  getFirebaseAdmin,
  getFirestore
};
