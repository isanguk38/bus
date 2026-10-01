import { ApiError, buildUrl, fetchJson, toArray } from '../lib/http.js';
import { Quota } from '../lib/quota.js';

// 국토교통부 TAGO: 서울을 제외한 전국(경기 시·군 포함) 시내버스
export function createTagoProvider({ serviceKey, locationUrl, routeUrl, pollMs, dailyLimit }) {
  const locationQuota = new Quota('TAGO 버스위치정보', dailyLimit);
  const routeQuota = new Quota('TAGO 버스노선정보', dailyLimit);

  async function call(base, operation, params, quota) {
    quota.take();
    const json = await fetchJson(
      buildUrl(base, operation, { serviceKey, _type: 'json', pageNo: 1, numOfRows: 1000, ...params }),
    );
    const header = json.response?.header;
    if (!header) throw new ApiError('TAGO API 응답 형식이 올바르지 않습니다.');
    if (header.resultCode !== '00') throw new ApiError(`TAGO API: ${header.resultMsg}`);
    // 결과가 1건이면 배열이 아니라 객체로, 0건이면 빈 문자열로 온다.
    return toArray(json.response.body?.items?.item);
  }

  function forCity(cityCode) {
    return {
      id: `tago-${cityCode}`,
      pollMs,

      async searchRoutes(query) {
        const items = await call(routeUrl, 'getRouteNoList', { cityCode, routeNo: query }, routeQuota);
        return items.slice(0, 30).map((r) => ({
          id: r.routeid,
          number: String(r.routeno),
          type: r.routetp ?? null,
          start: r.startnodenm,
          end: r.endnodenm,
        }));
      },

      async getRoute(routeId) {
        const items = await call(routeUrl, 'getRouteAcctoThrghSttnList', { cityCode, routeId }, routeQuota);
        if (!items.length) throw new ApiError('노선 정보를 찾을 수 없습니다.', { status: 404 });
        const stops = items
          .map((s) => ({
            ord: Number(s.nodeord),
            id: s.nodeid,
            name: s.nodenm,
            lat: Number(s.gpslati),
            lng: Number(s.gpslong),
          }))
          .sort((a, b) => a.ord - b.ord);
        // TAGO는 도로 경로 좌표를 주지 않아 정류장을 순서대로 이은 선을 경로로 쓴다.
        const path = stops.map((s) => [s.lat, s.lng]);
        return { id: routeId, region: `tago-${cityCode}`, number: null, path, stops, pathSource: 'stops' };
      },

      async getPositions(routeId) {
        const items = await call(locationUrl, 'getRouteAcctoBusLcList', { cityCode, routeId }, locationQuota);
        const fetchedAt = Date.now();
        return items.map((b) => ({
          id: b.vehicleno,
          plate: b.vehicleno,
          lat: Number(b.gpslati),
          lng: Number(b.gpslong),
          stopOrd: Number(b.nodeord) || null,
          lowFloor: null,
          congestion: null,
          // TAGO는 측정 시각을 주지 않으므로 받은 시각을 쓴다.
          observedAt: fetchedAt,
        }));
      },
    };
  }

  return {
    forCity,
    quotas: () => [locationQuota.snapshot(), routeQuota.snapshot()],

    async cities() {
      const items = await call(locationUrl, 'getCtyCodeList', {}, locationQuota);
      return items.map((c) => ({ code: String(c.citycode), name: c.cityname }));
    },
  };
}
