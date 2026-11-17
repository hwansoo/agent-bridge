// 단위 테스트: RateWindow(슬라이딩 윈도 속도 제한기). 실행: npm run test:unit
// esbuild로 src/ratelimit.ts를 OS 임시 디렉터리에 번들한 뒤 동적 import로 가져온다.
// 시간은 모두 allow(now)/record(now)로 주입한다(Date.now/타이머 사용 금지).
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "msgr-unit-"));
const OUT = path.join(TMP, "ratelimit.mjs");

buildSync({
  entryPoints: [path.join(ROOT, "src/ratelimit.ts")],
  outfile: OUT,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
});

const { RateWindow } = await import(OUT);

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const MAX = 2;
const WINDOW = 1000;

describe("RateWindow", () => {
  test("a. 기록이 없으면 allow(0)은 true", () => {
    const rw = new RateWindow(MAX, WINDOW);
    assert.equal(rw.allow(0), true);
  });

  test("b. 윈도 안에서 max만큼 기록하면 allow는 false", () => {
    const full = new RateWindow(MAX, WINDOW);
    full.record(0);
    full.record(0);
    assert.equal(full.allow(0), false);

    const one = new RateWindow(MAX, WINDOW);
    one.record(0);
    assert.equal(one.allow(0), true);
  });

  test("c. allow()만 호출하면 슬롯을 소비하지 않는다", () => {
    const rw = new RateWindow(MAX, WINDOW);
    for (let i = 0; i < 10; i++) assert.equal(rw.allow(0), true);

    rw.record(0);
    rw.record(0);
    assert.equal(rw.allow(0), false, "allow()를 여러 번 불러도 슬롯은 그대로여야 한다");
  });

  test("d. 경계: 정확히 windowMs 차이는 아직 윈도 안", () => {
    const rw = new RateWindow(MAX, WINDOW);
    rw.record(0);
    rw.record(0);
    assert.equal(rw.allow(1000), false);
    assert.equal(rw.allow(1001), true);
  });

  test("e. 슬라이딩: 오래된 기록만 만료된다", () => {
    const rw = new RateWindow(MAX, WINDOW);
    rw.record(0);
    rw.record(500);
    assert.equal(rw.allow(1001), true, "0은 만료되고 500은 남아 슬롯이 하나 있어야 한다");

    rw.record(1001);
    assert.equal(rw.allow(1001), false, "1001 기록으로 슬롯이 다시 가득 차야 한다");
  });

  test("f. 기본 windowMs는 60000", () => {
    const rw = new RateWindow(1);
    rw.record(0);
    assert.equal(rw.allow(60_000), false);
    assert.equal(rw.allow(60_001), true);
  });
});
