// Codex 자동 수신: 내 inbox를 감시하다가 새 메시지가 오면 Codex app-server(제어 소켓)를 통해
// 같은 폴더의 유휴 스레드에 turn/start로 주입한다. 작업 중이면 커밋하지 않고 다음 주기에 재시도.
import fs from "node:fs";
import { CodexRpc } from "./codex-rpc.js";
import { Backoff, RateWindow } from "./ratelimit.js";
import { buildPush } from "./push-text.js";
import { type Agent, envNum, getPin, pollInbox } from "./store.js";

const MAX_PUSH_PER_MIN = envNum("MSGR_MAX_PUSH_PER_MIN", 6);
const POLL_MS = Math.max(500, envNum("MSGR_POLL_MS", 2000));

const real = (x: string) => {
  try {
    return fs.realpathSync(x);
  } catch {
    return x;
  }
};

interface Thr {
  id: string;
  cwd?: string;
  status?: { type: string };
  updatedAt?: number;
  preview?: string;
}

/** 같은 폴더에 로드된 스레드 중 유휴인 것(없으면 undefined). MSGR_CODEX_THREAD로 고정 가능. */
export async function pickThread(rpc: CodexRpc, cwd: string, pin?: string): Promise<{ id?: string; busy: boolean }> {
  const fixed = pin ?? process.env.MSGR_CODEX_THREAD;
  const loaded = (await rpc.request("thread/loaded/list", {})).data as string[];
  const mine: Thr[] = [];
  for (const id of loaded) {
    if (fixed && id !== fixed) continue;
    const t = (await rpc.request("thread/read", { threadId: id, includeTurns: false })).thread as Thr;
    if (fixed ? true : t.cwd && real(t.cwd) === real(cwd)) mine.push(t);
  }
  // 대화 내용이 있는 스레드를 우선하고(빈 스레드는 후순위), 그 안에서 가장 최근 갱신된 유휴 스레드를 고른다
  const idle = mine
    .filter((t) => t.status?.type === "idle")
    .sort((a, b) => Number(!!b.preview) - Number(!!a.preview) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return idle.length ? { id: idle[0].id, busy: false } : { busy: mine.length > 0 };
}

export function startCodexPush(getMe: () => Agent | undefined, log: (m: string) => void = () => {}) {
  const rate = new RateWindow(MAX_PUSH_PER_MIN);
  const backoff = new Backoff(POLL_MS, 60_000); // 세션 없음/작업 중/실패가 이어지면 재시도 간격을 늘림
  let busy = false;
  const tick = async () => {
    const me = getMe();
    if (!me || busy || !backoff.ready()) return;
    busy = true;
    let rpc: CodexRpc | undefined;
    try {
      const { msgs, commit } = pollInbox(me.id);
      if (!msgs.length) return;
      if (!rate.allow()) return; // 루프 방지: 커밋하지 않고 다음 기회에
      rpc = await CodexRpc.connect(undefined, "msgr");
      const t = await pickThread(rpc, me.cwd, getPin(me.id));
      if (!t.id) return backoff.fail(), log(t.busy ? "codex 스레드가 작업 중 — 나중에 재시도" : "codex 스레드를 찾지 못함(cwd=" + me.cwd + ")");
      const { text, count } = buildPush(me.id, msgs);
      await rpc.request("turn/start", { threadId: t.id, input: [{ type: "text", text, text_elements: [] }] });
      commit(count);
      rate.record();
      backoff.ok();
      log(`pushed ${count} msg(s) -> ${t.id}`);
    } catch (e) {
      backoff.fail();
      log("push 실패: " + (e as Error).message);
    } finally {
      rpc?.close();
      busy = false;
    }
  };
  setInterval(tick, POLL_MS).unref();
}
