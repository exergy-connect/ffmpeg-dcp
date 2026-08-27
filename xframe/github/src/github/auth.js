import { createSign, randomUUID } from "node:crypto";

/**
 * @param {string} headerB64
 * @param {string} payloadB64
 * @param {import("node:crypto").KeyObject} privateKey
 */
function signJwt(headerB64, payloadB64, privateKey) {
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * @param {import("./jit-config.js").RunnerIdentity} identity
 * @param {typeof fetch} fetchImpl
 */
export async function fetchRunnerOAuthToken(identity, fetchImpl = fetch) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: identity.clientId,
      iss: identity.clientId,
      aud: identity.authorizationUrl,
      nbf: now,
      exp: now + 300,
      jti: randomUUID(),
    })
  ).toString("base64url");

  const assertion = signJwt(header, payload, identity.privateKey);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });

  const response = await fetchImpl(identity.authorizationUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Runner OAuth token exchange failed (${response.status}): ${responseText}`
    );
  }

  const parsed = JSON.parse(responseText);
  if (!parsed.access_token) {
    throw new Error("Runner OAuth token response missing access_token");
  }
  return parsed.access_token;
}
