// 버스 한 대의 화면상 위치를 관리한다.
//
// 공공 API 위치는 20~30초마다 한 번씩만 갱신되고, 받는 순간에도 이미 몇 초 지난 값이다.
// 그대로 찍으면 버스가 순간이동하므로 다음처럼 처리한다.
//   1. 관측값 두 개로 속도를 추정한다.
//   2. 다음 관측이 오기 전까지는 "마지막 관측 위치 + 속도 × 경과 시간"으로 앞으로 나아간다 (추측 항법).
//   3. 화면의 버스는 이 목표 지점을 부드럽게 따라간다. 뒤로는 움직이지 않는다.
//      예측이 너무 앞섰으면 실제 위치가 따라올 때까지 잠시 멈춰 기다린다.

export const DEFAULT_SPEED = 4; // m/s ≈ 14km/h, 도심 시내버스 평균 운행 속도 수준
const MAX_SPEED = 25; // m/s = 90km/h, 이보다 빠른 추정값은 GPS 튐으로 보고 버린다
const MAX_LEAD = 400; // 관측 위치보다 최대 몇 m 앞까지 예측할지
const SNAP_DISTANCE = 1500; // 이보다 크게 어긋나면 따라가지 않고 바로 옮긴다
const FOLLOW_RATE = 1.5; // 목표를 따라잡는 속도 (초당 남은 거리의 비율)

export class BusTrack {
  constructor({ s, at, info }) {
    this.observedS = s;
    this.observedAt = at;
    this.speed = DEFAULT_SPEED;
    this.measured = false;
    this.s = s;
    this.info = info;
  }

  update({ s, at, info }) {
    const dt = (at - this.observedAt) / 1000;
    this.info = info;
    if (dt < 1) return; // 같은 관측이 다시 온 경우

    const v = (s - this.observedS) / dt;
    if (v >= 0 && v <= MAX_SPEED) {
      this.speed = this.measured ? this.speed * 0.5 + v * 0.5 : v;
      this.measured = true;
    } else if (v < 0) {
      this.speed = 0;
    }
    this.observedS = s;
    this.observedAt = at;
    if (Math.abs(s - this.s) > SNAP_DISTANCE) this.s = s;
  }

  target(now) {
    const elapsed = Math.max(0, (now - this.observedAt) / 1000);
    return this.observedS + Math.min(this.speed * elapsed, MAX_LEAD);
  }

  step(now, dtSec) {
    const gap = this.target(now) - this.s;
    if (gap > 0) this.s += gap * Math.min(1, dtSec * FOLLOW_RATE);
    return this.s;
  }
}
