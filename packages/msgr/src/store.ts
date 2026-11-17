import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const ROOT = process.env.MSGR_HOME ?? path.join(os.homedir(), ".msgr");
const LOG = path.join(ROOT, "messages.jsonl");
const CURSORS = path.join(ROOT, "cursors");
const AGENTS = path.join(ROOT, "agents");
const PINS = path.join(ROOT, "pins");
const WATCHERS = path.join(ROOT, "watchers");
// 메시지 본문이 다른 로컬 사용자에게 보이지 않도록 저장소 전체를 소유자 전용(0700)으로 둔다
for (const d of [ROOT, CURSORS, AGENTS, PINS, WATCHERS]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(ROOT, 0o700); // 이전 버전이 755로 만든 경우도 바로잡는다
} catch {}
fs.closeSync(fs.openSync(LOG, "a", 0o600));

/** 숫자 환경변수(잘못된 값이면 기본값) */
export const envNum = (name: string, def: number): number => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(v) && v >= 0 ? v : def;
};
/** 메시지 본문 최대 크기(바이트). 커맨드라인 인자 한도(Linux 128KB)와 로그 비대화를 막는다. */
export const MAX_BODY = envNum("MSGR_MAX_BODY", 32 * 1024);

export interface Message {
  id: string;
  ts: string;
  from: string;
  to: string; // 에이전트 id 또는 "*"
  thread?: string;
  body: string;
}

export interface Agent {
  id: string; // 예: claude-code:msgr#a3f2
  tool: string; // claude-code | opencode | ...
  folder: string; // cwd의 마지막 폴더명
  cwd: string;
  pid: number;
  sessionId?: string;
  alias?: string;
  client?: string; // 클라이언트가 핸드셰이크에서 보고한 원래 이름
  ts: number; // 마지막 하트비트
  online?: boolean;
}

const safe = (n: string) => n.replace(/[^\w.-]/g, "_");
const agentFile = (id: string) => path.join(AGENTS, safe(id) + ".json");

// ---------- 레지스트리 ----------

export function makeId(tool: string, cwd: string, sessionId?: string): { id: string; folder: string } {
  const folder = path.basename(cwd) || "root";
  const short = (sessionId ?? randomUUID()).replace(/-/g, "").slice(0, 6);
  return { id: `${tool}:${folder}#${short}`, folder };
}

export function register(a: Omit<Agent, "ts" | "online">): Agent {
  const full: Agent = { ...a, ts: Date.now() };
  fs.writeFileSync(agentFile(a.id), JSON.stringify(full));
  return full;
}

export function getAgent(id: string): Agent | undefined {
  try {
    return JSON.parse(fs.readFileSync(agentFile(id), "utf8"));
  } catch {
    return undefined;
  }
}

export function heartbeat(id: string, patch: Partial<Agent> = {}) {
  const cur = getAgent(id);
  if (cur) fs.writeFileSync(agentFile(id), JSON.stringify({ ...cur, ...patch, ts: Date.now() }));
}

export function unregister(id: string) {
  // 커서와 핀은 남긴다: 같은 세션이 재개되면(같은 id) 이어서 읽어야 과거 메시지가 다시 주입되지 않는다.
  // 남은 파일은 레지스트리 항목이 24시간 뒤 사라진 다음 gc가 정리한다.
  for (const f of [agentFile(id), path.join(WATCHERS, safe(id) + ".pid"), path.join(WATCHERS, safe(id) + ".nudge")]) fs.rmSync(f, { force: true });
}

export function listAgents(maxAgeMs = 3 * 60_000): Agent[] {
  const out: Agent[] = [];
  for (const f of fs.readdirSync(AGENTS)) {
    const file = path.join(AGENTS, f);
    try {
      const a = JSON.parse(fs.readFileSync(file, "utf8")) as Agent;
      // 구버전/손상 항목, 하루 넘게 하트비트 없는 잔재는 정리한다
      if (!a.id || Date.now() - a.ts > 24 * 3600_000) {
        fs.rmSync(file, { force: true });
        continue;
      }
      out.push({ ...a, online: Date.now() - a.ts < maxAgeMs });
    } catch {
      fs.rmSync(file, { force: true });
    }
  }
  return out;
}

/** 호출한 쪽이 쓴 임의의 표현(id/별칭/폴더/도구/경로 일부)을 에이전트 하나로 해석한다. */
export function resolve(target: string, self?: string): { id: string } | { error: string } {
  if (target === "*") return { id: "*" };
  const all = listAgents().filter((a) => a.id !== self);
  const exact = all.find((a) => a.id === target);
  if (exact) return { id: exact.id };
  const t = target.toLowerCase();
  const tiers: ((a: Agent) => boolean)[] = [
    (a) => a.alias?.toLowerCase() === t,
    (a) => a.folder.toLowerCase() === t,
    (a) => a.tool.toLowerCase() === t,
    (a) => a.cwd.toLowerCase().endsWith(t.replace(/^~/, "")) || a.cwd.toLowerCase().includes(t),
  ];
  for (const match of tiers) {
    // 같은 단계 안에서는 online을 우선 후보로 본다
    const hits = all.filter(match);
    const live = hits.filter((a) => a.online);
    const pool = live.length ? live : hits;
    if (pool.length === 1) return { id: pool[0].id };
    if (pool.length > 1)
      return {
        error: `"${target}"에 해당하는 세션이 ${pool.length}개입니다. 더 구체적으로 지정하세요:\n` +
          pool.map((a) => `  ${a.id}  (${a.cwd}${a.alias ? `, alias=${a.alias}` : ""})`).join("\n"),
      };
  }
  return { error: `"${target}"에 해당하는 세션을 찾지 못했습니다. list_agents로 확인하세요.` };
}

/** 훅처럼 외부에서 "이 세션의 inbox"를 찾을 때: sessionId 우선, 없으면 cwd+도구로 유일 매칭. */
export function findSelf(opts: { sessionId?: string; cwd?: string | string[]; tool?: string }): Agent | undefined {
  const all = listAgents().filter((a) => a.online);
  if (opts.sessionId) {
    const s = all.find((a) => a.sessionId === opts.sessionId);
    if (s) return s;
  }
  const real = (x: string) => {
    try {
      return fs.realpathSync(x);
    } catch {
      return x;
    }
  };
  const cwds = [opts.cwd ?? []].flat().map(real);
  const byCwd = all.filter((a) => cwds.includes(real(a.cwd)) && (!opts.tool || a.tool === opts.tool));
  return byCwd.length === 1 ? byCwd[0] : undefined;
}

// ---------- 핀(푸시 대상 세션/스레드 수동 고정) ----------

export function getPin(id: string): string | undefined {
  try {
    return fs.readFileSync(path.join(PINS, safe(id)), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function setPin(id: string, target?: string) {
  const f = path.join(PINS, safe(id));
  if (target) fs.writeFileSync(f, target);
  else fs.rmSync(f, { force: true });
}

// ---------- watcher(백그라운드 대기 프로세스) 추적 ----------

export function setWatcher(id: string, pid?: number) {
  const f = path.join(WATCHERS, safe(id) + ".pid");
  if (pid) fs.writeFileSync(f, String(pid));
  else fs.rmSync(f, { force: true });
}

export function watcherAlive(id: string): boolean {
  try {
    const pid = Number(fs.readFileSync(path.join(WATCHERS, safe(id) + ".pid"), "utf8"));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 살아 있는 watcher가 없고, 마지막 안내로부터 minMs가 지났으면 true(그리고 안내 시각을 기록). */
export function shouldNudge(id: string, minMs: number): boolean {
  if (watcherAlive(id)) return false;
  const f = path.join(WATCHERS, safe(id) + ".nudge");
  let last = 0;
  try {
    last = Number(fs.readFileSync(f, "utf8")) || 0;
  } catch {}
  if (Date.now() - last < minMs) return false;
  fs.writeFileSync(f, String(Date.now()));
  return true;
}

// ---------- 진단 기록(누가 언제 메시지를 소비했는지) ----------

const AUDIT = path.join(ROOT, "audit.log");
const AUDIT_MAX = 512 * 1024;

export function audit(id: string, via: string, n: number) {
  if (!n) return;
  try {
    // 512KB를 넘으면 한 세대만 보관하고 새로 시작한다
    if (fs.existsSync(AUDIT) && fs.statSync(AUDIT).size > AUDIT_MAX) fs.renameSync(AUDIT, AUDIT + ".1");
    fs.appendFileSync(AUDIT, `${new Date().toISOString()} ${id} via=${via} n=${n}\n`);
  } catch {}
}

// ---------- 정리(gc) ----------

/**
 * 고아 파일(등록이 사라진 에이전트의 커서/핀/watcher 기록)을 지우고,
 * 온라인 에이전트가 없을 때만 커진 메시지 로그를 비운다.
 */
export function gc(dryRun = false): string[] {
  const report: string[] = [];
  const agents = listAgents(); // 하루 넘은 레지스트리 항목은 여기서 이미 정리됨
  const known = new Set(agents.map((a) => safe(a.id)));
  const rm = (f: string, why: string) => {
    report.push(`${dryRun ? "(dry-run) " : ""}삭제: ${path.relative(ROOT, f)} — ${why}`);
    if (!dryRun) fs.rmSync(f, { force: true });
  };
  for (const [dir, suffix] of [[CURSORS, ""], [PINS, ""], [WATCHERS, ".pid"], [WATCHERS, ".nudge"]] as const) {
    for (const f of fs.readdirSync(dir)) {
      if (suffix && !f.endsWith(suffix)) continue;
      const base = suffix ? f.slice(0, -suffix.length) : f;
      if (!known.has(base)) rm(path.join(dir, f), "등록이 없는 에이전트");
    }
  }
  const online = agents.filter((a) => a.online).length;
  const size = fs.statSync(LOG).size;
  if (online === 0 && size > 1024 * 1024) {
    report.push(`${dryRun ? "(dry-run) " : ""}메시지 로그 비움: ${(size / 1024).toFixed(0)}KB (온라인 에이전트 없음)`);
    if (!dryRun) {
      fs.truncateSync(LOG, 0);
      for (const f of fs.readdirSync(CURSORS)) fs.rmSync(path.join(CURSORS, f), { force: true });
    }
  } else if (size > 1024 * 1024) {
    report.push(`메시지 로그가 ${(size / 1024).toFixed(0)}KB입니다. 온라인 에이전트(${online})가 있어 비우지 않았습니다.`);
  }
  if (!report.length) report.push("정리할 것이 없습니다.");
  return report;
}

// ---------- 메시지 ----------

export function send(from: string, to: string, body: string, thread?: string): Message {
  const n = Buffer.byteLength(body);
  if (n > MAX_BODY) throw new Error(`메시지가 너무 큽니다(${n}B > ${MAX_BODY}B). 내용을 파일로 저장하고 경로를 보내세요.`);
  const m: Message = { id: randomUUID(), ts: new Date().toISOString(), from, to, thread, body };
  // 한 줄 append는 (PIPE_BUF 이하에서) 원자적이라 락 없이 충분
  fs.appendFileSync(LOG, JSON.stringify(m) + "\n");
  return m;
}

/** 로그 끝부분(최근 256KB)의 메시지들. 속도 제한 계산용. */
function recentMessages(sinceMs: number): Message[] {
  const size = fs.statSync(LOG).size;
  const len = Math.min(size, 256 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(LOG, "r");
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  const cutoff = Date.now() - sinceMs;
  const out: Message[] = [];
  for (const l of buf.toString("utf8").split("\n").slice(size > len ? 1 : 0)) {
    if (!l) continue;
    try {
      const m = JSON.parse(l) as Message;
      if (Date.parse(m.ts) >= cutoff) out.push(m);
    } catch {}
  }
  return out;
}

/**
 * 에이전트 간 자동 응답 루프 방지(전송 측 가드).
 *  - 같은 (보내는 쪽→받는 쪽)이 1분에 maxPerPair건을 넘기거나
 *  - 두 세션 사이 양방향 합계가 1분에 maxPingPong건을 넘으면 거부한다.
 */
export function checkSendAllowed(
  from: string,
  to: string,
  limits = {
    maxPerPair: envNum("MSGR_MAX_SEND_PER_MIN", 10),
    maxPingPong: envNum("MSGR_MAX_PINGPONG_PER_MIN", 16),
  },
): { ok: true } | { ok: false; reason: string } {
  const recent = recentMessages(60_000);
  const oneWay = recent.filter((m) => m.from === from && m.to === to).length;
  if (oneWay >= limits.maxPerPair)
    return { ok: false, reason: `${to}에게 1분 안에 ${oneWay}건을 이미 보냈습니다(한도 ${limits.maxPerPair}). 잠시 후 다시 시도하세요.` };
  if (to !== "*") {
    const both = recent.filter((m) => (m.from === from && m.to === to) || (m.from === to && m.to === from)).length;
    if (both >= limits.maxPingPong)
      return { ok: false, reason: `${to}와 1분 안에 ${both}건을 주고받았습니다(한도 ${limits.maxPingPong}). 자동 응답 루프가 아닌지 확인하고 잠시 멈추세요.` };
  }
  return { ok: true };
}

const CHUNK = 4 * 1024 * 1024; // 한 번에 읽는 최대 크기

function readCursor(cur: string): number | undefined {
  try {
    const v = Number(fs.readFileSync(cur, "utf8"));
    return Number.isFinite(v) && v >= 0 ? v : 0;
  } catch {
    return undefined;
  }
}

/**
 * 바이트 오프셋 커서로 새 메시지를 훑는다. commit()을 호출해야 커서가 전진한다.
 * commit(k)는 앞의 k건까지만 소비한 것으로 기록한다(나머지는 다음에 다시 나온다).
 * 커서는 앞으로만 움직인다(여러 소비자가 동시에 커밋해도 뒤로 돌아가 중복 전달되지 않게).
 */
export function pollInbox(id: string): { msgs: Message[]; commit: (k?: number) => void } {
  const cur = path.join(CURSORS, safe(id));
  const saved = readCursor(cur);
  // 첫 구독: 처음부터 읽되, 과거 브로드캐스트는 소음이라 직접 메시지만 받는다
  const first = saved === undefined;
  const size = fs.statSync(LOG).size;
  // 로그가 비워졌는데 커서가 남아 있으면(수동 정리 등) 처음부터 다시 읽는다
  const off = saved !== undefined && saved > size ? 0 : (saved ?? 0);
  if (size <= off) return { msgs: [], commit() {} };
  const len = Math.min(size - off, CHUNK);
  const fd = fs.openSync(LOG, "r");
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, off);
  fs.closeSync(fd);
  // 마지막 줄이 미완성일 수 있으니 개행까지만 소비. 한 줄이 CHUNK보다 크면(비정상) 건너뛴다.
  let end = buf.lastIndexOf(10) + 1;
  if (end === 0 && len === CHUNK) end = len;
  const msgs: Message[] = [];
  const ends: number[] = [];
  let pos = 0;
  while (pos < end) {
    const nl = buf.indexOf(10, pos);
    const stop = nl < 0 || nl >= end ? end : nl + 1;
    const line = buf.subarray(pos, stop).toString("utf8").trim();
    pos = stop;
    if (!line) continue;
    let m: Message;
    try {
      m = JSON.parse(line);
    } catch {
      continue; // 깨진 줄(동시 기록 충돌, 디스크 풀 등)은 건너뛴다
    }
    if (!m || typeof m.body !== "string") continue;
    if (m.from !== id && (m.to === id || (!first && m.to === "*"))) {
      msgs.push(m);
      ends.push(pos);
    }
  }
  const commit = (k = msgs.length) => {
    const target = off + (k >= msgs.length ? end : ends[k - 1] ?? 0);
    if (k <= 0 && msgs.length) return;
    const now = readCursor(cur);
    if (now !== undefined && now > target && now <= size) return; // 다른 소비자가 이미 더 읽음
    fs.writeFileSync(cur, String(target), { mode: 0o600 });
  };
  return { msgs, commit };
}

/** peek=true면 커서를 전진시키지 않음. */
export function readInbox(id: string, peek = false): Message[] {
  const { msgs, commit } = pollInbox(id);
  if (!peek) commit();
  return msgs;
}

export function format(msgs: Message[]): string {
  return msgs
    .map((m) => `[${m.ts}] from=${m.from}${m.thread ? ` thread=${m.thread}` : ""}\n${m.body}`)
    .join("\n---\n");
}
