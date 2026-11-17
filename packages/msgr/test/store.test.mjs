// 단위 테스트: store(받은편지함 커서·잠금·브로드캐스트·속도 제한·gc). 실행: npm run test:unit
// 각 테스트는 새 MSGR_HOME에서 store를 새로 번들·import한다(모듈 상단에서 경로가 정해지므로).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "msgr-store-"));
const OUT = path.join(TMP, "store.mjs");
buildSync({ entryPoints: [path.join(ROOT, "src/store.ts")], outfile: OUT, bundle: true, format: "esm", platform: "node", target: "node22" });
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
async function fresh() {
  const home = path.join(TMP, `home-${n++}`);
  process.env.MSGR_HOME = home;
  const s = await import(`${OUT}?v=${n}`);
  return { s, home };
}
const reg = (s, id) => s.register({ id, tool: "t", folder: "f", cwd: "/x", pid: process.pid });

test("1. 다른 세션 메시지로 4MB 넘게 찬 로그 뒤의 내 메시지도 받는다(push처럼 빈 결과에 커밋하지 않아도)", async () => {
  const { s } = await fresh();
  reg(s, "target");
  const big = "x".repeat(32 * 1024 - 100);
  for (let i = 0; i < 140; i++) s.send("other", "someone-else", big);
  s.send("sender", "target", "hello-target");
  // push와 같은 사용법: 빈 결과면 커밋 없이 버림
  let got = [];
  for (let i = 0; i < 3 && !got.length; i++) {
    const p = s.pollInbox("target");
    got = p.msgs;
    if (got.length) p.commit();
    else p.release();
  }
  assert.deepEqual(got.map((m) => m.body), ["hello-target"]);
});

test("2. push가 읽고 전달 중이면 훅/read_inbox는 같은 메시지를 받지 못한다(중복 없음)", async () => {
  const { s } = await fresh();
  reg(s, "target");
  s.send("a", "target", "only-once");
  const push = s.pollInbox("target"); // 잠금을 잡은 채 외부 API 대기 중이라고 가정
  assert.equal(push.msgs.length, 1);
  assert.deepEqual(s.readInbox("target"), [], "잠금 중에는 다른 소비자가 가져가지 않음");
  push.commit();
  assert.deepEqual(s.readInbox("target"), [], "커밋 후에도 다시 나오지 않음");
});

test("2b. push가 전달에 실패해 release하면 다른 소비자가 받는다", async () => {
  const { s } = await fresh();
  reg(s, "target");
  s.send("a", "target", "retry-me");
  const push = s.pollInbox("target");
  push.release();
  assert.deepEqual(s.readInbox("target").map((m) => m.body), ["retry-me"]);
});

test("2c. 죽은 프로세스가 남긴 잠금은 무시한다", async () => {
  const { s, home } = await fresh();
  reg(s, "target");
  s.send("a", "target", "after-crash");
  fs.writeFileSync(path.join(home, "locks", "target.lock"), "999999"); // 존재하지 않는 pid
  assert.deepEqual(s.readInbox("target").map((m) => m.body), ["after-crash"]);
});

test("3. 등록 후 첫 읽기 전에 온 브로드캐스트를 받고, 등록 전 브로드캐스트는 받지 않는다", async () => {
  const { s } = await fresh();
  s.send("x", "*", "old-broadcast");
  s.send("x", "late", "old-direct");
  reg(s, "late");
  s.send("x", "*", "new-broadcast");
  assert.deepEqual(s.readInbox("late").map((m) => m.body), ["old-direct", "new-broadcast"]);
});

test("3b. 빈 로그에서 등록 → 빈 읽기 → 브로드캐스트 → 읽기", async () => {
  const { s } = await fresh();
  reg(s, "r");
  assert.deepEqual(s.readInbox("r"), []);
  s.send("sender", "*", "hi-all");
  assert.deepEqual(s.readInbox("r").map((m) => m.body), ["hi-all"]);
});

test("4. 큰 메시지로도 분당 전송 한도를 우회할 수 없다", async () => {
  const { s } = await fresh();
  const body = "y".repeat(32 * 1024 - 200);
  let allowed = 0;
  for (let i = 0; i < 20; i++) {
    if (!s.checkSendAllowed("a", "b").ok) break;
    s.send("a", "b", body);
    allowed++;
  }
  assert.equal(allowed, 10);
});

test("7. gc --dry-run은 오래된 레지스트리 항목을 지우지 않고 보고만 한다", async () => {
  const { s, home } = await fresh();
  const f = path.join(home, "agents", "old.json");
  fs.writeFileSync(f, JSON.stringify({ id: "old", tool: "t", folder: "f", cwd: "/x", pid: 1, ts: Date.now() - 25 * 3600_000 }));
  const report = s.gc(true).join("\n");
  assert.ok(fs.existsSync(f), "dry-run에서는 남아 있어야 함");
  assert.match(report, /agents\/old\.json/);
  s.gc(false);
  assert.ok(!fs.existsSync(f), "실제 gc에서는 삭제");
});

test("부분 커밋: commit(k)는 앞의 k건만 소비한다", async () => {
  const { s } = await fresh();
  reg(s, "t");
  for (const b of ["m1", "m2", "m3"]) s.send("a", "t", b);
  const p = s.pollInbox("t");
  assert.equal(p.msgs.length, 3);
  p.commit(1);
  assert.deepEqual(s.readInbox("t").map((m) => m.body), ["m2", "m3"]);
});
