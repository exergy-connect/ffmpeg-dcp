import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs } from "../src/cli.js";

test("parseCliArgs defaults to listen command", () => {
  assert.deepEqual(parseCliArgs([]), {
    command: "listen",
    showJitConfig: false,
  });
});

test("parseCliArgs handles register and show-jit-config", () => {
  assert.deepEqual(parseCliArgs(["register", "--show-jit-config"]), {
    command: "register",
    showJitConfig: true,
  });
});

test("parseCliArgs handles help", () => {
  assert.deepEqual(parseCliArgs(["--help"]), {
    command: "help",
    showJitConfig: false,
  });
});

test("parseCliArgs rejects unknown positional flags only", () => {
  assert.deepEqual(parseCliArgs(["listen"]), {
    command: "listen",
    showJitConfig: false,
  });
});
