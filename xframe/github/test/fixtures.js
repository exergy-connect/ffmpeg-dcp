import {
  constants,
  createCipheriv,
  generateKeyPairSync,
  publicEncrypt,
} from "node:crypto";

import {
  decodeJitConfig,
  decryptMessageBody,
  decryptSessionKey,
  parseRunnerIdentity,
  reconstructPrivateKey,
} from "../src/index.js";

export function encodeFile(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

export function encodeJitConfig({ runner, credentials, rsaParams }) {
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

export function exportDotNetRsaParams(keyPair) {
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

export function encryptMessageBody(plaintext, sessionKey) {
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv("aes-256-cbc", sessionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(pkcs7Pad(Buffer.from(plaintext, "utf8"), 16)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, ciphertext]).toString("base64");
}

export function buildFixture() {
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
