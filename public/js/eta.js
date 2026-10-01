// 내 정류장으로 다가오는 버스와 예상 도착 시간 계산.
// 모든 위치는 노선 경로 위의 거리(m)로 다룬다. 노선은 한 방향으로만 진행하므로
// 내 정류장보다 앞(거리가 작은 쪽)에 있는 버스만 나에게 온다.

export const DEFAULT_ROUTE_SPEED = 4.2; // m/s ≈ 15km/h, 정차 시간을 포함한 도심 버스 평균 속도
const ARRIVED_MARGIN = 30; // 정류장 앞뒤 이 거리 안이면 "곧 도착"

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 한 대의 순간 속도는 정차·신호 때문에 들쭉날쭉하므로, 노선 전체 버스의 중앙값을 평균 속도로 쓴다.
export function routeSpeed(speeds) {
  const moving = speeds.filter((v) => v > 0.5).sort((a, b) => a - b);
  if (moving.length < 3) return DEFAULT_ROUTE_SPEED;
  return clamp(moving[moving.length >> 1], 3, 8);
}

// sorted 배열에서 lo < x <= hi 인 값의 개수
function countBetween(sorted, lo, hi) {
  const upper = (v) => {
    let a = 0;
    let b = sorted.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (sorted[m] <= v) a = m + 1;
      else b = m;
    }
    return a;
  };
  return Math.max(0, upper(hi) - upper(lo));
}

// stopS: 내 정류장 위치, stopDistances: 모든 정류장 위치(오름차순), buses: [{ id, s }]
export function approachingBuses({ stopS, stopDistances, buses, speed = DEFAULT_ROUTE_SPEED }) {
  return buses
    .filter((bus) => bus.s <= stopS + ARRIVED_MARGIN)
    .map((bus) => {
      const distance = Math.max(0, stopS - bus.s);
      const arrived = distance <= ARRIVED_MARGIN;
      return {
        id: bus.id,
        distance,
        // 버스가 지금 지나는 구간 이후 ~ 내 정류장까지 남은 정류장 수 (내 정류장 포함)
        stopsAway: arrived ? 0 : countBetween(stopDistances, bus.s + ARRIVED_MARGIN, stopS),
        seconds: arrived ? 0 : distance / speed,
      };
    })
    .sort((a, b) => a.distance - b.distance);
}

export function formatDuration(seconds) {
  if (seconds < 60) return '곧 도착';
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

export function formatDistance(meters) {
  return meters < 1000 ? `${Math.round(meters / 10) * 10}m` : `${(meters / 1000).toFixed(1)}km`;
}

// 걷는 속도 4km/h 기준
export const walkingMinutes = (meters) => Math.max(1, Math.round(meters / 67));
