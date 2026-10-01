const EARTH_RADIUS = 6_371_008.8;

// 두 지점 사이의 거리(m), 하버사인 공식
export function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}

// 서울시 API로 조회할 범위 (서울 경계를 조금 넉넉하게 감싼 사각형)
export function nearSeoul({ lat, lng }) {
  return lat > 37.41 && lat < 37.72 && lng > 126.76 && lng < 127.19;
}
