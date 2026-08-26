import assert from "node:assert/strict";
import {
  constants,
  createCipheriv,
  generateKeyPairSync,
  publicEncrypt,
} from "node:crypto";
import test from "node:test";

import {
  connectAndPollForJobReference,
  decodeJitConfig,
  decryptMessageBody,
  decryptSessionKey,
  parseJobReferenceBody,
  parseRunnerIdentity,
  reconstructPrivateKey,
  sanitizeRunServiceUrl,
} from "./github-runner-client.js";

function encodeFile(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function encodeJitConfig({ runner, credentials, rsaParams }) {
  const payload = {
    ".runner": encodeFile(runner),
    ".credentials": encodeFile(credentials),
    ".credentials_rsaparams": encodeFile(rsaParams),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function bigIntToBase64(value) {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }
  return Buffer.from(hex, "hex").toString("base64");
}

function exportDotNetRsaParams(keyPair) {
  const privateKey = keyPair.privateKey.export({ format: "jwk" });
  const n = Buffer.from(privateKey.n, "base64url");
  const e = Buffer.from(privateKey.e, "base64url");
  const d = Buffer.from(privateKey.d, "base64url");
  const p = Buffer.from(privateKey.p, "base64url");
  const q = Buffer.from(privateKey.q, "base64url");

  let nBig = 0n;
  for (const byte of n) nBig = (nBig << 8n) + BigInt(byte);
  let eBig = 0n;
  for (const byte of e) eBig = (eBig << 8n) + BigInt(byte);
  let dBig = 0n;
  for (const byte of d) dBig = (dBig << 8n) + BigInt(byte);
  let pBig = 0n;
  for (const byte of p) pBig = (pBig << 8n) + BigInt(byte);
  let qBig = 0n;
  for (const byte of q) qBig = (qBig << 8n) + BigInt(byte);

  return {
    Modulus: bigIntToBase64(nBig),
    Exponent: bigIntToBase64(eBig),
    D: bigIntToBase64(dBig),
    P: bigIntToBase64(pBig),
    Q: bigIntToBase64(qBig),
    DP: "",
    DQ: "",
    InverseQ: "",
  };
}

function pkcs7Pad(data, blockSize) {
  const padLen = blockSize - (data.length % blockSize);
  return Buffer.concat([data, Buffer.alloc(padLen, padLen)]);
}

function encryptMessageBody(plaintext, sessionKey) {
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv("aes-256-cbc", sessionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(pkcs7Pad(Buffer.from(plaintext, "utf8"), 16)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, ciphertext]).toString("base64");
}

function buildFixture() {
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaParams = exportDotNetRsaParams(keyPair);
  const privateKey = reconstructPrivateKey(rsaParams);

  const runner = {
    agentId: 42,
    agentName: "dcp-test-runner",
    serverUrlV2: "https://broker.example.test/",
    poolId: 1,
  };
  const credentials = {
    scheme: "OAuth",
    data: {
      clientId: "client-123",
      authorizationUrl: "https://token.example.test/oauth2/token",
    },
  };

  const encodedJitConfig = encodeJitConfig({
    runner,
    credentials,
    rsaParams,
  });

  const identity = parseRunnerIdentity(decodeJitConfig(encodedJitConfig));
  const sessionKey = Buffer.alloc(32, 9);
  const encryptedSessionKey = publicEncrypt(
    {
      key: keyPair.publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    sessionKey
  );

  const jobBody = JSON.stringify({
    runner_request_id: "req-abc",
    run_service_url: "https://run.example.test/_apis/Worker/acquirejob?secret=1",
    billing_owner_id: "owner-xyz",
  });
  const encryptedBody = encryptMessageBody(jobBody, sessionKey);

  return {
    keyPair,
    privateKey,
    encodedJitConfig,
    identity,
    sessionKey,
    encryptedSessionKey,
    encryptedBody,
    jobBody,
  };
}

test("decodeJitConfig and parseRunnerIdentity extract broker credentials", () => {
  const fixture = buildFixture();
  const files = decodeJitConfig(fixture.encodedJitConfig);
  const identity = parseRunnerIdentity(files);

  assert.equal(identity.agentId, 42);
  assert.equal(identity.agentName, "dcp-test-runner");
  assert.equal(identity.brokerUrl, "https://broker.example.test");
  assert.equal(identity.clientId, "client-123");
  assert.equal(identity.authorizationUrl, "https://token.example.test/oauth2/token");
});

test("decryptSessionKey unwraps RSA-OAEP SHA-1 session keys", () => {
  const fixture = buildFixture();
  const plain = decryptSessionKey(fixture.encryptedSessionKey, fixture.privateKey);
  assert.deepEqual(plain, fixture.sessionKey);
});

test("decryptMessageBody decrypts AES-256-CBC broker payloads", () => {
  const fixture = buildFixture();
  const plain = decryptMessageBody(fixture.encryptedBody, fixture.sessionKey);
  assert.equal(plain, fixture.jobBody);
});

test("parseJobReferenceBody extracts non-secret job metadata", () => {
  const reference = parseJobReferenceBody(
    JSON.stringify({
      runner_request_id: "req-abc",
      run_service_url: "https://run.example.test/acquirejob",
      billing_owner_id: "owner-xyz",
    })
  );

  assert.equal(reference.runnerRequestId, "req-abc");
  assert.equal(reference.runServiceUrl, "https://run.example.test/acquirejob");
  assert.equal(reference.billingOwnerId, "owner-xyz");
  assert.equal(
    sanitizeRunServiceUrl(reference.runServiceUrl),
    "https://run.example.test/acquirejob"
  );
});

test("pollForJobReference retries on 202 and never calls acquirejob", async () => {
  const fixture = buildFixture();
  const requests = [];
  let pollCount = 0;

  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? "GET" });

    if (String(url).includes("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "oauth-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (String(url).endsWith("/session") && init.method === "POST") {
      return new Response(
        JSON.stringify({
          sessionId: "session-1",
          brokerURL: fixture.identity.brokerUrl,
          encryptionKey: {
            encrypted: true,
            value: fixture.encryptedSessionKey.toString("base64"),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (String(url).includes("/message")) {
      pollCount += 1;
      if (pollCount === 1) {
        return new Response("", { status: 202 });
      }
      return new Response(
        JSON.stringify({
          messageId: 99,
          messageType: "RunnerJobRequest",
          body: fixture.encryptedBody,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (String(url).endsWith("/session") && init.method === "DELETE") {
      return new Response("", { status: 204 });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await connectAndPollForJobReference(fixture.encodedJitConfig, {
    fetchImpl,
    runnerVersion: "2.336.0",
  });

  assert.equal(result.jobReference.messageId, 99);
  assert.equal(result.jobReference.messageType, "RunnerJobRequest");
  assert.equal(result.jobReference.runnerRequestId, "req-abc");
  assert.equal(result.jobReference.billingOwnerId, "owner-xyz");
  assert.equal(pollCount, 2);
  assert.ok(
    requests.every((request) => !String(request.url).includes("acquirejob"))
  );
});

test("deleteBrokerSession is invoked during connectAndPoll cleanup", async () => {
  const fixture = buildFixture();
  let deleteCalled = false;

  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "oauth-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).endsWith("/session") && init.method === "POST") {
      return new Response(
        JSON.stringify({
          sessionId: "session-1",
          encryptionKey: {
            encrypted: true,
            value: fixture.encryptedSessionKey.toString("base64"),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (String(url).includes("/message")) {
      return new Response(
        JSON.stringify({
          messageId: 1,
          messageType: "RunnerJobRequest",
          body: fixture.encryptedBody,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (String(url).endsWith("/session") && init.method === "DELETE") {
      deleteCalled = true;
      return new Response("", { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  await connectAndPollForJobReference(fixture.encodedJitConfig, { fetchImpl });
  assert.equal(deleteCalled, true);
});
