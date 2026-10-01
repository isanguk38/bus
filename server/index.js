import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { ApiError } from './lib/http.js';
import { TtlCache } from './lib/cache.js';
import { normalizeRouteQuery } from './lib/query.js';
import { createRegistry } from './providers/index.js';
import { LiveHub } from './live-hub.js';

const HOUR = 3600_000;
const ROUTE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const HEARTBEAT_MS = 25_000;

const registry = createRegistry(config);
const hub = new LiveHub();
// 노선·정류장 같은 정적 정보는 거의 바뀌지 않으므로 오래 캐시해 호출 한도를 아낀다.
const regionsCache = new TtlCache(24 * HOUR, 1);
const searchCache = new TtlCache(HOUR, 500);
const routeCache = new TtlCache(24 * HOUR, 300);

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
