// OpenCode 자동 수신: 내 inbox를 감시하다가 새 메시지가 오면
// OpenCode HTTP API(POST /api/session/{id}/synthetic)로 해당 세션에 주입한다(유휴 세션이면 깨운다).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Backoff, RateWindow } from "./ratelimit.js";
import { buildPush } from "./push-text.js";
import { type Agent, type Poll, envNum, getPin, pollInbox } from "./store.js";

const BIN =
  process.env.MSGR_OPENCODE_BIN ??
  [path.join(os.homedir(), ".bun/bin/opencode"), "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"].find((p) =>
    fs.existsSync(p),
  ) ??
  "opencode";

const MAX_PUSH_PER_MIN = envNum("MSGR_MAX_PUSH_PER_MIN", 6);
const POLL_MS = Math.max(500, envNum("MSGR_POLL_MS", 2000));

function oc(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(BIN, ["api", ...args], { cwd, timeout: 20_000, maxBuffer: 16 << 20 }, (e, out, err) =>
      e ? reject(new Error((err || e.message).trim())) : resolve(out),
    ),
  );
}

interface Sess {
  id: string;
  time: { updated: number; viewed?: number };
  location?: { directory?: string };
}

/** 같은 폴더의 세션 중 실행 중인 것 > 가장 최근에 화면에서 본(viewed)/갱신된 것. MSGR_OC_SESSION으로 고정 가능. */
export async function pickSession(cwd: string, pin?: string): Promise<string | undefined> {
  const fixed = pin ?? process.env.MSGR_OC_SESSION;
  if (fixed) return fixed;
  const list = (JSON.parse(await oc(["GET", "/api/session"], cwd)).data as Sess[]).filter(
    (s) => s.location?.directory === cwd,
  );
  if (!list.length) return undefined;
  const active = JSON.parse(await oc(["GET", "/api/session/active"], cwd)).data ?? {};
  const running = list.filter((s) => active[s.id]);
  const recency = (s: Sess) => Math.max(s.time.updated, s.time.viewed ?? 0);
  const best = (running.length ? running : list).sort((a, b) => recency(b) - recency(a))[0];
  // 신선도: 실행 중이 아닌 세션이 오래됐다면(화면에 아직 세션이 안 만들어진 상태일 수 있음)
  // 보이지 않는 곳에 모델 턴을 일으키지 않도록 주입하지 않는다. MSGR_OC_STALE_MIN=0이면 끔.
  const staleMs = Number(process.env.MSGR_OC_STALE_MIN ?? 60) * 60_000;
  if (staleMs > 0 && !running.length && Date.now() - recency(best) > staleMs) return undefined;
  return best.id;
}

export function startOpencodePush(getMe: () => Agent | undefined, log: (m: string) => void = () => {}) {
  const rate = new RateWindow(MAX_PUSH_PER_MIN);
  const backoff = new Backoff(POLL_MS, 60_000); // 세션 없음/작업 중/실패가 이어지면 재시도 간격을 늘림
  let busy = false;
  let lastLog = "";
  const logOnce = (m: string) => {
    if (m !== lastLog) log(m);
    lastLog = m;
  };
  const tick = async () => {
    const me = getMe();
    if (!me || busy || !backoff.ready()) return;
    busy = true;
    let poll: Poll | undefined;
    try {
      poll = pollInbox(me.id);
      const { msgs, commit } = poll;
      if (!msgs.length) return;
      if (!rate.allow()) return; // 루프 방지: 커밋하지 않고 다음 기회에(finally에서 잠금 해제) 전달
      const session = await pickSession(me.cwd, getPin(me.id));
      if (!session) return backoff.fail(), logOnce("최근 " + (process.env.MSGR_OC_STALE_MIN ?? 60) + "분 안의 opencode 세션이 없어 주입을 보류(프롬프트를 한 번 입력하면 전달됨, cwd=" + me.cwd + ")");
      const { text, count } = buildPush(me.id, msgs);
      await oc(
        ["POST", `/api/session/${session}/synthetic`, "-H", "content-type:application/json", "-d",
          JSON.stringify({ text, description: "msgr", delivery: "queue" })],
        me.cwd,
      );
      commit(count);
      rate.record();
      backoff.ok();
      lastLog = "";
      log(`pushed ${count} msg(s) -> ${session}`);
    } catch (e) {
      backoff.fail();
      log("push 실패: " + (e as Error).message);
    } finally {
      poll?.release(); // 커밋했으면 무시됨. 전달 못 했으면 잠금만 풀어 다음에 재시도
      busy = false;
    }
  };
  setInterval(tick, POLL_MS).unref();
}
