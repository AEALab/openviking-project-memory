import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyPackage } from "./verify-package.mjs";

const packageRoot = dirname(fileURLToPath(import.meta.url));
async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), "ov-package-verify-"));
  const path = join(scratch, "package");
  await cp(packageRoot, path, { recursive: true, filter: (source) => source !== join(packageRoot, ".git") });
  t.after(() => rm(scratch, { recursive: true, force: true }));
  return path;
}
test("release package verifies with complete checksum coverage", () => {
  assert.ok(verifyPackage(packageRoot) > 87);
});
test("removing a runtime file and its checksum still fails completeness checks", async (t) => {
  const root = await fixture(t);
  const path = "codex-memory-plugin/scripts/shared/uri-guard.mjs";
  const sums = JSON.parse(await readFile(join(root, "SHA256SUMS.json"), "utf8"));
  delete sums[path];
  await rm(join(root, path));
  await writeFile(join(root, "SHA256SUMS.json"), JSON.stringify(sums));
  assert.throws(() => verifyPackage(root), /file count/);
});
test("omitted checksums and unexpected extra files cannot pass validation", async (t) => {
  const root = await fixture(t);
  const sums = JSON.parse(await readFile(join(root, "SHA256SUMS.json"), "utf8"));
  delete sums["codex-memory-plugin/scripts/shared/uri-guard.mjs"];
  await writeFile(join(root, "SHA256SUMS.json"), JSON.stringify(sums));
  assert.throws(() => verifyPackage(root), /cover every package file/);
  await writeFile(join(root, ".DS_Store"), "synthetic metadata");
  assert.throws(() => verifyPackage(root), /file count/);
});
test("a manifest pointing outside its declared runtime cannot pass even with updated hashes", async (t) => {
  const root = await fixture(t);
  const path = "codex-memory-plugin/.codex-plugin/plugin.json";
  const manifest = JSON.parse(await readFile(join(root, path), "utf8"));
  manifest.hooks = "../README.md";
  const bytes = JSON.stringify(manifest);
  await writeFile(join(root, path), bytes);
  const sums = JSON.parse(await readFile(join(root, "SHA256SUMS.json"), "utf8"));
  sums[path] = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(root, "SHA256SUMS.json"), JSON.stringify(sums));
  assert.throws(() => verifyPackage(root), /Unsafe package path/);
});


test("repository Git metadata is excluded from the source snapshot", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "config"), "synthetic Git metadata");
  assert.ok(verifyPackage(root) > 87);
});
