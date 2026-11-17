// Codex app-server 클라이언트: 제어 소켓(Unix domain socket) 위의 WebSocket + JSON-RPC.
// 의존성 없이 필요한 만큼만 구현(텍스트 프레임, 마스킹, ping/pong).
import { randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const CODEX_SOCK =
  process.env.MSGR_CODEX_SOCK ?? path.join(os.homedir(), ".codex/app-server-control/app-server-control.sock");

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class CodexRpc {
  private sock!: net.Socket;
  private buf = Buffer.alloc(0);
  private upgraded = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private frag: Buffer[] = [];
  onNotification: (method: string, params: any) => void = () => {};

  static async connect(sockPath = CODEX_SOCK, clientName = "msgr", timeoutMs = 5000): Promise<CodexRpc> {
    const c = new CodexRpc();
    await c.open(sockPath, timeoutMs);
    try {
      await c.request("initialize", { clientInfo: { name: clientName, version: "0.1.0" } });
    } catch (e) {
      c.sock.destroy();
      throw e;
    }
    c.send({ jsonrpc: "2.0", method: "initialized" });
    return c;
  }

  private open(sockPath: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.sock.destroy();
        reject(new Error("codex app-server 접속 시간 초과"));
      }, timeoutMs);
      this.sock = net.connect(sockPath);
      this.sock.on("error", (e) => {
        clearTimeout(t);
        reject(e);
        this.failAll(e);
      });
      this.sock.on("close", () => this.failAll(new Error("연결 종료")));
      this.sock.on("connect", () => {
        const key = randomBytes(16).toString("base64");
        this.sock.write(
          `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      this.sock.on("data", (d: Buffer) => {
        this.buf = Buffer.concat([this.buf, d]);
        if (!this.upgraded) {
          const i = this.buf.indexOf("\r\n\r\n");
          if (i < 0) return;
          const head = this.buf.subarray(0, i).toString();
          if (!/^HTTP\/1\.1 101/.test(head)) {
            clearTimeout(t);
            this.sock.destroy();
            return reject(new Error("WebSocket 업그레이드 실패: " + head.split("\r\n")[0]));
          }
          this.buf = this.buf.subarray(i + 4);
          this.upgraded = true;
          clearTimeout(t);
          resolve();
        }
        this.drain();
      });
    });
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 0x80), op = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len); // 서버→클라이언트는 마스킹 없음
      this.buf = this.buf.subarray(off + len);
      if (op === 9) this.frame(10, payload); // ping → pong
      else if (op === 8) this.sock.end();
      else if (op === 1 || op === 0 || op === 2) {
        this.frag.push(Buffer.from(payload));
        if (fin) {
          const text = Buffer.concat(this.frag).toString("utf8");
          this.frag = [];
          this.handle(text);
        }
      }
    }
  }

  private handle(text: string) {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(`${m.error.message ?? "rpc error"} (${m.error.code})`)) : p.resolve(m.result);
    } else if (m.method) {
      // 서버가 보낸 요청(id 있음)에는 빈 응답을 돌려 막히지 않게 한다
      if (m.id !== undefined) this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unsupported" } });
      else this.onNotification(m.method, m.params);
    }
  }

  private frame(op: number, payload: Buffer) {
    const mask = randomBytes(4);
    const n = payload.length;
    const head =
      n < 126 ? Buffer.from([0x80 | op, 0x80 | n])
      : n < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 0xff])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    const masked = Buffer.from(payload);
    for (let i = 0; i < n; i++) masked[i] ^= mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }

  private send(obj: unknown) {
    this.frame(1, Buffer.from(JSON.stringify(obj)));
  }

  request<T = any>(method: string, params: unknown = {}, timeoutMs = 15000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 시간 초과`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  close() {
    try {
      this.frame(8, Buffer.alloc(0));
    } catch {}
    this.sock.end();
  }
}
