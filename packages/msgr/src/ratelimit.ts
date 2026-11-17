/** 슬라이딩 윈도 속도 제한기(프로세스 내). 푸시 모듈들이 공유한다. */
export class RateWindow {
  private hits: number[] = [];
  constructor(private max: number, private windowMs = 60_000) {}
  private prune(now: number) {
    while (this.hits.length && now - this.hits[0] > this.windowMs) this.hits.shift();
  }
  /** 지금 한 번 더 허용되는가? */
  allow(now = Date.now()): boolean {
    this.prune(now);
    return this.hits.length < this.max;
  }
  record(now = Date.now()) {
    this.hits.push(now);
  }
}

/** 실패/보류가 이어질 때 재시도 간격을 늘린다(2s → 4s → … → 최대 maxMs). 성공하면 초기화. */
export class Backoff {
  private fails = 0;
  private until = 0;
  constructor(private baseMs = 2000, private maxMs = 5 * 60_000) {}
  ready(now = Date.now()) {
    return now >= this.until;
  }
  fail(now = Date.now()) {
    this.fails++;
    this.until = now + Math.min(this.maxMs, this.baseMs * 2 ** (this.fails - 1));
  }
  ok() {
    this.fails = 0;
    this.until = 0;
  }
}
