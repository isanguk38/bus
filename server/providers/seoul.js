import { ApiError, buildUrl, fetchJson, toArray } from '../lib/http.js';
import { Quota } from '../lib/quota.js';

const ROUTE_TYPES = {
  0: '공용', 1: '공항', 2: '마을', 3: '간선', 4: '지선', 5: '순환', 6: '광역', 7: '인천', 8: '경기', 9: '폐지',
};
const CONGESTION = { 3: '여유', 4: '보통', 5: '혼잡', 6: '매우혼잡' };
const NO_RESULT = '4';
const NEARBY_RADIUS = 500; // m
const NOT_RUNNING = /운행종료|출발대기|정보없음|회차지/;

// "20261001091541"(KST) → epoch ms
function parseKst(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp ?? '');
  if (!m) return Date.now();
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h - 9, mi, s);
}

const clean = (text) => (text ?? '').trim() || null;

// 정류장 도착 정보의 n번째(1, 2) 버스
function arrivalOf(item, n) {
  const message = clean(item[`arrmsg${n}`]) ?? '';
  const vehicle = item[`vehId${n}`];
  if (!vehicle || vehicle === '0' || NOT_RUNNING.test(message)) return null;
  const seconds = Number(item[`traTime${n}`]);
  const stopsAway = Number(item.staOrd) - Number(item[`sectOrd${n}`]);
  return {
    seconds: Number.isFinite(seconds) ? seconds : null,
    stopsAway: stopsAway >= 0 ? stopsAway : null,
    lowFloor: item[`busType${n}`] === '1',
    arriving: item[`isArrive${n}`] === '1' || message.startsWith('곧 도착'),
  };
}

export function createSeoulProvider({ serviceKey, positionUrl, routeUrl, stationUrl, pollMs, dailyLimit }) {
  const positionQuota = new Quota('서울 버스위치정보', dailyLimit);
  const routeQuota = new Quota('서울 노선정보', dailyLimit);
  const stationQuota = new Quota('서울 정류소정보', dailyLimit);

  async function call(base, operation, params, quota) {
    quota.take();
    const json = await fetchJson(buildUrl(base, operation, { serviceKey, resultType: 'json', ...params }));
    const header = json.msgHeader;
    if (!header) throw new ApiError('서울 API 응답 형식이 올바르지 않습니다.');
    if (header.headerCd === NO_RESULT) return [];
    if (header.headerCd !== '0') throw new ApiError(`서울 API: ${header.headerMsg}`);
    return toArray(json.msgBody?.itemList);
  }

  return {
    id: 'seoul',
    pollMs,
    quotas: () => [positionQuota.snapshot(), routeQuota.snapshot(), stationQuota.snapshot()],

    async searchRoutes(query) {
      const items = await call(routeUrl, 'getBusRouteList', { strSrch: query }, routeQuota);
      return items.slice(0, 30).map((r) => ({
        id: r.busRouteId,
        number: r.busRouteNm,
        type: ROUTE_TYPES[r.routeType] ?? null,
        start: r.stStationNm,
        end: r.edStationNm,
      }));
    },

    async getRoute(routeId) {
      const [pathItems, stationItems] = await Promise.all([
        call(routeUrl, 'getRoutePath', { busRouteId: routeId }, routeQuota),
        call(routeUrl, 'getStaionByRoute', { busRouteId: routeId }, routeQuota),
      ]);
      if (!stationItems.length) throw new ApiError('노선 정보를 찾을 수 없습니다.', { status: 404 });
      const path = pathItems
        .sort((a, b) => Number(a.no) - Number(b.no))
        .map((p) => [Number(p.gpsY), Number(p.gpsX)]);
      const stops = stationItems.map((s) => ({
        ord: Number(s.seq),
        // 정류장 번호(arsId)를 ID로 쓴다. 정류장 표지판에 적힌 번호이자 도착 정보 조회 키.
        id: s.arsId,
        no: s.arsId !== '0' ? s.arsId : null,
        name: s.stationNm,
        lat: Number(s.gpsY),
        lng: Number(s.gpsX),
        direction: clean(s.direction) ? `${s.direction.trim()} 방면` : null,
      }));
      const first = stationItems[0];
      return {
        id: routeId,
        region: 'seoul',
        number: first.busRouteNm,
        type: ROUTE_TYPES[first.routeType] ?? null,
        path,
        stops,
        pathSource: 'road',
      };
    },

    async getPositions(routeId) {
      const items = await call(positionUrl, 'getBusPosByRtid', { busRouteId: routeId }, positionQuota);
      return items.map((b) => ({
        id: b.vehId,
        plate: b.plainNo,
        lat: Number(b.gpsY),
        lng: Number(b.gpsX),
        // sectOrd: 버스가 마지막으로 지난 정류소의 순번
        stopOrd: Number(b.sectOrd) || null,
        lowFloor: b.busType === '1',
        congestion: CONGESTION[b.congetion] ?? null,
        observedAt: parseKst(b.dataTm),
      }));
    },

    async nearbyStops(lat, lng) {
      const items = await call(stationUrl, 'getStationByPos', { tmX: lng, tmY: lat, radius: NEARBY_RADIUS }, stationQuota);
      return items
        .filter((s) => s.arsId && s.arsId !== '0')
        .map((s) => ({
          region: 'seoul',
          id: s.arsId,
          no: s.arsId,
          name: s.stationNm,
          lat: Number(s.gpsY),
          lng: Number(s.gpsX),
        }));
    },

    async searchStops(query) {
      const items = await call(stationUrl, 'getStationByName', { stSrch: query }, stationQuota);
      return items
        .filter((s) => s.arsId && s.arsId !== '0')
        .map((s) => ({
          region: 'seoul',
          id: s.arsId,
          no: s.arsId,
          name: s.stNm,
          // 이 오퍼레이션은 tmX/tmY 필드에 WGS84 경위도를 담아 준다.
          lat: Number(s.tmY),
          lng: Number(s.tmX),
        }));
    },

    async stopArrivals(stopId) {
      const items = await call(stationUrl, 'getStationByUid', { arsId: stopId }, stationQuota);
      if (!items.length) throw new ApiError('정류장 정보를 찾을 수 없습니다.', { status: 404 });
      const first = items[0];
      return {
        stop: { region: 'seoul', id: stopId, no: stopId, name: first.stNm, lat: Number(first.gpsY), lng: Number(first.gpsX) },
        routes: items.map((r) => {
          const buses = [arrivalOf(r, 1), arrivalOf(r, 2)].filter(Boolean);
          return {
            routeId: r.busRouteId,
            number: r.rtNm,
            type: ROUTE_TYPES[r.routeType] ?? null,
            direction: clean(r.adirection) ? `${r.adirection.trim()} 방면` : null,
            buses,
            message: buses.length ? null : clean(r.arrmsg1) ?? '도착 정보 없음',
          };
        }),
      };
    },
  };
}
