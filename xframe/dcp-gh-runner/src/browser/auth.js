import { signJwt, bytesToBase64Url } from './crypto.js';

/**
 * @param {import('./jit-config.js').RunnerIdentity} identity
 * @param {typeof fetch} fetchImpl
 */
export async function fetchRunnerOAuthToken(identity, fetchImpl = fetch) {
  const now = Math.floor(Date.now() / 1000);
  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    sub: identity.clientId,
    iss: identity.clientId,
    aud: identity.authorizationUrl,
    nbf: now,
    exp: now + 300,
    jti: crypto.randomUUID(),
  })));

  const assertion = await signJwt(header, payload, identity.privateKey.signKey);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  });

  const response = await fetchImpl(identity.authorizationUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Runner OAuth token exchange failed (${response.status}): ${responseText}`);
  }
  const parsed = JSON.parse(responseText);
  if (!parsed.access_token) throw new Error('Runner OAuth token response missing access_token');
  return parsed.access_token;
}
