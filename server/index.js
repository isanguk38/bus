import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { ApiError } from './lib/http.js';
import { TtlCache } from './lib/cache.js';
import { normalizeRouteQuery } from './lib/query.js';
import { distanceMeters } from './lib/geo.js';
import { createVworld } from './lib/vworld.js';
import { createRegistry } from './providers/index.js';
import { LiveHub } from './live-hub.js';

const HOUR = 3600_000;
const ROUTE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const HEARTBEAT_MS = 25_000;

const registry = createRegistry(config);
const vworld = createVworld(config.vworld);
const hub = new LiveHub();
// 노선·정류장 같은 정적 정보는 거의 바뀌지 않으므로 오래 캐시해 호출 한도를 아낀다.
const regionsCache = new TtlCache(24 * HOUR, 1);
const searchCache = new TtlCache(HOUR, 500);
const routeCache = new TtlCache(24 * HOUR, 300);
const nearbyCache = new TtlCache(5 * 60_000, 1000);
// 정류장 이름 검색은 TAGO 응답이 3~8초로 느려서 하루 동안 캐시한다.
const stopSearchCache = new TtlCache(24 * HOUR, 2000);
const placeSearchCache = new TtlCache(24 * HOUR, 2000);
// 같은 정류장을 여러 명이 보고 있어도 도착 정보는 15초에 한 번만 조회한다.
const arrivalsCache = new TtlCache(15_000, 1000);

function coordinateOf(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new ApiError('위치 좌표가 올바르지 않습니다.', { status: 400 });
  return n;
}

// 곧 오는 버스가 있는 노선부터, 그다음은 노선 번호 순
function byArrival(a, b) {
  const ta = a.buses[0]?.seconds ?? Infinity;
  const tb = b.buses[0]?.seconds ?? Infinity;
  return ta - tb || a.number.localeCompare(b.number, 'ko', { numeric: true });
}

const app = express();
app.disable('x-powered-by');
// 배포 직후 새 코드가 바로 반영되도록 매번 ETag로 변경 여부를 확인하게 둔다.
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

const handle = (fn) => (req, res, next) => fn(req, res).catch(next);

function routeIdOf(value) {
  if (!ROUTE_ID.test(value ?? '')) throw new ApiError('노선 ID가 올바르지 않습니다.', { status: 400 });
  return value;
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/regions', handle(async (req, res) => {
  res.json(await regionsCache.get('all', () => registry.regions()));
}));

app.get('/api/routes', handle(async (req, res) => {
  const query = normalizeRouteQuery(req.query.q);
  if (!query || query.length > 20) throw new ApiError('노선 번호를 입력해 주세요.', { status: 400 });
  const source = registry.resolve(req.query.region);
  res.json(await searchCache.get(`${source.id}:${query}`, () => source.searchRoutes(query)));
}));

app.get('/api/routes/:region/:routeId', handle(async (req, res) => {
  const source = registry.resolve(req.params.region);
  const routeId = routeIdOf(req.params.routeId);
  res.json(await routeCache.get(`${source.id}:${routeId}`, () => source.getRoute(routeId)));
}));

// 좌표 근처 정류장 (대한민국 범위만 허용)
app.get('/api/nearby', handle(async (req, res) => {
  const lat = coordinateOf(req.query.lat, 33, 39);
  const lng = coordinateOf(req.query.lng, 124, 132);
  // 약 100m 단위로 묶어 캐시한다.
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  res.json(await nearbyCache.get(key, () => registry.nearbyStops(lat, lng)));
}));

// 화면 설정: 배경지도 종류, 장소 검색 지원 여부
app.get('/api/config', (req, res) => {
  res.json({ tiles: vworld?.tiles ?? null, placeSearch: Boolean(vworld) });
});

// 탑승 위치 검색: 정류장 이름(서울·TAGO) + 장소·주소(브이월드 키가 있을 때)
// lat/lng를 주면 정류장을 그 위치에서 가까운 순으로 정렬한다.
app.get('/api/search', handle(async (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (query.length < 2 || query.length > 40) throw new ApiError('검색어를 2글자 이상 입력해 주세요.', { status: 400 });
  const source = registry.resolve(req.query.region);
  const near = req.query.lat && req.query.lng
    ? { lat: coordinateOf(req.query.lat, 33, 39), lng: coordinateOf(req.query.lng, 124, 132) }
    : null;

  const [stops, places] = await Promise.allSettled([
    stopSearchCache.get(`${source.id}:${query}`, () => source.searchStops(query)),
    vworld ? placeSearchCache.get(query, () => vworld.searchPlaces(query)) : [],
  ]);
  if (stops.status === 'rejected' && places.status === 'rejected') throw stops.reason;
  if (places.status === 'rejected') console.warn('[search] 장소 검색 실패:', places.reason.message);

  let stopList = stops.status === 'fulfilled' ? stops.value : [];
  if (near) {
    stopList = stopList
      .map((s) => ({ ...s, distance: Math.round(distanceMeters(near, s)) }))
      .sort((a, b) => a.distance - b.distance);
  }
  res.json({
    stops: stopList.slice(0, 15),
    places: places.status === 'fulfilled' ? places.value : [],
    placeSearch: Boolean(vworld),
  });
}));

// 정류장 도착 예정 정보
app.get('/api/stops/:region/:stopId/arrivals', handle(async (req, res) => {
  const source = registry.resolve(req.params.region);
  const stopId = routeIdOf(req.params.stopId);
  // fetchedAt은 실제 조회 시각이다 (캐시된 응답이면 최대 15초 전). 브라우저는 이 기준으로 남은 시간을 줄여 보여준다.
  const data = await arrivalsCache.get(`${source.id}:${stopId}`, async () => {
    const result = await source.stopArrivals(stopId);
    return { ...result, routes: result.routes.sort(byArrival), fetchedAt: Date.now() };
  });
  // 서버·브라우저 시계가 달라도 되도록 "몇 ms 전에 조회한 값인지"를 함께 보낸다.
  res.json({ ...data, ageMs: Date.now() - data.fetchedAt });
}));

// 실시간 버스 위치 스트림 (Server-Sent Events)
app.get('/api/live', (req, res, next) => {
  let source, routeId;
  try {
    source = registry.resolve(req.query.region);
    routeId = routeIdOf(req.query.route);
  } catch (err) {
    return next(err);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');

  const send = (message) => res.write(`data: ${JSON.stringify(message)}\n\n`);
  const unsubscribe = hub.subscribe(source, routeId, send);
  // 프록시가 유휴 연결을 끊지 않도록 주기적으로 주석 줄을 보낸다.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.get('/api/status', (req, res) => {
  res.json({ quotas: registry.quotas(), liveChannels: hub.stats() });
});

app.use('/api', (req, res) => res.status(404).json({ error: '존재하지 않는 API입니다.' }));

app.use((err, req, res, next) => {
  const known = err instanceof ApiError;
  if (!known) console.error(err);
  res.status(known ? err.status : 500).json({
    error: known ? err.message : '서버 오류가 발생했습니다.',
    code: known ? err.code : null,
  });
});

app.listen(config.port, () => {
  console.log(`버스 지도 서버 실행 중: http://localhost:${config.port}`);
});
