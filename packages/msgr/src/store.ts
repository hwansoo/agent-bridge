import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export const ROOT = process.env.MSGR_HOME ?? path.join(os.homedir(), ".msgr");
const LOG = path.join(ROOT, "messages.jsonl");
const CURSORS = path.join(ROOT, "cursors");
const AGENTS = path.join(ROOT, "agents");
const PINS = path.join(ROOT, "pins");
const WATCHERS = path.join(ROOT, "watchers");
const LOCKS = path.join(ROOT, "locks");
// 메시지 본문이 다른 로컬 사용자에게 보이지 않도록 저장소 전체를 소유자 전용(0700)으로 둔다
for (const d of [ROOT, CURSORS, AGENTS, PINS, WATCHERS, LOCKS]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
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
  since?: number; // 처음 등록될 때의 로그 크기: 이후의 브로드캐스트는 첫 읽기에서도 받는다
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

export function register(a: Omit<Agent, "ts" | "online" | "since">): Agent {
  // 같은 id로 재등록(세션 재개)이면 처음 구독 위치를 유지한다
  const since = getAgent(a.id)?.since ?? fs.statSync(LOG).size;
  const full: Agent = { ...a, since, ts: Date.now() };
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

const STALE_MS = 24 * 3600_000;

/** 레지스트리 파일 중 유효한 것과 정리 대상(손상·하루 넘게 하트비트 없음)을 나눈다. 아무것도 지우지 않는다. */
function scanAgents(maxAgeMs: number): { agents: Agent[]; stale: string[] } {
  const agents: Agent[] = [];
  const stale: string[] = [];
  for (const f of fs.readdirSync(AGENTS)) {
    const file = path.join(AGENTS, f);
    try {
      const a = JSON.parse(fs.readFileSync(file, "utf8")) as Agent;
      if (!a.id || typeof a.ts !== "number" || Date.now() - a.ts > STALE_MS) stale.push(file);
      else agents.push({ ...a, online: Date.now() - a.ts < maxAgeMs });
    } catch {
      stale.push(file);
    }
  }
  return { agents, stale };
}

export function listAgents(maxAgeMs = 3 * 60_000, prune = true): Agent[] {
  const { agents, stale } = scanAgents(maxAgeMs);
  // 구버전/손상 항목, 하루 넘게 하트비트 없는 잔재는 정리한다
  if (prune) for (const f of stale) fs.rmSync(f, { force: true });
  return agents;
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
  const { agents, stale } = scanAgents(3 * 60_000);
  const known = new Set(agents.map((a) => safe(a.id)));
  const rm = (f: string, why: string) => {
    report.push(`${dryRun ? "(dry-run) " : ""}삭제: ${path.relative(ROOT, f)} — ${why}`);
    if (!dryRun) fs.rmSync(f, { force: true });
  };
  for (const f of stale) rm(f, "손상되었거나 24시간 넘게 하트비트 없음");
  for (const f of fs.readdirSync(LOCKS)) if (!known.has(f.replace(/\.lock$/, ""))) rm(path.join(LOCKS, f), "등록이 없는 에이전트");
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
      // 등록 시점(since)은 옛 로그의 오프셋이므로 새 로그 기준(0)으로 되돌린다
      for (const a of agents) {
        if (!a.since) continue;
        const { online, ...rest } = a; // ts(마지막 하트비트)는 그대로 둔다
        fs.writeFileSync(agentFile(a.id), JSON.stringify({ ...rest, since: 0 }));
      }
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

/**
 * 최근 sinceMs 안의 메시지들(속도 제한 계산용). 로그 끝에서부터 읽는 범위를 두 배씩 늘려
 * 구간 맨 앞 메시지가 기준 시각보다 오래될 때까지(최대 32MB) 읽는다. 메시지 크기와 무관하게 시간 기준으로 센다.
 */
function recentMessages(sinceMs: number): Message[] {
  const size = fs.statSync(LOG).size;
  const cutoff = Date.now() - sinceMs;
  const fd = fs.openSync(LOG, "r");
  try {
    for (let len = Math.min(size, 256 * 1024); ; len = Math.min(size, len * 2)) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n").slice(size > len ? 1 : 0); // 잘린 첫 줄 제외
      const msgs: Message[] = [];
      for (const l of lines) {
        if (!l) continue;
        try {
          msgs.push(JSON.parse(l) as Message);
        } catch {}
      }
      const oldest = msgs.length ? Date.parse(msgs[0].ts) : 0;
      if (len >= size || oldest < cutoff || len >= 32 * 1024 * 1024) return msgs.filter((m) => Date.parse(m.ts) >= cutoff);
    }
  } finally {
    fs.closeSync(fd);
  }
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
// 소비 잠금 만료: 주인 프로세스가 죽었으면 즉시, 살아 있어도 이보다 오래 잡고 있으면 회수한다.
// push의 외부 API 호출 시간(최대 수십 초)보다 충분히 길게 둔다.
const LOCK_STALE_MS = 10 * 60_000;

function readCursor(cur: string): number | undefined {
  try {
    const v = Number(fs.readFileSync(cur, "utf8"));
    return Number.isFinite(v) && v >= 0 ? v : 0;
  } catch {
    return undefined;
  }
}

/** 에이전트별 소비 잠금. 한 소비자(push/훅/watch/read_inbox)가 읽고 커밋할 때까지 다른 소비자는 같은 메시지를 못 가져간다. */
function lock(id: string): (() => void) | undefined {
  const f = path.join(LOCKS, safe(id) + ".lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const token = `${process.pid} ${randomBytes(8).toString("hex")}`;
      const fd = fs.openSync(f, "wx", 0o600);
      fs.writeSync(fd, token);
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // 만료로 빼앗긴 뒤라면 새 주인의 잠금이므로 지우지 않는다
        try {
          if (fs.readFileSync(f, "utf8") === token) fs.rmSync(f, { force: true });
        } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // 주인이 죽었거나 너무 오래 잡고 있으면 빼앗는다
      let stale = false;
      try {
        const st = fs.statSync(f);
        const pid = Number(fs.readFileSync(f, "utf8").split(" ")[0]);
        stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
        if (!stale && pid) {
          try {
            process.kill(pid, 0);
          } catch (err) {
            stale = (err as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      } catch {
        stale = true; // 그 사이 풀림
      }
      if (!stale) return undefined;
      fs.rmSync(f, { force: true });
    }
  }
  return undefined;
}

function advance(cur: string, target: number, size: number) {
  const now = readCursor(cur);
  if (now !== undefined && now >= target && now <= size) return; // 커서는 앞으로만
  fs.writeFileSync(cur, String(target), { mode: 0o600 });
}

export interface Poll {
  msgs: Message[];
  /** 앞의 k건(기본 전부)까지 소비한 것으로 기록하고 잠금을 푼다 */
  commit: (k?: number) => void;
  /** 커밋 없이 잠금만 푼다(전달 실패 시) */
  release: () => void;
}

/**
 * 바이트 오프셋 커서로 새 메시지를 훑는다. 메시지가 있으면 소비 잠금을 잡은 채로 돌려주므로
 * 호출자는 반드시 commit() 또는 release()를 불러야 한다(잠금은 2분 뒤 자동 만료).
 * 다른 소비자가 잠금을 잡고 있으면 빈 결과를 돌려준다(그쪽이 전달한다).
 * 내 메시지가 없는 구간은 바로 커서를 넘겨, 다른 세션 메시지로 꽉 찬 로그에서도 막히지 않는다.
 */
export function pollInbox(id: string): Poll {
  const none: Poll = { msgs: [], commit() {}, release() {} };
  const unlock = lock(id);
  if (!unlock) return none;
  let handedOff = false;
  try {
    const cur = path.join(CURSORS, safe(id));
    const saved = readCursor(cur);
    const size = fs.statSync(LOG).size;
    // 로그가 비워졌는데 커서가 남아 있으면(수동 정리 등) 처음부터 다시 읽는다
    const reset = saved !== undefined && saved > size;
    let off = reset || saved === undefined ? 0 : saved;
    // 과거 직접 메시지는 받고, 브로드캐스트는 등록 이후(since) 것만 받는다(커서 유무와 무관).
    // 등록 기록이 없으면: 첫 읽기는 지금 이후, 이어 읽기는 전부. 로그가 비워졌으면 위치 기준이 무의미하므로 0.
    const recorded = getAgent(id)?.since;
    let since = recorded ?? (saved === undefined ? size : 0);
    if (reset || since > size) since = 0;
    const fd = fs.openSync(LOG, "r");
    try {
      while (off < size) {
        const len = Math.min(size - off, CHUNK);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, off);
        // 마지막 줄이 미완성일 수 있으니 개행까지만 소비. 한 줄이 CHUNK보다 크면(비정상) 건너뛴다.
        let end = buf.lastIndexOf(10) + 1;
        if (end === 0) {
          if (len < CHUNK) break; // 아직 쓰는 중인 줄
          end = len;
        }
        const msgs: Message[] = [];
        const ends: number[] = [];
        let pos = 0;
        while (pos < end) {
          const nl = buf.indexOf(10, pos);
          const stop = nl < 0 || nl >= end ? end : nl + 1;
          const start = off + pos;
          const line = buf.subarray(pos, stop).toString("utf8").trim();
          pos = stop;
          if (!line) continue;
          let m: Message;
          try {
            m = JSON.parse(line);
          } catch {
            continue; // 깨진 줄(동시 기록 충돌, 디스크 풀 등)은 건너뛴다
          }
          if (!m || typeof m.body !== "string" || m.from === id) continue;
          if (m.to === id || (m.to === "*" && start >= since)) {
            msgs.push(m);
            ends.push(off + pos);
          }
        }
        const chunkEnd = off + end;
        if (!msgs.length) {
          advance(cur, chunkEnd, size); // 내 것이 없는 구간은 바로 넘긴다
          off = chunkEnd;
          continue;
        }
        let done = false;
        const finish = (k: number) => {
          if (done) return;
          done = true;
          try {
            if (k >= msgs.length) advance(cur, chunkEnd, size);
            else if (k > 0) advance(cur, ends[k - 1], size);
          } finally {
            unlock();
          }
        };
        handedOff = true;
        return { msgs, commit: (k) => finish(k ?? msgs.length), release: () => finish(0) };
      }
      if (saved === undefined) advance(cur, off, size); // 빈 로그여도 구독을 시작한 것으로 기록
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    if (!handedOff) unlock();
  }
  return none;
}

/** peek=true면 커서를 전진시키지 않음. */
export function readInbox(id: string, peek = false): Message[] {
  const p = pollInbox(id);
  if (peek) p.release();
  else p.commit();
  return p.msgs;
}

export function format(msgs: Message[]): string {
  return msgs
    .map((m) => `[${m.ts}] from=${m.from}${m.thread ? ` thread=${m.thread}` : ""}\n${m.body}`)
    .join("\n---\n");
}
