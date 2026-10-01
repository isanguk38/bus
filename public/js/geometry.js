// 노선 경로(위경도 배열)를 "출발점에서부터의 거리(m)"로 다루기 위한 도구.
// 버스 위치를 경로 위의 거리 s로 바꾸면, 애니메이션은 s를 늘려가기만 하면 되고
// 화면에 그릴 때 다시 위경도로 바꾼다. 그래서 버스가 건물을 가로지르지 않고 도로를 따라간다.

const EARTH_RADIUS = 6_371_008.8;
const DEG = Math.PI / 180;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 한 도시 규모에서는 등거리 원통 투영으로 충분히 정확하다 (오차 1% 미만).
export function createPolyline(latlngs) {
  const unique = latlngs.filter(
    ([lat, lng], i) => i === 0 || lat !== latlngs[i - 1][0] || lng !== latlngs[i - 1][1],
  );
  const lat0 = (unique.reduce((sum, [lat]) => sum + lat, 0) / unique.length) * DEG;
  const kx = EARTH_RADIUS * Math.cos(lat0) * DEG;
  const ky = EARTH_RADIUS * DEG;
  const pts = unique.map(([lat, lng]) => ({ x: lng * kx, y: lat * ky }));

  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return { latlngs: unique, pts, cum, length: cum[cum.length - 1], kx, ky };
}

// (lat, lng)에서 가장 가까운 경로 위 지점을 [minS, maxS] 구간 안에서 찾는다.
// 왕복 노선은 같은 도로를 두 번 지나므로 구간을 제한해야 반대 방향으로 붙지 않는다.
export function project(line, lat, lng, minS = 0, maxS = line.length) {
  const { pts, cum } = line;
  const px = lng * line.kx;
  const py = lat * line.ky;
  let best = { s: clamp(minS, 0, line.length), distance: Infinity };

  for (let i = 0; i < pts.length - 1; i++) {
    if (cum[i + 1] < minS || cum[i] > maxS) continue;
    const a = pts[i];
    const b = pts[i + 1];
    const segLen = cum[i + 1] - cum[i];
    const t = segLen ? clamp(((px - a.x) * (b.x - a.x) + (py - a.y) * (b.y - a.y)) / (segLen * segLen), 0, 1) : 0;
    const s = clamp(cum[i] + t * segLen, minS, maxS);
    const u = segLen ? (s - cum[i]) / segLen : 0;
    const distance = Math.hypot(a.x + (b.x - a.x) * u - px, a.y + (b.y - a.y) * u - py);
    if (distance < best.distance) best = { s, distance };
  }
  return best;
}

// 경로 위 거리 s 지점의 위경도와 진행 방향(북쪽 기준 시계방향 각도)
export function pointAt(line, s) {
  const { pts, cum, latlngs } = line;
  if (pts.length === 1) return { lat: latlngs[0][0], lng: latlngs[0][1], bearing: 0 };
  s = clamp(s, 0, line.length);

  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const segLen = cum[hi] - cum[lo];
  const t = segLen ? (s - cum[lo]) / segLen : 0;
  const [lat1, lng1] = latlngs[lo];
  const [lat2, lng2] = latlngs[hi];
  const bearing = (Math.atan2(pts[hi].x - pts[lo].x, pts[hi].y - pts[lo].y) / DEG + 360) % 360;
  return { lat: lat1 + (lat2 - lat1) * t, lng: lng1 + (lng2 - lng1) * t, bearing };
}

// 경로에서 [s0, s1] 구간만 잘라낸 위경도 배열 (방향별로 선 색을 다르게 그릴 때 사용)
export function slicePath(line, s0, s1) {
  const { cum, latlngs } = line;
  const start = pointAt(line, s0);
  const end = pointAt(line, s1);
  const inner = latlngs.filter((_, i) => cum[i] > s0 && cum[i] < s1);
  return [[start.lat, start.lng], ...inner, [end.lat, end.lng]];
}

// 각 정류장의 경로 위 거리. 앞 정류장 이후 구간에서만 찾아 순서가 뒤집히지 않게 한다.
export function locateStops(line, stops, maxGap = 6000) {
  let prev = 0;
  return stops.map((stop) => {
    const { s } = project(line, stop.lat, stop.lng, prev, prev + maxGap);
    prev = s;
    return s;
  });
}
