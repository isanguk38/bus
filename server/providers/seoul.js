import { ApiError, buildUrl, fetchJson, toArray } from '../lib/http.js';
import { Quota } from '../lib/quota.js';

const ROUTE_TYPES = {
  0: '공용', 1: '공항', 2: '마을', 3: '간선', 4: '지선', 5: '순환', 6: '광역', 7: '인천', 8: '경기', 9: '폐지',
};
const CONGESTION = { 3: '여유', 4: '보통', 5: '혼잡', 6: '매우혼잡' };
const NO_RESULT = '4';

// "20261001091541"(KST) → epoch ms
function parseKst(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp ?? '');
  if (!m) return Date.now();
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h - 9, mi, s);
}

export function createSeoulProvider({ serviceKey, positionUrl, routeUrl, pollMs, dailyLimit }) {
  const positionQuota = new Quota('서울 버스위치정보', dailyLimit);
  const routeQuota = new Quota('서울 노선정보', dailyLimit);

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
    quotas: () => [positionQuota.snapshot(), routeQuota.snapshot()],

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
        id: s.station,
        name: s.stationNm,
        lat: Number(s.gpsY),
        lng: Number(s.gpsX),
      }));
      return { id: routeId, region: 'seoul', number: stationItems[0].busRouteNm, path, stops, pathSource: 'road' };
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
  };
}
