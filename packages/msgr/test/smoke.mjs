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
const cli = (args, input) => execFileSync("node", [CLI, ...args], { env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
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

  // 8b) setup이 사용자 설정을 보존: 같은 그룹의 다른 훅 유지, 깨진 JSON은 건드리지 않음
  {
    const FH = path.join(H, "fakehome"), BIN = path.join(H, "fakebin");
    fs.mkdirSync(path.join(FH, ".claude"), { recursive: true });
    fs.mkdirSync(BIN, { recursive: true });
    fs.writeFileSync(path.join(BIN, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); // mcp add/remove 흉내
    const senv = { ...env, HOME: FH, PATH: `${BIN}:${process.env.PATH}` };
    const settings = path.join(FH, ".claude/settings.json");
    const oldMsgr = `node /old/place/msgr/dist/cli.js inbox --hook`;
    fs.writeFileSync(settings, JSON.stringify({ model: "keep", hooks: { UserPromptSubmit: [
      { matcher: "m1", hooks: [{ type: "command", command: oldMsgr }, { type: "command", command: "echo keep-me" }] },
      { hooks: [{ type: "command", command: "echo other-group" }] },
    ] } }));
    execFileSync("node", [CLI, "setup", "--only", "claude"], { env: senv, stdio: "pipe" });
    const j = JSON.parse(fs.readFileSync(settings, "utf8"));
    const cmds = j.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
    const g1 = j.hooks.UserPromptSubmit.find((g) => g.matcher === "m1");
    ok(j.model === "keep" && cmds.includes("echo keep-me") && cmds.includes("echo other-group") && !cmds.includes(oldMsgr)
      && cmds.filter((c) => /cli\.js inbox --hook/.test(c)).length === 1 && g1?.hooks.length === 1,
      "setup: 같은 그룹의 다른 훅과 그룹 속성 보존, 옛 msgr 훅만 교체", JSON.stringify(j));
    execFileSync("node", [CLI, "setup", "--uninstall", "--only", "claude"], { env: senv, stdio: "pipe" });
    const u = JSON.parse(fs.readFileSync(settings, "utf8"));
    const ucmds = (u.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    ok(ucmds.includes("echo keep-me") && !ucmds.some((c) => /cli\.js/.test(c)) && !u.hooks?.SessionStart, "setup --uninstall: msgr 훅만 제거", JSON.stringify(u));
    const broken = '{ "model": "x", oops';
    fs.writeFileSync(settings, broken);
    let st = 0;
    try { execFileSync("node", [CLI, "setup", "--only", "claude"], { env: senv, stdio: "pipe" }); } catch (e) { st = e.status; }
    ok(st === 1 && fs.readFileSync(settings, "utf8") === broken, "setup: 깨진 설정 파일은 덮어쓰지 않고 실패로 보고");
  }

  // 9) gc: 고아 파일 정리 / audit 로테이션
  fs.writeFileSync(path.join(H, "cursors", "ghost_agent"), "0");
  ok(/삭제: cursors\/ghost_agent/.test(cli(["gc", "--dry-run"])) && fs.existsSync(path.join(H, "cursors", "ghost_agent")), "gc --dry-run: 보고만 하고 삭제하지 않음");
  cli(["gc"]);
  ok(!fs.existsSync(path.join(H, "cursors", "ghost_agent")), "gc: 고아 커서 삭제");
  fs.writeFileSync(path.join(H, "audit.log"), "x".repeat(600 * 1024));
  cli(["send", "t", agI, "again"]); cli(["inbox", agI]); // audit 기록 유발
  ok(fs.existsSync(path.join(H, "audit.log.1")), "audit.log: 크기 초과 시 로테이션");

  // 10) 견고성: 깨진 줄, 커서가 로그보다 큰 경우, 본문 크기 제한
  fs.appendFileSync(path.join(H, "messages.jsonl"), "{broken json\n");
  cli(["send", "t", agI, "after-broken"]);
  ok(/after-broken/.test(cli(["inbox", agI])), "깨진 로그 줄은 건너뛰고 다음 메시지를 받음");
  fs.writeFileSync(path.join(H, "cursors", agI.replace(/[^\w.-]/g, "_")), "999999999");
  cli(["send", "t", agI, "after-reset"]);
  ok(/after-reset/.test(cli(["inbox", agI])), "커서가 로그보다 크면 처음부터 다시 읽음");
  let big = false;
  try { cli(["send", "t", agI, "x".repeat(40 * 1024)]); } catch (e) { big = /너무 큽니다/.test(String(e.stderr)); }
  ok(big, "본문 크기 제한(기본 32KB) 초과 시 거부");
  const bigMcp = await call(cc, "send_message", { to: agI, body: "y".repeat(40 * 1024) });
  ok(bigMcp.err && /너무 큽니다/.test(bigMcp.text), "MCP send_message도 크기 제한 오류를 돌려줌");

  // 11) 세션 재개: 같은 세션 id로 다시 떠도 이미 읽은 메시지가 다시 나오지 않음
  const renv = { ...env, MSGR_SESSION_ID: "resume-test-1" };
  const mkR = async () => {
    const c = new Client({ name: "claude-code", version: "1" });
    await c.connect(new StdioClientTransport({ command: "node", args: [SERVER], cwd: path.join(H, "a"), env: renv }));
    return c;
  };
  const s1 = await mkR();
  const rid = await idOf(s1);
  cli(["send", "t", rid, "old-msg"]);
  const first = await call(s1, "read_inbox");
  await s1.close();
  await new Promise((r) => setTimeout(r, 500));
  const s2 = await mkR();
  ok((await idOf(s2)) === rid, "재개 시 같은 id", rid);
  cli(["send", "t", rid, "new-msg"]);
  const second = await call(s2, "read_inbox");
  ok(/old-msg/.test(first.text) && /new-msg/.test(second.text) && !/old-msg/.test(second.text), "재개 후 과거 메시지 재주입 없음", second.text);
  await s2.close();

  // 12) 권한: 새 저장소는 소유자 전용
  if (process.platform !== "win32") {
    const H2 = path.join(H, "perm-home");
    execFileSync("node", [CLI, "agents"], { env: { ...env, MSGR_HOME: H2 } });
    const mode = (f) => fs.statSync(f).mode & 0o777;
    ok(mode(H2) === 0o700 && mode(path.join(H2, "messages.jsonl")) === 0o600, "저장소 0700 / 로그 0600",
      `${mode(H2).toString(8)} ${mode(path.join(H2, "messages.jsonl")).toString(8)}`);
  }

  for (const c of [cc, oc, cx, ag]) await c.close();
} catch (e) {
  fail++; console.log("✗ 예외:", e.stack ?? e);
} finally {
  fs.rmSync(H, { recursive: true, force: true });
}
console.log(`\n${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
