// 사용자는 "10번", "10 번 버스"처럼 입력하지만 공공 API는 노선 번호만 넣어야 결과를 준다.
export function normalizeRouteQuery(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/(번버스|번|버스)$/, '');
}
