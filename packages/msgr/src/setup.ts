// msgr setup [--dry-run] [--uninstall] [--only claude,opencode,codex,agy]
// 각 도구에 msgr MCP 서버와 자동 수신 훅을 등록한다. 여러 번 실행해도 안전(멱등).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(DIST, "server.js");
const CLI = path.join(DIST, "cli.js");
const HOME = os.homedir();
const NODE = "node";

type Result = "ok" | "skip" | "fail";
const log: string[] = [];
const say = (tool: string, r: Result, msg: string) => {
  const icon = r === "ok" ? "✓" : r === "skip" ? "–" : "✗";
  log.push(`${icon} [${tool}] ${msg}`);
  console.log(`${icon} [${tool}] ${msg}`);
};

export function setup(args: string[]) {
  // 안전장치: HOME이 비었거나 상대 경로면 엉뚱한 곳(현재 폴더 등)에 쓰게 되므로 거부한다
  if (!HOME || !path.isAbsolute(HOME) || HOME === "/") {
    console.error(`HOME이 올바르지 않습니다(${JSON.stringify(HOME)}). 중단합니다.`);
    process.exit(1);
  }
  const dry = args.includes("--dry-run");
  const uninstall = args.includes("--uninstall");
  const onlyIdx = args.indexOf("--only");
  const ALL = ["claude", "opencode", "codex", "agy"];
  const onlyVal = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;
  if (onlyIdx >= 0 && (!onlyVal || onlyVal.startsWith("--"))) {
    console.error(`--only 에는 값이 필요합니다(예: --only claude,codex). 가능한 값: ${ALL.join(",")}`);
    process.exit(1);
  }
  const only = onlyVal ? onlyVal.split(",") : ALL;
  const unknown = only.filter((t) => !ALL.includes(t));
  if (unknown.length) {
    console.error(`알 수 없는 도구: ${unknown.join(",")} (가능한 값: ${ALL.join(",")})`);
    process.exit(1);
  }

  if (!fs.existsSync(SERVER) || !fs.existsSync(CLI)) {
    console.error(`dist가 없습니다(${DIST}). 먼저 npm run build 를 실행하세요.`);
    process.exit(1);
  }
  console.log(`${uninstall ? "제거" : "설치"}${dry ? " (dry-run: 실제 변경 없음)" : ""} — msgr: ${path.dirname(DIST)}`);

  const has = (bin: string) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
  const run = (bin: string, a: string[]): { ok: boolean; out: string } => {
    if (dry) return { ok: true, out: "" };
    const r = spawnSync(bin, a, { encoding: "utf8", timeout: 30_000 });
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
  };
  const backup = (file: string) => {
    if (dry || !fs.existsSync(file)) return;
    const bak = `${file}.bak-msgr`;
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak); // msgr 설치 전 원본(최초 1회)
    fs.copyFileSync(file, `${file}.bak-msgr-last`); // 이번 변경 직전 상태(매번 갱신)
  };
  /** 파일이 없으면 {}(새로 만듦). 읽기·파싱에 실패하면 undefined: 호출부는 그 파일을 건드리지 않고 실패로 보고한다. */
  const readJson = (file: string): any => {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? {} : undefined;
    }
    if (!raw.trim()) return {};
    try {
      const j = JSON.parse(raw);
      return j && typeof j === "object" && !Array.isArray(j) ? j : undefined;
    } catch {
      return undefined;
    }
  };
  const badJson = (tool: string, file: string) =>
    say(tool, "fail", `${file} 을(를) 읽거나 해석할 수 없어 건드리지 않았습니다. 파일을 고친 뒤 다시 실행하세요.`);
  const writeJson = (file: string, obj: unknown) => {
    if (dry) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  };
  const isOurs = (cmd?: string) => typeof cmd === "string" && /msgr|dist\/cli\.js (inbox --hook|session-start)/.test(cmd) && /cli\.js/.test(cmd);

  /**
   * Claude/Codex 스타일 훅({hooks:{Event:[{matcher?, hooks:[{command}]}]}})에서 msgr 명령만 제거하고
   * (같은 그룹의 다른 명령과 그룹 속성은 보존, 비게 된 그룹만 삭제) 선택적으로 msgr 그룹을 추가한다.
   */
  const mergeNestedHook = (hooksObj: any, event: string, command: string | null, extra: object = {}) => {
    const groups = Array.isArray(hooksObj[event]) ? hooksObj[event] : [];
    hooksObj[event] = groups.flatMap((g: any) => {
      if (!g || !Array.isArray(g.hooks)) return [g];
      const rest = g.hooks.filter((h: any) => !isOurs(h?.command));
      if (rest.length === g.hooks.length) return [g];
      return rest.length ? [{ ...g, hooks: rest }] : [];
    });
    if (command) hooksObj[event].push({ hooks: [{ type: "command", command, ...extra }] });
    if (!hooksObj[event].length) delete hooksObj[event];
  };

  // ---------------- Claude Code ----------------
  if (only.includes("claude")) {
    if (!has("claude")) say("claude", "skip", "claude CLI 없음");
    else {
      run("claude", ["mcp", "remove", "msgr", "--scope", "user"]);
      if (!uninstall) {
        const r = run("claude", ["mcp", "add", "--scope", "user", "msgr", "--", NODE, SERVER]);
        say("claude", r.ok ? "ok" : "fail", r.ok ? "MCP 서버 등록(user)" : `MCP 등록 실패: ${r.out}`);
      } else say("claude", "ok", "MCP 서버 제거");
      const f = path.join(HOME, ".claude/settings.json");
      const j = readJson(f);
      if (!j) badJson("claude", f);
      else {
        backup(f);
        if (!j.hooks || typeof j.hooks !== "object") j.hooks = {};
        mergeNestedHook(j.hooks, "UserPromptSubmit", uninstall ? null : `${NODE} ${CLI} inbox --hook`);
        mergeNestedHook(j.hooks, "SessionStart", uninstall ? null : `${NODE} ${CLI} session-start`);
        if (!Object.keys(j.hooks).length) delete j.hooks;
        writeJson(f, j);
        say("claude", "ok", `훅 ${uninstall ? "제거" : "설치"} (UserPromptSubmit, SessionStart) → ${f}`);
      }
    }
  }

  // ---------------- OpenCode ----------------
  if (only.includes("opencode")) {
    if (!has("opencode")) say("opencode", "skip", "opencode CLI 없음");
    else {
      const f = path.join(HOME, ".config/opencode/opencode.json");
      const j = readJson(f);
      if (!j) badJson("opencode", f);
      else if (j?.mcp?.servers?.msgr) {
        backup(f);
        delete j.mcp.servers.msgr; // 멱등: 지우고 다시 add
        writeJson(f, j);
      }
      if (!j) {
        // 설정 파일이 깨져 있으면 opencode mcp add도 덮어쓸 수 있으므로 건너뛴다
      } else if (!uninstall) {
        const r = run("opencode", ["mcp", "add", "--global", "msgr", "--", NODE, SERVER]);
        say("opencode", r.ok ? "ok" : "fail", r.ok ? `MCP 서버 등록(global) → ${f}` : `MCP 등록 실패: ${r.out}`);
        if (r.ok && !dry) say("opencode", "skip", "OpenCode 서비스를 재시작해야 적용됩니다: opencode service restart");
      } else say("opencode", "ok", "MCP 서버 제거");
    }
  }

  // ---------------- Codex ----------------
  if (only.includes("codex")) {
    if (!has("codex")) say("codex", "skip", "codex CLI 없음");
    else {
      run("codex", ["mcp", "remove", "msgr"]);
      if (!uninstall) {
        const r = run("codex", ["mcp", "add", "msgr", "--", NODE, SERVER]);
        say("codex", r.ok ? "ok" : "fail", r.ok ? "MCP 서버 등록" : `MCP 등록 실패: ${r.out}`);
      } else say("codex", "ok", "MCP 서버 제거");
      const f = path.join(HOME, ".codex/hooks.json");
      const j = readJson(f);
      if (!j) badJson("codex", f);
      else {
        backup(f);
        if (!j.hooks || typeof j.hooks !== "object") j.hooks = {};
        mergeNestedHook(j.hooks, "UserPromptSubmit", uninstall ? null : `${NODE} ${CLI} inbox --hook --tool codex`, { timeout: 10 });
        if (!Object.keys(j.hooks).length) delete j.hooks;
        if (uninstall && !Object.keys(j).filter((k) => k !== "description").length) {
          if (!dry) fs.rmSync(f, { force: true });
        } else {
          j.description ??= "msgr: 다른 에이전트 세션의 새 메시지를 프롬프트 직전에 주입";
          writeJson(f, j);
        }
        say("codex", "ok", `훅 ${uninstall ? "제거" : "설치"} (UserPromptSubmit) → ${f}`);
      }
      if (!uninstall) say("codex", "skip", "처음에는 Codex에서 /hooks 로 훅을 한 번 신뢰(검토)해야 실행됩니다");
    }
  }

  // ---------------- agy ----------------
  if (only.includes("agy")) {
    if (!has("agy")) say("agy", "skip", "agy CLI 없음");
    else {
      run("agy", ["mcp", "remove", "msgr"]);
      if (!uninstall) {
        const r = run("agy", ["mcp", "add", "msgr", NODE, SERVER]);
        say("agy", r.ok ? "ok" : "fail", r.ok ? "MCP 서버 등록" : `MCP 등록 실패: ${r.out}`);
      } else say("agy", "ok", "MCP 서버 제거");
      const f = path.join(HOME, ".gemini/config/hooks.json");
      const j = readJson(f);
      if (!j) badJson("agy", f);
      else {
      backup(f);
      if (uninstall) delete j.msgr;
      else
        j.msgr = {
          // agy CLI는 SessionStart 훅을 지원하지 않는다. PreInvocation 훅이 새 메시지 주입과
          // "백그라운드 watch --once를 걸어라" 안내(대기 중인 watcher가 없을 때만)를 함께 맡는다.
          PreInvocation: [{ type: "command", command: `${NODE} ${CLI} inbox --hook --tool agy`, timeout: 10 }],
        };
      if (uninstall && !Object.keys(j).length) {
        if (!dry) fs.rmSync(f, { force: true });
      } else writeJson(f, j);
      say("agy", "ok", `훅 ${uninstall ? "제거" : "설치"} (PreInvocation) → ${f}`);
      }
    }
  }

  const failed = log.filter((l) => l.startsWith("✗")).length;
  console.log(failed ? `\n${failed}개 단계 실패` : "\n완료. 실행 중인 에이전트 세션은 재시작해야 msgr가 로드됩니다.");
  process.exit(failed ? 1 : 0);
}
