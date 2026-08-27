import assert from "node:assert/strict";
import test from "node:test";

import { registerJitRunner } from "../src/index.js";

test("registerJitRunner validates required environment", async () => {
  await assert.rejects(
    () => registerJitRunner({ owner: "", repo: "", token: "" }),
    /Set GITHUB_OWNER, GITHUB_REPO and GITHUB_TOKEN/
  );
});

test("registerJitRunner posts generate-jitconfig with defaults", async () => {
  let requestUrl = "";
  let requestBody = null;
  const fetchImpl = async (url, init = {}) => {
    requestUrl = String(url);
    requestBody = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        runner: {
          id: 7,
          name: requestBody.name,
          labels: requestBody.labels.map((name) => ({ name })),
        },
        encoded_jit_config: "encoded",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const result = await registerJitRunner({
    owner: "org",
    repo: "repo",
    token: "token",
    name: "dcp-test",
    labels: ["dcp", "wasm", "video"],
    fetchImpl,
  });

  assert.match(requestUrl, /generate-jitconfig$/);
  assert.equal(requestBody.name, "dcp-test");
  assert.deepEqual(requestBody.labels, ["dcp", "wasm", "video"]);
  assert.equal(result.encoded_jit_config, "encoded");
});

test("registerJitRunner surfaces GitHub API errors", async () => {
  const fetchImpl = async () =>
    new Response("forbidden", { status: 403 });

  await assert.rejects(
    () =>
      registerJitRunner({
        owner: "org",
        repo: "repo",
        token: "token",
        fetchImpl,
      }),
    /GitHub returned 403/
  );
});
