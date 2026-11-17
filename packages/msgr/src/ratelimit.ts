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
