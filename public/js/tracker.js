// 버스 한 대의 화면상 위치를 관리한다.
//
// 공공 API 위치는 서울 약 11초, TAGO 약 40초마다 바뀌고, 받는 순간에도 이미 몇 초 지난 값이다.
// 그대로 찍으면 버스가 순간이동하므로 다음처럼 처리한다.
//   1. 관측값 두 개로 속도를 추정한다.
//   2. 다음 관측이 오기 전까지는 "마지막 관측 위치 + 속도 × 경과 시간"으로 앞으로 나아간다 (추측 항법).
//   3. 화면의 버스는 이 예측 지점을 "몇 초 뒤에 도착할 곳"으로 삼아 속도를 서서히 바꿔 따라간다.
//      새 관측이 예측과 어긋나도 순간적으로 튀지 않고, 몇 초에 걸쳐 빨라지거나 느려지며 맞춘다.
//   4. 뒤로는 움직이지 않는다. 예측이 앞섰으면 실제 위치가 따라올 때까지 천천히 멈춘다.

export const DEFAULT_SPEED = 4; // m/s ≈ 14km/h, 도심 시내버스 평균 운행 속도 수준
const MAX_SPEED = 25; // m/s = 90km/h, 이보다 빠른 추정값은 GPS 튐으로 보고 버린다
const MAX_LEAD = 600; // 관측 위치보다 최대 몇 m 앞까지 예측할지 (TAGO 갱신 간격 40초 × 15m/s)
const SNAP_DISTANCE = 1500; // 이보다 크게 어긋나면 따라가지 않고 바로 옮긴다
const LOOKAHEAD = 12; // 초. 이만큼 뒤의 예측 지점에 맞춰 속도를 정한다 (클수록 부드럽고 반응은 느림)
const ACCELERATION = 1.5; // 화면 속도가 목표 속도에 다가가는 비율 (초당)
const MAX_DISPLAY_SPEED = 20; // m/s = 72km/h, 따라잡을 때도 이보다 빠르게 움직이지 않는다
// 예측은 추정 속도보다 조금 느리게 한다. 앞서 나갔다가 실제 위치를 기다리며 멈추는 것보다
// 살짝 뒤처졌다가 따라가는 편이 자연스럽다. (3분 실데이터 비교: 멈춤 19% → 9%, 최대 속도 108 → 72km/h)
const PREDICTION_FACTOR = 0.8;

export class BusTrack {
  constructor({ s, at, info }) {
    this.observedS = s;
    this.observedAt = at;
    this.speed = DEFAULT_SPEED;
    this.measured = false;
    this.s = s;
    this.displaySpeed = 0;
    this.info = info;
    // 내 정류장 위치. 실제 관측이 이 지점을 지나기 전에는 예측만으로 지나가지 않는다 (정류장에서 기다림).
    this.holdAt = null;
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
    if (Math.abs(s - this.s) > SNAP_DISTANCE) {
      this.s = s;
      this.displaySpeed = this.speed;
    }
  }

  target(now) {
    const elapsed = Math.max(0, (now - this.observedAt) / 1000);
    const predicted = this.observedS + Math.min(this.speed * PREDICTION_FACTOR * elapsed, MAX_LEAD);
    return this.holdAt != null && this.observedS < this.holdAt ? Math.min(predicted, this.holdAt) : predicted;
  }

  step(now, dtSec) {
    // LOOKAHEAD초 뒤 예측 지점에 그때 도착하려면 필요한 속도
    const ahead = this.target(now + LOOKAHEAD * 1000) - this.s;
    const wanted = Math.min(MAX_DISPLAY_SPEED, Math.max(0, ahead / LOOKAHEAD));
    this.displaySpeed += (wanted - this.displaySpeed) * Math.min(1, dtSec * ACCELERATION);
    this.s += this.displaySpeed * dtSec;
    return this.s;
  }
}
