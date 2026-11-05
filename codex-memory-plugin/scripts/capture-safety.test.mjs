import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { extractCaptureTurns } from "./capture-utils.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
function respond(res, result = {}) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", result }));
}
async function fixture(t, handler) {
  const home = await mkdtemp(join(tmpdir(), "ov-capture-safety-"));
  const transcript = join(home, "transcript.jsonl");
  await writeFile(transcript, [
    { payload: { message: { role: "user", content: "synthetic private preference" } } },
    { payload: { message: { role: "assistant", content: "synthetic preference acknowledged" } } },
  ].map(JSON.stringify).join("\n"));
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    await handler(req, res, raw ? JSON.parse(raw) : null);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  const url = "http://127.0.0.1:" + server.address().port;
  function run(script, session = "shared", extra = {}) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENVIKING_")));
    Object.assign(env, { HOME: home, USERPROFILE: home, OPENVIKING_CREDENTIAL_SOURCE: "env",
      OPENVIKING_URL: url, OPENVIKING_API_KEY: "synthetic-key",
      OPENVIKING_CONFIG_FILE: join(home, "missing-server"), OPENVIKING_CLI_CONFIG_FILE: join(home, "missing-client"),
      OPENVIKING_CODEX_STATE_DIR: join(home, "state"), OPENVIKING_CAPTURE_TIMEOUT_MS: "2000",
      OPENVIKING_WORKSPACE_PEER: "0", OPENVIKING_RECALL_COMPRESS: "0",
      OPENVIKING_RECALL_COMPRESS_DETECT_ON_STARTUP: "0", OPENVIKING_NO_AUTO_INJECT: "1",
      OPENVIKING_WRITE_PATH_ASYNC: "1", OV_HOOK_WORKER: "1", ...extra });
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(scripts, script)], { env, cwd: home, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(stderr || "hook failed: " + code));
        else resolve(JSON.parse(stdout.trim()));
      });
      child.stdin.end(JSON.stringify({ session_id: session, transcript_path: transcript,
        prompt: "recall this synthetic preference", source: "startup" }));
    });
  }
  return { home, transcript, run };
}

test("overlapping Stop workers send each turn only once", async (t) => {
  const batches = [];
  const f = await fixture(t, async (req, res, body) => {
    if (req.url === "/health") { await delay(100); respond(res, { healthy: true }); }
    else if (req.url.endsWith("/messages/batch")) { batches.push(body.messages); respond(res); }
    else respond(res, { pending_tokens: 2 });
  });
  await Promise.all([f.run("auto-capture.mjs"), f.run("auto-capture.mjs")]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  const state = JSON.parse(await readFile(join(f.home, "state", "shared.json"), "utf8"));
  assert.equal(state.capturedTurnCount, 2);
});

test("PreCompact waits for an in-flight Stop before catch-up and commit", async (t) => {
  const batches = [];
  const events = [];
  let started;
  const firstBatch = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, async (req, res, body) => {
    if (req.url.endsWith("/messages/batch")) {
      batches.push(body.messages);
      events.push("batch-start");
      started();
      await delay(120);
      events.push("batch-end");
      respond(res);
    } else if (req.url.endsWith("/commit")) { events.push("commit"); respond(res); }
    else respond(res, { healthy: true, pending_tokens: 2 });
  });
  const stop = f.run("auto-capture.mjs");
  await firstBatch;
  await Promise.all([stop, f.run("pre-compact-capture.mjs")]);
  assert.equal(batches.length, 1);
  assert.ok(events.indexOf("commit") > events.indexOf("batch-end"));
});

test("all REST hook paths refuse redirects before credentials or conversations reach another origin", async (t) => {
  let redirectedRequests = 0;
  let redirectHealth = true;
  let redirectedBatches = 0;
  const sink = http.createServer((req, res) => { redirectedRequests++; req.resume(); respond(res); });
  await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
  t.after(async () => { sink.closeAllConnections(); await new Promise((resolve) => sink.close(resolve)); });
  const target = "http://127.0.0.1:" + sink.address().port;
  const f = await fixture(t, async (req, res) => {
    if (req.url.endsWith("/messages/batch")) redirectedBatches++;
    const shouldRedirect = (req.url === "/health" && redirectHealth) || req.url.endsWith("/messages/batch");
    if (shouldRedirect) { res.writeHead(307, { Location: target + "/sink" }); res.end(); }
    else respond(res);
  });
  for (const script of ["auto-capture.mjs", "pre-compact-capture.mjs", "auto-recall.mjs", "session-start-commit.mjs"]) {
    await f.run(script, script.replace(/\W/g, "_"));
  }
  redirectHealth = false;
  await f.run("auto-capture.mjs", "redirect_post_stop");
  await f.run("pre-compact-capture.mjs", "redirect_post_compact");
  assert.equal(redirectedBatches, 2);
  assert.equal(redirectedRequests, 0);
});

test("captureMaxLength bounds actual text parts without truncating tool output or shifting turns", () => {
  const text = "synthetic text ".repeat(1000);
  const turns = extractCaptureTurns([
    { payload: { role: "user", content: [{ type: "text", text }, { type: "text", text }] } },
    { payload: { type: "function_call", call_id: "one", name: "test", arguments: "{}" } },
    { payload: { type: "function_call_output", call_id: "one", output: text } },
  ], { captureMaxLength: 200, captureAssistantTurns: true });
  assert.equal(turns.length, 3);
  assert.ok(turns[0].parts.reduce((n, part) => n + (part.text?.length || 0), 0) <= 200);
  assert.equal(turns[2].parts[0].tool_output, text.trim());
});

test("PreCompact persists successful batches before requesting the next batch", async (t) => {
  let cursorDuringSecondBatch = -1;
  let commits = 0;
  const sizes = [];
  const f = await fixture(t, async (req, res, body) => {
    if (req.url.endsWith("/messages/batch")) {
      sizes.push(body.messages.length);
      if (sizes.length === 1) respond(res);
      else {
        const state = JSON.parse(await readFile(join(f.home, "state", "batch_progress.json"), "utf8").catch(() => "{}"));
        cursorDuringSecondBatch = state.capturedTurnCount ?? -1;
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: { message: "synthetic second batch failure" } }));
      }
    } else if (req.url.endsWith("/commit")) { commits++; respond(res); }
    else respond(res, { healthy: true });
  });
  await writeFile(f.transcript, Array.from({ length: 101 }, (_, index) =>
    JSON.stringify({ payload: { message: { role: "user", content: "synthetic pending message " + index } } })).join("\n"));
  await f.run("pre-compact-capture.mjs", "batch_progress");
  assert.deepEqual(sizes, [100, 1]);
  assert.equal(cursorDuringSecondBatch, 100);
  assert.equal(commits, 0);
  const state = JSON.parse(await readFile(join(f.home, "state", "batch_progress.json"), "utf8"));
  assert.equal(state.capturedTurnCount, 100);
});
