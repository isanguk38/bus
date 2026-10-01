import { distanceMeters } from './geo.js';

const MIN_INTERVAL_SEC = 5;
const MAX_SPEED = 25; // m/s = 90km/h, 이보다 빠르면 GPS 튐으로 본다

// 차량별 속도를 서버에서 한 번만 추정해 모든 화면에 같은 값을 보낸다.
// 브라우저마다 따로 추정하면 화면을 연 시점에 따라 속도 기록이 달라 도착 예정 시간이 화면마다 달라진다.
//
// previous: Map<차량 ID, { lat, lng, at, speed, startKnown }>  (지난 수집 결과)
// 반환: { tracked: 이번 수집 결과(다음 호출의 previous), buses: speed(m/s 또는 null)를 붙인 목록 }
//
// startKnown: 그 위치에 "도착한 시각"을 실제로 아는지. 수집을 막 시작했을 때 처음 본 위치는
// 버스가 언제부터 거기 있었는지 모르므로(at이 실제보다 늦음) 속도 계산의 출발점으로 쓰지 않는다.
// 그렇지 않으면 이동 시간이 짧게 잡혀 속도가 부풀려진다 (실측에서 2배 가까이).
export function estimateSpeeds(previous, buses) {
  const tracked = new Map();
  const withSpeed = buses.map((bus) => {
    const prev = previous.get(bus.id);
    let speed = prev?.speed ?? null;
    let next = { lat: bus.lat, lng: bus.lng, at: bus.observedAt, speed, startKnown: Boolean(prev) };

    const dt = prev ? (bus.observedAt - prev.at) / 1000 : 0;
    if (prev && dt < MIN_INTERVAL_SEC) {
      // 위치가 아직 안 바뀌었거나 간격이 너무 짧다: 이전 기준점을 유지한다.
      next = { ...prev };
    } else if (prev?.startKnown) {
      // 직선 거리라 굽은 도로에서는 조금 작게 나오지만, 수십 초 간격에서는 차이가 작다.
      const v = distanceMeters(prev, bus) / dt;
      if (v <= MAX_SPEED) speed = speed == null ? v : speed * 0.5 + v * 0.5;
      next.speed = speed;
    }
    tracked.set(bus.id, next);
    return { ...bus, speed };
  });
  return { tracked, buses: withSpeed };
}
