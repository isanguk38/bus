async function getJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error('서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `요청에 실패했어요. (${res.status})`);
  return body;
}

const enc = encodeURIComponent;

export const regions = () => getJson('/api/regions');

export const searchRoutes = (region, q) => getJson(`/api/routes?${new URLSearchParams({ region, q })}`);

export const route = (region, id) => getJson(`/api/routes/${enc(region)}/${enc(id)}`);

export const nearby = (lat, lng) =>
  getJson(`/api/nearby?${new URLSearchParams({ lat: lat.toFixed(5), lng: lng.toFixed(5) })}`);

export const arrivals = (region, stopId) => getJson(`/api/stops/${enc(region)}/${enc(stopId)}/arrivals`);

export const liveUrl = (region, routeId) => `/api/live?${new URLSearchParams({ region, route: routeId })}`;
