"use strict";

module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED"
    });
  }

  return res.status(200).json({
    ok: true,
    service: "flexi-free-jamb-form-exam",
    phase: "initial-scaffold",
    timestamp: new Date().toISOString()
  });
};
