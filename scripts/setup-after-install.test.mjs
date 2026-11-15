import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasConnectionConfig, openSetupTerminal, setupAfterInstall } from "./setup-after-install.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "openviking-postinstall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    env: {
      OPENVIKING_CLI_CONFIG_FILE: join(dir, "ovcli.conf"),
      OPENVIKING_CONFIG_FILE: join(dir, "ov.conf"),
    },
    snapshot: () => readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  };
}

function fakeTerminal() {
  return {
    input: {},
    output: { text: "", write(text) { this.text += text; } },
    closed: 0,
    close() { this.closed++; },
  };
}

test("first interactive installation passes its streams and environment to setup and closes the terminal", async (t) => {
  const { env, snapshot } = fixture(t);
  const terminal = fakeTerminal();
  let calls = 0;
  await setupAfterInstall({
    env,
    openTerminal(options) {
      assert.strictEqual(options.env, env);
      return terminal;
    },
    async wizard(options) {
      calls++;
      assert.strictEqual(options.env, env);
      assert.strictEqual(options.input, terminal.input);
      assert.strictEqual(options.output, terminal.output);
      return { written: true };
    },
  });
  assert.equal(calls, 1);
  assert.equal(terminal.closed, 1);
  assert.match(terminal.output.text, /Connection saved/);
  assert.match(terminal.output.text, /Restart Codex/);
  assert.deepEqual(snapshot(), []);
});

test("declining setup leaves a manual setup reminder and closes the terminal", async (t) => {
  const { env, snapshot } = fixture(t);
  const terminal = fakeTerminal();
  await setupAfterInstall({
    env, openTerminal: () => terminal, wizard: async () => ({ written: false }),
  });
  assert.match(terminal.output.text, /Connection not saved/);
  assert.match(terminal.output.text, /openviking-project-memory setup/);
  assert.equal(terminal.closed, 1);
  assert.deepEqual(snapshot(), []);
});

const existingConnections = [
  { name: "JSON CLI credentials", file: "OPENVIKING_CLI_CONFIG_FILE", value: '{"url":"https://memory.example","api_key":"fixture-key","custom":"retained"}\n' },
  { name: "local URL without an API key", file: "OPENVIKING_CLI_CONFIG_FILE", value: '{"url":"http://127.0.0.1:1933"}\n' },
  { name: "legacy ov.conf", file: "OPENVIKING_CONFIG_FILE", value: '{"server":{"host":"127.0.0.1","port":1933},"codex":{"apiKey":"fixture-key"}}\n' },
  ...["OPENVIKING_URL", "OPENVIKING_BASE_URL", "OPENVIKING_MCP_URL"].map((name) => ({ name, env: { [name]: "http://127.0.0.1:1933" } })),
  ...["OPENVIKING_API_KEY", "OPENVIKING_BEARER_TOKEN"].map((name) => ({ name, env: { [name]: "fixture-key" } })),
  ...["OPENVIKING_CLI_CONFIG_FILE", "OPENVIKING_CONFIG_FILE"].map((file) => ({ name: `malformed ${file}`, file, value: "{ malformed existing configuration\n" })),
];

for (const connection of existingConnections) {
  test(`preserves ${connection.name} without running setup or writing files`, async (t) => {
    const { env, snapshot } = fixture(t);
    Object.assign(env, connection.env);
    if (connection.file) writeFileSync(env[connection.file], connection.value);
    const before = snapshot();
    const terminal = fakeTerminal();
    let calls = 0;
    assert.equal(hasConnectionConfig(env), true);
    await setupAfterInstall({
      env,
      openTerminal: () => terminal,
      wizard: async () => { calls++; return { written: true }; },
    });
    assert.equal(calls, 0);
    assert.equal(terminal.closed, 1);
    assert.match(terminal.output.text, /configuration preserved/);
    assert.deepEqual(snapshot(), before);
  });
}

test("missing files do not count the built-in localhost fallback as configuration", (t) => {
  const { env, snapshot } = fixture(t);
  assert.equal(hasConnectionConfig(env), false);
  assert.deepEqual(snapshot(), []);
});

for (const name of ["OPENVIKING_URL", "OPENVIKING_BASE_URL", "OPENVIKING_MCP_URL"]) {
  test(`forced CLI credentials ignore ${name} and still run setup when no file exists`, async (t) => {
    const { env } = fixture(t);
    Object.assign(env, { OPENVIKING_CREDENTIAL_SOURCE: "cli", [name]: "https://ignored.example" });
    assert.equal(hasConnectionConfig(env), false);
    const terminal = fakeTerminal();
    let calls = 0;
    await setupAfterInstall({
      env,
      openTerminal: () => terminal,
      wizard: async () => { calls++; return { written: false }; },
    });
    assert.equal(calls, 1);
    assert.equal(terminal.closed, 1);
  });
}

for (const ci of [undefined, "true"]) {
  test(`${ci ? "CI" : "no terminal"} skips setup and prints the manual command`, async (t) => {
    const { env, snapshot } = fixture(t);
    if (ci) env.CI = ci;
    const { output } = fakeTerminal();
    let calls = 0;
    await setupAfterInstall({
      env,
      output,
      openTerminal: ({ env }) => ci
        ? openSetupTerminal({ env, input: { isTTY: true }, output: { isTTY: true } })
        : null,
      wizard: async () => { calls++; return { written: true }; },
    });
    assert.equal(calls, 0);
    assert.match(output.text, /openviking-project-memory setup/);
    assert.deepEqual(snapshot(), []);
  });
}

test("setup failures do not expose exception secrets and always close the terminal", async (t) => {
  const { env, snapshot } = fixture(t);
  const terminal = fakeTerminal();
  const secret = "fixture-secret-that-must-not-be-logged";
  await setupAfterInstall({
    env,
    openTerminal: () => terminal,
    wizard: async () => { throw new Error(`Authentication failed for ${secret}`); },
  });
  assert.equal(terminal.closed, 1);
  assert.match(terminal.output.text, /openviking-project-memory setup/);
  assert.equal(terminal.output.text.includes(secret), false);
  assert.equal(terminal.output.text.includes("Authentication failed"), false);
  assert.deepEqual(snapshot(), []);
});

test("closing a directly supplied terminal leaves the user's input and output open", (t) => {
  const { env } = fixture(t);
  let closed = 0;
  const input = { isTTY: true, destroy() { closed++; }, end() { closed++; } };
  const output = { isTTY: true, destroy() { closed++; }, end() { closed++; } };
  const terminal = openSetupTerminal({ env, input, output });
  assert.strictEqual(terminal.input, input);
  assert.strictEqual(terminal.output, output);
  terminal.close();
  assert.equal(closed, 0);
});
