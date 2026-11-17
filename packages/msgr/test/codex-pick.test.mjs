// 단위 테스트: Codex 주입 대상 스레드 선택(pickThread). 가짜 RPC로 검증한다. 실행: npm run test:unit
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "msgr-pick-"));
process.env.MSGR_HOME = path.join(TMP, "home");
const OUT = path.join(TMP, "codex-push.mjs");
buildSync({ entryPoints: [path.join(ROOT, "src/codex-push.ts")], outfile: OUT, bundle: true, format: "esm", platform: "node", target: "node22" });
const { pickThread } = await import(OUT);
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const CWD = TMP; // realpath가 되는 실제 경로
const fake = (threads) => ({
  request: async (method, params) => {
    if (method === "thread/loaded/list") return { data: threads.map((t) => t.id) };
    if (method === "thread/read") return { thread: threads.find((t) => t.id === params.threadId) };
    throw new Error(method);
  },
});

test("화면 스레드가 작업 중이면 재시작 때 생긴 빈 유휴 스레드로 넘기지 않고 기다린다", async () => {
  const r = await pickThread(fake([
    { id: "hidden-empty", cwd: CWD, status: { type: "idle" }, updatedAt: 100, preview: "" },
    { id: "visible", cwd: CWD, status: { type: "active" }, updatedAt: 200, preview: "resume" },
  ]), CWD);
  assert.deepEqual(r, { busy: true });
});

test("화면 스레드가 유휴면 그 스레드를 고른다", async () => {
  const r = await pickThread(fake([
    { id: "hidden-empty", cwd: CWD, status: { type: "idle" }, updatedAt: 300, preview: "" },
    { id: "visible", cwd: CWD, status: { type: "idle" }, updatedAt: 200, preview: "resume" },
  ]), CWD);
  assert.deepEqual(r, { id: "visible", busy: false });
});

test("다른 폴더 스레드는 무시하고, 핀이 있으면 핀을 따른다", async () => {
  const threads = [
    { id: "other", cwd: "/elsewhere", status: { type: "idle" }, updatedAt: 999, preview: "x" },
    { id: "mine", cwd: CWD, status: { type: "idle" }, updatedAt: 1, preview: "y" },
  ];
  assert.deepEqual(await pickThread(fake(threads), CWD), { id: "mine", busy: false });
  assert.deepEqual(await pickThread(fake(threads), CWD, "other"), { id: "other", busy: false });
  assert.deepEqual(await pickThread(fake([]), CWD), { busy: false });
});
