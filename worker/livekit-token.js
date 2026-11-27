const encoder = new TextEncoder();

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeJson(value) {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

/**
 * Create a short-lived LiveKit participant token inside a trusted server runtime.
 * Never call this in browser code: apiSecret must remain a Worker/VPS secret.
 */
export async function createLiveKitAccessToken({
  apiKey,
  apiSecret,
  identity,
  name,
  room,
  canPublish = false,
  canSubscribe = false,
  ttlSeconds = 3600,
}) {
  if (!apiKey || !apiSecret) throw new Error("LIVEKIT_NOT_CONFIGURED");
  if (!identity || !room) throw new Error("LIVEKIT_IDENTITY_OR_ROOM_REQUIRED");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) {
    throw new Error("LIVEKIT_TOKEN_TTL_INVALID");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeJson({
    iss: apiKey,
    sub: String(identity),
    name: String(name || identity),
    nbf: now - 5,
    exp: now + ttlSeconds,
    video: {
      roomJoin: true,
      room,
      canPublish: Boolean(canPublish),
      canSubscribe: Boolean(canSubscribe),
      canPublishData: false,
    },
  });
  const signingInput = header + "." + payload;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signingInput),
  );

  return signingInput + "." + base64Url(new Uint8Array(signature));
}
