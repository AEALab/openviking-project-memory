// Community modification (2026-11-05): project routing and configurable multi-library reads.
import assert from "node:assert/strict";
import test from "node:test";
import { extractCaptureTurns } from "./capture-utils.mjs";
import { buildProfileBlock } from "./shared/profile-inject.mjs";

const privateText = "SYNTHETIC_PRIVATE_RETRIEVAL_321";
const wrapper = `<openviking-read-source name="local">${privateText}</openviking-read-source>`;
const cfg = { captureAssistantTurns: true };

test("injected text is stripped from both summaries and actual capture parts without moving cursors", () => {
  const entries = [
    { payload: { role: "user", content: `Real user prompt here. <openviking-context>${wrapper}</openviking-context>` } },
    { payload: { role: "user", content: wrapper } },
  ];
  const turns = extractCaptureTurns(entries, cfg);
  assert.equal(turns.length, 2);
  assert.match(turns[0].parts[0].text, /Real user prompt here/);
  assert.match(turns[1].parts[0].text, /omitted/);
  assert.ok(!JSON.stringify(turns).includes(privateText));
});

test("native MCP, function, and custom read outputs are not rearchived", () => {
  const result = { content: [{ type: "text", text: wrapper }],
    structuredContent: { private: privateText }, _meta: { openvikingRead: true } };
  const forms = [
    [{ payload: { type: "mcp_tool_call_end", call_id: "a", invocation: { tool: "read", arguments: {} }, result: { Ok: result } } }],
    [{ payload: { type: "function_call", id: "a", name: "read", arguments: "{}" } },
      { payload: { type: "function_call_output", call_id: "a", output: JSON.stringify(result) } }],
    [{ payload: { type: "custom_tool_call", id: "a", name: "read", input: "{}" } },
      { payload: { type: "custom_tool_call_output", call_id: "a", output: JSON.stringify(result) } }],
  ];
  for (const entries of forms) {
    const turns = extractCaptureTurns(entries, cfg);
    assert.equal(turns.length, 2);
    const outputs = turns.flatMap((t) => t.parts).filter((p) => p.tool_output);
    assert.equal(outputs.length, 1);
    assert.match(outputs[0].tool_output, /omitted/);
    assert.ok(!JSON.stringify(turns).includes(privateText));
  }
});

test("ordinary tool output and user/assistant text stay intact", () => {
  const entries = [
    { payload: { role: "user", content: "Ordinary user request." } },
    { payload: { role: "assistant", content: "Ordinary assistant response." } },
    { payload: { type: "function_call_output", call_id: "a", output: "Ordinary build output." } },
  ];
  const turns = extractCaptureTurns(entries, cfg);
  assert.equal(turns[0].parts[0].text, "Ordinary user request.");
  assert.equal(turns[1].parts[0].text, "Ordinary assistant response.");
  assert.equal(turns[2].parts[0].tool_output, "Ordinary build output.");
});

test("profile user-path discovery is scoped to each request client", async () => {
  function client(user, calls) {
    return async (path) => {
      calls.push(path);
      if (path === "/api/v1/system/status") return { ok: true, result: { user } };
      const uri = new URL(path, "http://synthetic.test").searchParams.get("uri");
      if (uri === "viking://user") return { ok: true, result: [{ name: user, isDir: true }] };
      if (uri?.endsWith("/profile.md")) return { ok: true, result: `${user} profile content.` };
      return { ok: true, result: [] };
    };
  }
  const local = [], team = [];
  await buildProfileBlock(client("synthetic-personal", local), 1000);
  await buildProfileBlock(client("synthetic-team", team), 1000);
  assert.ok(team.includes("/api/v1/system/status"));
  assert.ok(!team.some((p) => decodeURIComponent(p).includes("synthetic-personal")));
});
