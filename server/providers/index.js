import { ApiError } from '../lib/http.js';
import { createSeoulProvider } from './seoul.js';
import { createTagoProvider } from './tago.js';

// 지역 ID → 데이터 소스. 각 소스는 같은 형태(searchRoutes / getRoute / getPositions)로 응답한다.
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

    quotas: () => [...seoul.quotas(), ...tago.quotas()],
  };
}
