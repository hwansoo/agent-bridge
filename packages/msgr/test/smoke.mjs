// 스모크 테스트: 임시 MSGR_HOME에서 가짜 클라이언트로 핵심 동작을 검증한다. 실제 ~/.msgr와 에이전트 설정은 건드리지 않는다.
// 실행: npm test  (먼저 빌드됨)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "dist/server.js"), CLI = path.join(ROOT, "dist/cli.js");
const SDK = path.join(ROOT, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/");
const { Client } = await import(SDK + "index.js");
const { StdioClientTransport } = await import(SDK + "stdio.js");

const H = fs.mkdtempSync(path.join(os.tmpdir(), "msgr-test-"));
const env = { ...process.env, MSGR_HOME: H, MSGR_PUSH: "off" };
for (const d of ["a", "b", "c", "d"]) fs.mkdirSync(path.join(H, d));
let pass = 0, fail = 0;
const ok = (cond, name, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "✓" : "✗"} ${name}${!cond && extra ? "  → " + extra : ""}`); };
const cli = (args, input) => execFileSync("node", [CLI, ...args], { env, input, encoding: "utf8" }).trim();
const mk = async (name, dir) => {
  const c = new Client({ name, version: "1" });
  await c.connect(new StdioClientTransport({ command: "node", args: [SERVER], cwd: path.join(H, dir), env }));
  return c;
};
const call = async (c, n, a = {}) => { const r = await c.callTool({ name: n, arguments: a }); return { err: !!r.isError, text: r.content[0].text }; };
const idOf = async (c) => (await call(c, "whoami")).text.split("\n")[0].slice(3);

try {
  // 1) 자동 식별과 도구명 정규화
  const cc = await mk("claude-code", "a"), oc = await mk("opencode", "b"), cx = await mk("codex-mcp-client", "c"), ag = await mk("antigravity-client", "d");
  const [ccI, ocI, cxI, agI] = await Promise.all([cc, oc, cx, ag].map(idOf));
  ok(/^claude-code:a#/.test(ccI) && /^opencode:b#/.test(ocI) && /^codex:c#/.test(cxI) && /^agy:d#/.test(agI), "도구명/폴더로 id 자동 생성", [ccI, ocI, cxI, agI].join(" "));

  // 2) 다양한 지칭 + 모호성 오류 + 별칭
  ok(!(await call(cc, "send_message", { to: "b", body: "folder" })).err, "폴더명으로 전송");
  ok(!(await call(cc, "send_message", { to: "codex", body: "tool" })).err, "도구명으로 전송");
  await call(ag, "set_alias", { alias: "reviewer" });
  ok(!(await call(cc, "send_message", { to: "reviewer", body: "alias" })).err, "별칭으로 전송");
  const dup = await mk("opencode", "b"); // 같은 폴더·도구 두 번째 세션
  await idOf(dup); // 등록이 끝났는지 확인(핸드셰이크 직후엔 아직일 수 있음)
  const amb = await call(cc, "send_message", { to: "opencode", body: "x" });
  ok(amb.err && /2개/.test(amb.text), "모호한 지칭은 후보를 알려 주고 거부", amb.text.slice(0, 80));
  await dup.close();

  // 3) 읽기: 한 번만, 자기 메시지 제외
  const r1 = await call(oc, "read_inbox"), r2 = await call(oc, "read_inbox");
  ok(/folder/.test(r1.text) && /새 메시지 없음/.test(r2.text), "read_inbox는 한 번만 전달");
  await call(oc, "send_message", { to: ocI, body: "self" });
  ok(/새 메시지 없음/.test((await call(oc, "read_inbox")).text), "자기 자신의 메시지는 받지 않음");

  // 4) 루프 방지: 한 방향 한도
  let sent = 0, blocked = false;
  for (let i = 0; i < 14; i++) { const r = await call(cc, "send_message", { to: ocI, body: "m" + i }); if (r.err) { blocked = true; break; } sent++; }
  ok(blocked && sent <= 10, "한 방향 분당 한도에서 거부", `sent=${sent}`);

  // 5) 훅 출력(Codex 평문 / agy JSON + 안내 한 번)
  cli(["send", "t", cxI, "hello codex"]);
  const ch = cli(["inbox", "--hook", "--tool", "codex"], JSON.stringify({ session_id: "x", cwd: path.join(H, "c") }));
  ok(/hello codex/.test(ch), "Codex 훅: 평문으로 주입");
  cli(["send", "t", agI, "hello agy"]);
  const ah = JSON.parse(cli(["inbox", "--hook", "--tool", "agy"], JSON.stringify({ conversationId: "y", workspacePaths: [path.join(H, "d")] })));
  const t = ah.injectSteps?.[0]?.ephemeralMessage ?? "";
  ok(/hello agy/.test(t) && /watch --once/.test(t), "agy 훅: injectSteps JSON + watcher 안내");
  const ah2 = JSON.parse(cli(["inbox", "--hook", "--tool", "agy"], JSON.stringify({ conversationId: "y", workspacePaths: [path.join(H, "d")] })));
  ok(Object.keys(ah2).length === 0, "agy 훅: 안내는 간격 제한으로 반복되지 않음");

  // 6) watch --once: 대기하다가 메시지 오면 출력하고 종료
  const w = spawn("node", [CLI, "watch", "--once", "--tool", "agy"], { cwd: path.join(H, "d"), env });
  let out = "", code = null; w.stdout.on("data", (d) => (out += d)); w.on("exit", (c) => (code = c));
  await new Promise((r) => setTimeout(r, 2500));
  ok(code === null, "watch --once: 메시지가 없으면 대기");
  cli(["send", "t", agI, "wake up"]);
  for (let i = 0; i < 20 && code === null; i++) await new Promise((r) => setTimeout(r, 500));
  ok(code === 0 && /wake up/.test(out), "watch --once: 메시지가 오면 출력 후 종료(0)");

  // 7) 핀
  await call(cc, "pin_target", { target: "ses_x" });
  ok(fs.readFileSync(path.join(H, "pins", ccI.replace(/[^\w.-]/g, "_")), "utf8") === "ses_x", "pin_target 기록");

  // 8) setup 안전장치(HOME이 비면 거부)
  let refused = false;
  try { execFileSync("node", [CLI, "setup", "--dry-run"], { env: { ...env, HOME: "" }, stdio: "pipe" }); } catch (e) { refused = e.status === 1; }
  ok(refused, "setup: HOME이 비어 있으면 거부");

  // 9) gc: 고아 파일 정리 / audit 로테이션
  fs.writeFileSync(path.join(H, "cursors", "ghost_agent"), "0");
  ok(/삭제: cursors\/ghost_agent/.test(cli(["gc", "--dry-run"])) && fs.existsSync(path.join(H, "cursors", "ghost_agent")), "gc --dry-run: 보고만 하고 삭제하지 않음");
  cli(["gc"]);
  ok(!fs.existsSync(path.join(H, "cursors", "ghost_agent")), "gc: 고아 커서 삭제");
  fs.writeFileSync(path.join(H, "audit.log"), "x".repeat(600 * 1024));
  cli(["send", "t", agI, "again"]); cli(["inbox", agI]); // audit 기록 유발
  ok(fs.existsSync(path.join(H, "audit.log.1")), "audit.log: 크기 초과 시 로테이션");

  for (const c of [cc, oc, cx, ag]) await c.close();
} catch (e) {
  fail++; console.log("✗ 예외:", e.stack ?? e);
} finally {
  fs.rmSync(H, { recursive: true, force: true });
}
console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
