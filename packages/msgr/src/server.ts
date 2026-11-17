import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  type Agent, audit, checkSendAllowed, format, getAgent, heartbeat, listAgents, makeId, readInbox, register, resolve, send, setPin, unregister,
} from "./store.js";
import { startOpencodePush } from "./opencode-push.js";
import { startCodexPush } from "./codex-push.js";

const server = new McpServer({ name: "msgr", version: "0.2.0" });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

// 클라이언트가 보고하는 이름(예: codex-mcp-client)을 짧은 도구명으로 정규화한다
function normalizeTool(name: string): string {
  const n = name.toLowerCase();
  const known: [RegExp, string][] = [
    [/claude/, "claude-code"], [/opencode/, "opencode"], [/codex/, "codex"],
    [/antigravity|agy/, "agy"], [/gemini/, "gemini"], [/cursor/, "cursor"],
  ];
  for (const [re, t] of known) if (re.test(n)) return t;
  return n.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
}

// 세션 정체성: 핸드셰이크가 끝난 뒤(클라이언트 도구명을 알 수 있을 때) 등록한다.
let me: Agent | undefined;
function ensureMe(): Agent {
  if (me) return me;
  const cwd = process.cwd();
  const clientName = server.server.getClientVersion()?.name ?? "agent";
  const tool = process.env.MSGR_TOOL ?? normalizeTool(clientName);
  // Claude Code 세션 id는 Claude Code일 때만 신뢰한다(다른 도구가 그 셸에서 떴을 수 있음)
  const sessionId =
    process.env.MSGR_SESSION_ID || (tool === "claude-code" ? process.env.CLAUDE_CODE_SESSION_ID : undefined) || undefined;
  const gen = makeId(tool, cwd, sessionId);
  const id = process.env.MSGR_AGENT ?? gen.id; // 명시 이름이 있으면 그것을 우선
  me = register({
    id, tool, folder: gen.folder, cwd, pid: process.pid, sessionId,
    alias: process.env.MSGR_ALIAS, client: clientName,
  });
  return me;
}
const beat = () => me && heartbeat(me.id);

server.tool(
  "send_message",
  "다른 에이전트 세션에게 메시지를 보낸다. to에는 세션 id, 별칭, 폴더명, 도구명(claude-code/opencode), 경로 일부를 쓸 수 있고 \"*\"는 브로드캐스트다. 여러 세션이 걸리면 후보를 알려 준다.",
  { to: z.string(), body: z.string(), thread: z.string().optional() },
  async ({ to, body, thread }) => {
    const self = ensureMe();
    beat();
    const r = resolve(to, self.id);
    if ("error" in r) return { ...text(r.error), isError: true };
    const g = checkSendAllowed(self.id, r.id);
    if (!g.ok) return { ...text(g.reason), isError: true };
    try {
      const m = send(self.id, r.id, body, thread);
      return text(`sent ${m.id} -> ${r.id}`);
    } catch (e) {
      return { ...text((e as Error).message), isError: true };
    }
  },
);

server.tool(
  "read_inbox",
  "나에게 온 새 메시지를 읽는다(읽은 메시지는 다시 나오지 않음).",
  { peek: z.boolean().optional() },
  async ({ peek }) => {
    const self = ensureMe();
    beat();
    const msgs = readInbox(self.id, peek);
    if (!peek) audit(self.id, "mcp-read_inbox", msgs.length);
    return text(msgs.length ? format(msgs) : "(새 메시지 없음)");
  },
);

server.tool("whoami", "이 세션의 id, 폴더, 도구, 별칭을 알려 준다.", {}, async () => {
  const s = ensureMe();
  const cur = getAgent(s.id) ?? s;
  return text(`id=${cur.id}\ntool=${cur.tool}\nfolder=${cur.folder}\ncwd=${cur.cwd}\nalias=${cur.alias ?? "(none)"}`);
});

server.tool(
  "set_alias",
  "이 세션에 별칭을 붙인다(예: reviewer). 다른 세션이 별칭으로 지칭할 수 있다.",
  { alias: z.string().regex(/^[\w.-]+$/) },
  async ({ alias }) => {
    const s = ensureMe();
    const taken = listAgents().find((a) => a.online && a.id !== s.id && a.alias === alias);
    if (taken) return { ...text(`별칭 "${alias}"은 ${taken.id}가 사용 중입니다.`), isError: true };
    heartbeat(s.id, { alias });
    return text(`alias=${alias}`);
  },
);

server.tool(
  "pin_target",
  "자동 수신 시 메시지를 주입할 세션/스레드 id를 이 에이전트에 고정한다(같은 폴더에 세션이 여럿일 때). id를 생략하면 고정을 해제한다. OpenCode는 session id(ses_…), Codex는 thread id.",
  { target: z.string().optional() },
  async ({ target }) => {
    const s = ensureMe();
    setPin(s.id, target);
    return text(target ? `pinned ${target}` : "pin cleared");
  },
);

server.tool("list_agents", "등록된 세션 목록(폴더, 도구, 별칭, 온라인 여부).", {}, async () => {
  const s = ensureMe();
  beat();
  const rows = listAgents()
    .sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id))
    .map((a) => `${a.online ? "●" : "○"} ${a.id}${a.id === s.id ? " (me)" : ""}  ${a.cwd}${a.alias ? `  alias=${a.alias}` : ""}`);
  return text(rows.join("\n"));
});

// 종료 시 정리
const bye = () => {
  if (me) unregister(me.id);
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
process.stdin.on("close", bye);

server.server.oninitialized = () => {
  const s = ensureMe();
  // OpenCode에서 뜬 서버는 새 메시지를 세션에 자동 주입한다(MSGR_PUSH=off로 끌 수 있음)
  if (process.env.MSGR_PUSH !== "off") {
    const log = (m: string) => console.error("[msgr]", m);
    if (s.tool === "opencode") startOpencodePush(() => me, log);
    if (s.tool === "codex") startCodexPush(() => me, log);
  }
};
setInterval(beat, 60_000).unref();
await server.connect(new StdioServerTransport());
