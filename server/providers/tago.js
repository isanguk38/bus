import { TtlCache } from '../lib/cache.js';
import { distanceMeters } from '../lib/geo.js';
import { ApiError, buildUrl, fetchJson, toArray } from '../lib/http.js';
import { Quota } from '../lib/quota.js';
import { snapToRoads } from '../lib/road-snap.js';

const DAY = 24 * 3600_000;

// 정류장마다 "OO 방면" 라벨을 붙인다. 길 건너편 정류장 중 어느 쪽에서 타야 하는지 고르는 데 쓴다.
// 상행/하행(updowncd)이 나뉘어 있으면 각 방향의 마지막 정류장을 쓰고,
// 없으면 출발점에서 가장 먼 정류장을 반환점으로 보고 앞뒤를 나눈다.
export function assignDirections(stops) {
  const lastByDir = new Map();
  for (const stop of stops) lastByDir.set(stop.updown, stop.name);
  if (lastByDir.size > 1) {
    for (const stop of stops) stop.direction = `${lastByDir.get(stop.updown)} 방면`;
    return;
  }

  const first = stops[0];
  let turn = 0;
  let farthest = 0;
  stops.forEach((stop, i) => {
    const d = distanceMeters(first, stop);
    if (d > farthest) {
      farthest = d;
      turn = i;
    }
  });
  const isLoop = turn < stops.length - 1 && distanceMeters(first, stops.at(-1)) < farthest / 2;
  stops.forEach((stop, i) => {
    stop.direction = !isLoop ? null : `${i < turn ? stops[turn].name : stops.at(-1).name} 방면`;
  });
}

// 국토교통부 TAGO: 서울을 제외한 전국(경기 시·군 포함) 시내버스
export function createTagoProvider({ serviceKey, locationUrl, routeUrl, stopUrl, arrivalUrl, pollMs, dailyLimit }) {
  const locationQuota = new Quota('TAGO 버스위치정보', dailyLimit);
  const routeQuota = new Quota('TAGO 버스노선정보', dailyLimit);
  const stopQuota = new Quota('TAGO 버스정류소정보', dailyLimit);
  const arrivalQuota = new Quota('TAGO 버스도착정보', dailyLimit);
  // 정류장을 지나는 노선 목록은 거의 바뀌지 않는다.
  const throughRoutesCache = new TtlCache(DAY, 2000);
  // 노선별 → 차량별 마지막 위치와 그 위치가 처음 보인 시각
  const lastSeen = new Map();

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
    const region = `tago-${cityCode}`;
    return {
      id: region,
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
            no: s.nodeno ? String(s.nodeno) : null,
            name: s.nodenm,
            lat: Number(s.gpslati),
            lng: Number(s.gpslong),
            updown: s.updowncd ?? null,
          }))
          .sort((a, b) => a.ord - b.ord);
        assignDirections(stops);
        for (const stop of stops) delete stop.updown;
        // TAGO는 도로 경로 좌표를 주지 않아 정류장 사이를 도로 경로 탐색으로 잇는다.
        const { path, roadRatio } = await snapToRoads(stops);
        const pathSource = roadRatio >= 0.5 ? 'osm' : 'stops';
        return { id: routeId, region, number: null, type: null, path, stops, pathSource };
      },

      async getPositions(routeId) {
        const items = await call(locationUrl, 'getRouteAcctoBusLcList', { cityCode, routeId }, locationQuota);
        const fetchedAt = Date.now();
        // TAGO는 측정 시각을 주지 않고, 위치 자체도 40초 안팎마다만 바뀐다 (실측 중앙값 42초).
        // 받은 시각을 그대로 쓰면 같은 위치가 다시 왔을 때 "버스가 멈췄다"로 오해하므로,
        // 버스별로 위치가 처음 바뀐 시각을 기억해 관측 시각으로 쓴다.
        const key = `${cityCode}:${routeId}`;
        const previous = lastSeen.get(key) ?? new Map();
        const current = new Map();
        const buses = items.map((b) => {
          const position = `${b.gpslati},${b.gpslong}`;
          const seen = previous.get(b.vehicleno);
          const since = seen?.position === position ? seen.since : fetchedAt;
          current.set(b.vehicleno, { position, since });
          return {
            id: b.vehicleno,
            plate: b.vehicleno,
            lat: Number(b.gpslati),
            lng: Number(b.gpslong),
            stopOrd: Number(b.nodeord) || null,
            lowFloor: null,
            congestion: null,
            observedAt: since,
          };
        });
        lastSeen.set(key, current);
        if (lastSeen.size > 500) lastSeen.delete(lastSeen.keys().next().value);
        return buses;
      },

      async searchStops(query) {
        const items = await call(stopUrl, 'getSttnNoList', { cityCode, nodeNm: query }, stopQuota);
        return items.map((s) => ({
          region,
          id: s.nodeid,
          no: s.nodeno ? String(s.nodeno) : null,
          name: s.nodenm,
          lat: Number(s.gpslati),
          lng: Number(s.gpslong),
        }));
      },

      async stopArrivals(stopId) {
        const [arrivals, through] = await Promise.all([
          call(arrivalUrl, 'getSttnAcctoArvlPrearngeInfoList', { cityCode, nodeId: stopId }, arrivalQuota),
          throughRoutesCache.get(`${cityCode}:${stopId}`, () =>
            call(stopUrl, 'getSttnThrghRouteList', { cityCode, nodeid: stopId }, stopQuota),
          ),
        ]);

        const routes = new Map();
        for (const r of through) {
          routes.set(r.routeid, {
            routeId: r.routeid,
            number: String(r.routeno),
            type: r.routetp ?? null,
            direction: null,
            ends: r.startnodenm && r.endnodenm ? `${r.startnodenm} ↔ ${r.endnodenm}` : null,
            buses: [],
          });
        }
        for (const a of arrivals) {
          if (!routes.has(a.routeid)) {
            routes.set(a.routeid, { routeId: a.routeid, number: String(a.routeno), type: a.routetp ?? null, direction: null, ends: null, buses: [] });
          }
          const seconds = Number(a.arrtime);
          routes.get(a.routeid).buses.push({
            seconds,
            stopsAway: Number(a.arrprevstationcnt),
            lowFloor: a.vehicletp === '저상버스',
            arriving: seconds < 60,
          });
        }
        for (const route of routes.values()) {
          route.buses.sort((a, b) => a.seconds - b.seconds).splice(2);
          route.message = route.buses.length ? null : '도착 정보 없음';
        }
        return {
          stop: { region, id: stopId, no: null, name: arrivals[0]?.nodenm ?? null, lat: null, lng: null },
          routes: [...routes.values()],
        };
      },
    };
  }

  return {
    forCity,
    quotas: () => [locationQuota.snapshot(), routeQuota.snapshot(), stopQuota.snapshot(), arrivalQuota.snapshot()],

    async cities() {
      const items = await call(locationUrl, 'getCtyCodeList', {}, locationQuota);
      return items.map((c) => ({ code: String(c.citycode), name: c.cityname }));
    },

    async nearbyStops(lat, lng) {
      const items = await call(stopUrl, 'getCrdntPrxmtSttnList', { gpsLati: lat, gpsLong: lng }, stopQuota);
      return items.map((s) => ({
        region: `tago-${s.citycode}`,
        id: s.nodeid,
        no: s.nodeno ? String(s.nodeno) : null,
        name: s.nodenm,
        lat: Number(s.gpslati),
        lng: Number(s.gpslong),
      }));
    },
  };
}
