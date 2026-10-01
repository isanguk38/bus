import { ApiError } from './http.js';

// 카카오 로컬 API 키워드 검색: 상가·건물·가게 이름으로 장소를 찾는다 (무료, 하루 10만 건).
// KAKAO_REST_API_KEY가 있을 때만 쓴다.
const KEYWORD_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json';

export function createKakaoPlaces({ restApiKey }) {
  if (!restApiKey) return null;

  return {
    name: 'kakao',

    // near를 주면 그 근처 결과를 우선한다 (20km 안, 가까운 순).
    async searchPlaces(query, near = null) {
      const url = new URL(KEYWORD_URL);
      url.searchParams.set('query', query);
      url.searchParams.set('size', '10');
      if (near) {
        url.searchParams.set('x', String(near.lng));
        url.searchParams.set('y', String(near.lat));
        url.searchParams.set('radius', '20000');
        url.searchParams.set('sort', 'distance');
      }

      let res;
      try {
        res = await fetch(url, {
          headers: { Authorization: `KakaoAK ${restApiKey}` },
          signal: AbortSignal.timeout(8000),
        });
      } catch (err) {
        throw new ApiError(`카카오 장소 검색 요청 실패: ${err.message}`);
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(`카카오 장소 검색: ${json.message ?? `HTTP ${res.status}`}`);

      return (json.documents ?? []).map((d) => ({
        name: d.place_name,
        address: d.road_address_name || d.address_name || null,
        category: d.category_group_name || d.category_name?.split(' > ').at(-1) || null,
        lat: Number(d.y),
        lng: Number(d.x),
      }));
    },
  };
}
