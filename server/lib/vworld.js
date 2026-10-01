import { buildUrl, fetchJson } from './http.js';

// 브이월드(국토교통부 공간정보 오픈플랫폼): 무료 배경지도 + 장소·주소 검색.
// VWORLD_API_KEY가 있을 때만 쓰고, 없으면 OpenStreetMap 지도와 정류장 이름 검색만 제공한다.
const SEARCH_URL = 'https://api.vworld.kr/req/search';

export function createVworld({ apiKey, domain }) {
  if (!apiKey) return null;

  async function search(query, type, extra = {}) {
    const json = await fetchJson(
      buildUrl(SEARCH_URL, '', {
        service: 'search',
        request: 'search',
        version: '2.0',
        crs: 'EPSG:4326',
        size: 8,
        page: 1,
        query,
        type,
        format: 'json',
        errorformat: 'json',
        key: apiKey,
        ...(domain ? { domain } : {}),
        ...extra,
      }),
    );
    const { status, result, error } = json.response ?? {};
    if (status === 'NOT_FOUND') return [];
    if (status !== 'OK') throw new Error(`브이월드 검색: ${error?.text ?? status ?? '알 수 없는 오류'}`);
    return (result?.items ?? []).map((item) => ({
      name: item.title ?? item.address?.road ?? item.address?.parcel,
      address: item.address?.road || item.address?.parcel || null,
      category: item.category ?? null,
      lat: Number(item.point.y),
      lng: Number(item.point.x),
    }));
  }

  return {
    name: 'vworld',

    // 브라우저가 직접 불러오는 배경지도 타일. 키는 브이월드에 등록한 도메인에서만 동작한다.
    tiles: {
      light: `https://api.vworld.kr/req/wmts/1.0.0/${apiKey}/Base/{z}/{y}/{x}.png`,
      dark: `https://api.vworld.kr/req/wmts/1.0.0/${apiKey}/midnight/{z}/{y}/{x}.png`,
      attribution: '&copy; <a href="https://www.vworld.kr">브이월드</a>(국토교통부)',
      minZoom: 6,
      maxZoom: 19,
    },

    // 장소 이름으로 먼저 찾고, 없으면 도로명 주소로 찾는다.
    async searchPlaces(query) {
      const places = await search(query, 'place');
      return places.length ? places : search(query, 'address', { category: 'road' });
    },
  };
}
