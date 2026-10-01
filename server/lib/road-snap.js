import { fetchJson } from './http.js';

// TAGO는 도로 경로 없이 정류장 좌표만 준다. 정류장을 직선으로 이으면 선이 건물을 가로지르고
// 버스도 도로 밖에 그려지므로, OSRM(OpenStreetMap 기반 무료 경로 탐색)으로 정류장 사이를 실제 도로에 맞춰 잇는다.
const OSRM_URL = process.env.OSRM_URL ?? 'https://router.project-osrm.org';
const CHUNK_SIZE = 25; // 한 번에 보낼 정류장 수
const REQUEST_GAP_MS = 1100; // 공개 데모 서버 이용 정책: 초당 1회
// 도로 경로가 직선보다 이만큼 길면 일방통행·유턴 때문에 엉뚱하게 돌아간 것으로 보고 직선을 쓴다.
const DETOUR_RATIO = 3;
const DETOUR_SLACK_METERS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}

async function routeLegs(stops) {
  const coords = stops.map((s) => `${s.lng},${s.lat}`).join(';');
  const json = await fetchJson(
    `${OSRM_URL}/route/v1/driving/${coords}?overview=false&steps=true&geometries=geojson`,
    { timeoutMs: 15_000 },
  );
  if (json.code !== 'Ok') throw new Error(`OSRM: ${json.code}`);
  return json.routes[0].legs.map((leg) => ({
    distance: leg.distance,
    coords: leg.steps.flatMap((step) => step.geometry.coordinates.map(([lng, lat]) => [lat, lng])),
  }));
}

// 정류장 순서대로 도로를 따라가는 경로를 만든다. 실패한 구간은 직선으로 채운다.
// roadRatio: 도로 경로로 이은 구간의 비율 (0~1)
export async function snapToRoads(stops) {
  const path = [];
  let roadLegs = 0;

  for (let i = 0; i < stops.length - 1; i += CHUNK_SIZE - 1) {
    if (i > 0) await sleep(REQUEST_GAP_MS);
    const chunk = stops.slice(i, i + CHUNK_SIZE);
    let legs = null;
    try {
      legs = await routeLegs(chunk);
    } catch (err) {
      console.warn('[road-snap] 도로 경로 계산 실패, 직선으로 대체:', err.message);
    }

    for (let j = 0; j < chunk.length - 1; j++) {
      const from = chunk[j];
      const to = chunk[j + 1];
      const leg = legs?.[j];
      const onRoad = leg && leg.distance <= distanceMeters(from, to) * DETOUR_RATIO + DETOUR_SLACK_METERS;
      if (onRoad) roadLegs += 1;
      path.push(...(onRoad ? leg.coords : [[from.lat, from.lng], [to.lat, to.lng]]));
    }
  }

  return { path, roadRatio: stops.length > 1 ? roadLegs / (stops.length - 1) : 0 };
}
