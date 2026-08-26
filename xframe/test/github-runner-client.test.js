import assert from "node:assert/strict";
import {
  constants,
  createCipheriv,
  generateKeyPairSync,
  publicEncrypt,
  randomUUID,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireJob,
  connectAndPollForJobReference,
  decodeJitConfig,
  decryptMessageBody,
  decryptSessionKey,
  parseAcquiredJobMetadata,
  parseAcquiredJobSteps,
  parseAcquiredJobEnvironment,
  parseJobReferenceBody,
  parseRunnerIdentity,
  shouldExecuteAcquiredJob,
  executeAcquiredJobSteps,
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

test("pollForJobReference retries on 202 without acquiring by default", async () => {
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

test("connectAndPollForJobReference can acquire jobs when requested", async () => {
  const fixture = buildFixture();
  let acquireBody = null;

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
    if (String(url).includes("/acquirejob")) {
      acquireBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          plan: { planId: "plan-123" },
          job: {
            displayName: "Probe JIT / self-hosted runner",
            workflowRef: "refs/heads/main",
            repositoryName: "exergy-connect/ffmpeg-dcp",
          },
          contextData: {
            github: {
              repository: "exergy-connect/ffmpeg-dcp",
              workflow: ".github/workflows/ci.yml",
              ref: "refs/heads/main",
              job: "probe-self-hosted-runner",
            },
          },
          resources: {
            endpoints: [
              {
                name: "SystemVssConnection",
                authorization: {
                  parameters: {
                    AccessToken: "job-token",
                  },
                },
              },
            ],
          },
          variables: [{ name: "GITHUB_TOKEN", isSecret: true }],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-plan-id": "plan-header",
          },
        }
      );
    }
    if (String(url).endsWith("/session") && init.method === "DELETE") {
      return new Response("", { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const result = await connectAndPollForJobReference(fixture.encodedJitConfig, {
    fetchImpl,
    acquire: true,
  });

  assert.deepEqual(acquireBody, {
    jobMessageId: "req-abc",
    runnerOS: "Linux",
    billingOwnerId: "owner-xyz",
  });
  assert.equal(result.acquiredJob.planId, "plan-header");
  assert.equal(result.acquiredJob.jobAuthToken, "job-token");
  assert.equal(result.jobMetadata.jobName, "Probe JIT / self-hosted runner");
  assert.equal(result.jobMetadata.workflowRef, "refs/heads/main");
  assert.equal(result.jobMetadata.workflowFile, ".github/workflows/ci.yml");
  assert.deepEqual(result.jobMetadata.secretVariableNames, ["GITHUB_TOKEN"]);
});

test("parseAcquiredJobMetadata reads contextData and system variables", () => {
  const metadata = parseAcquiredJobMetadata(
    {
      plan: { planId: "plan-123" },
      jobDisplayName: "Probe JIT / self-hosted runner",
      contextData: {
        github: {
          repository: { t: 0, s: "exergy-connect/ffmpeg-dcp" },
          workflow: { t: 0, s: ".github/workflows/self-hosted-runner-test.yml" },
          ref: { t: 0, s: "refs/heads/main" },
          job: { t: 0, s: "probe-self-hosted-runner" },
        },
      },
      variables: {
        "system.jobDisplayName": { value: "ignored when top-level present", isSecret: false },
        GITHUB_TOKEN: { isSecret: true },
      },
    },
    {
      messageId: 1,
      messageType: "RunnerJobRequest",
      runnerRequestId: "req-abc",
      runServiceUrl: "https://run.example.test/",
      billingOwnerId: "owner",
    }
  );

  assert.equal(metadata.jobName, "Probe JIT / self-hosted runner");
  assert.equal(metadata.repository, "exergy-connect/ffmpeg-dcp");
  assert.equal(
    metadata.workflowFile,
    ".github/workflows/self-hosted-runner-test.yml"
  );
  assert.equal(metadata.workflowRef, "refs/heads/main");
  assert.deepEqual(metadata.secretVariableNames, ["GITHUB_TOKEN"]);
});

test("parseAcquiredJobMetadata accepts object-shaped variables", () => {
  const metadata = parseAcquiredJobMetadata(
    {
      plan: { planId: "plan-123" },
      job: { displayName: "probe" },
      variables: {
        GITHUB_TOKEN: { isSecret: true },
        VIDEO_URL: { isSecret: false },
      },
    },
    {
      messageId: 1,
      messageType: "RunnerJobRequest",
      runnerRequestId: "req-abc",
      runServiceUrl: "https://run.example.test/",
      billingOwnerId: "owner",
    }
  );

  assert.deepEqual(metadata.secretVariableNames, ["GITHUB_TOKEN"]);
});

test("parseAcquiredJobSteps reads plain run and uses steps", () => {
  const steps = parseAcquiredJobSteps({
    steps: [
      {
        order: 1,
        displayName: "Checkout",
        reference: { type: "node", path: "actions/checkout" },
        inputs: { fetchDepth: "2" },
      },
      {
        order: 2,
        displayName: "Probe runner",
        reference: { type: "script", name: "script" },
        inputs: {
          script: "echo \"Runner OS: ${RUNNER_OS}\"\necho \"Video path: ${VIDEO_PATH}\"",
        },
      },
    ],
  });

  assert.equal(steps.length, 2);
  assert.equal(steps[0].kind, "uses");
  assert.equal(steps[0].uses, "actions/checkout");
  assert.equal(steps[1].kind, "run");
  assert.equal(steps[1].displayName, "Probe runner");
  assert.match(steps[1].script, /echo "Runner OS:/);
});

test("parseAcquiredJobSteps unwraps TemplateToken-encoded scripts", () => {
  const steps = parseAcquiredJobSteps({
    steps: [
      {
        displayName: "Resolve uploaded video",
        reference: { type: "script", name: "script" },
        inputs: {
          script: {
            t: 0,
            s: "echo \"Video URL: ${VIDEO_URL}\"",
          },
        },
      },
    ],
  });

  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, "run");
  assert.equal(steps[0].script, 'echo "Video URL: ${VIDEO_URL}"');
});

test("parseAcquiredJobEnvironment maps workflow variables into env", () => {
  const env = parseAcquiredJobEnvironment(
    {
      variables: {
        VIDEO_URL: {
          value: "https://example.test/video.mp4",
          isSecret: false,
        },
        GITHUB_REPOSITORY: { value: "exergy-connect/ffmpeg-dcp", isSecret: false },
      },
    },
    { runnerName: "dcp-test-runner" }
  );

  assert.equal(env.VIDEO_URL, "https://example.test/video.mp4");
  assert.equal(env.GITHUB_REPOSITORY, "exergy-connect/ffmpeg-dcp");
  assert.equal(env.RUNNER_NAME, "dcp-test-runner");
  assert.ok(env.RUNNER_OS);
});

test("shouldExecuteAcquiredJob matches process-video job id and display name", () => {
  assert.equal(
    shouldExecuteAcquiredJob(
      { contextData: { github: { job: "process-video" } } },
      { jobName: "anything" }
    ),
    true
  );
  assert.equal(
    shouldExecuteAcquiredJob(
      { contextData: { github: {} } },
      { jobName: "Process video on self-hosted runner" }
    ),
    true
  );
  assert.equal(
    shouldExecuteAcquiredJob(
      { contextData: { github: { job: "resolve-video-url" } } },
      { jobName: "Resolve video URL" }
    ),
    false
  );
});

test("executeAcquiredJobSteps runs shell steps with the acquired env", async () => {
  const outputPath = path.join(os.tmpdir(), `runner-step-${randomUUID()}.txt`);
  const steps = parseAcquiredJobSteps({
    steps: [
      {
        displayName: "Verify runner received video URL",
        reference: { type: "script", name: "script" },
        inputs: {
          script: `test -n "$VIDEO_URL"\necho "$VIDEO_URL" > "${outputPath}"`,
        },
      },
    ],
  });

  const result = await executeAcquiredJobSteps(steps, {
    ...process.env,
    VIDEO_URL: "https://example.test/video.mp4",
  });

  assert.equal(result.success, true);
  assert.equal(
    fs.readFileSync(outputPath, "utf8").trim(),
    "https://example.test/video.mp4"
  );
  fs.unlinkSync(outputPath);
});

test("executeAcquiredJobSteps skips uses steps", async () => {
  const steps = parseAcquiredJobSteps({
    steps: [
      {
        displayName: "Checkout",
        reference: { type: "node", path: "actions/checkout" },
        inputs: { uses: "actions/checkout@v4" },
      },
      {
        displayName: "Echo",
        reference: { type: "script", name: "script" },
        inputs: { script: "echo ok" },
      },
    ],
  });

  const skipped = [];
  const result = await executeAcquiredJobSteps(steps, process.env, {
    onStepSkip(step) {
      skipped.push(step.displayName);
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(skipped, ["Checkout"]);
});
