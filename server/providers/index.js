import { distanceMeters, nearSeoul } from '../lib/geo.js';
import { ApiError } from '../lib/http.js';
import { createSeoulProvider } from './seoul.js';
import { createTagoProvider } from './tago.js';

const NEARBY_LIMIT = 15;

// 지역 ID → 데이터 소스. 각 소스는 같은 형태(searchRoutes / getRoute / getPositions / stopArrivals)로 응답한다.
//   "seoul"       서울시 버스 API
//   "tago-31010"  TAGO 도시코드 31010(수원시)
export function createRegistry(config) {
  const seoul = createSeoulProvider({ serviceKey: config.serviceKey, ...config.seoul });
  const tago = createTagoProvider({ serviceKey: config.serviceKey, ...config.tago });

  return {
    resolve(regionId) {
      if (regionId === 'seoul') return seoul;
      const match = /^tago-(\d{1,6})$/.exec(regionId ?? '');
      if (match) return tago.forCity(match[1]);
      throw new ApiError('지원하지 않는 지역입니다.', { status: 400 });
    },

    async regions() {
      const cities = await tago.cities();
      return [
        { id: 'seoul', name: '서울특별시', group: '특별·광역시' },
        ...cities.map((c) => ({
          id: `tago-${c.code}`,
          name: c.name,
          group: c.code.length <= 2 ? '특별·광역시' : '시·군',
        })),
      ];
    },

    // 서울 근처면 서울 API와 TAGO를 함께 조회한다 (서울·경기 경계에서는 양쪽 정류장이 다 가깝다).
    // 한쪽이 실패해도 다른 쪽 결과만으로 보여준다.
    async nearbyStops(lat, lng) {
      const tasks = [tago.nearbyStops(lat, lng)];
      if (nearSeoul({ lat, lng })) tasks.push(seoul.nearbyStops(lat, lng));
      const results = await Promise.allSettled(tasks);
      if (results.every((r) => r.status === 'rejected')) throw results[0].reason;

      const here = { lat, lng };
      return results
        .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
        .map((stop) => ({ ...stop, distance: Math.round(distanceMeters(here, stop)) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, NEARBY_LIMIT);
    },

    quotas: () => [...seoul.quotas(), ...tago.quotas()],
  };
}
