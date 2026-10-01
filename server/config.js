// 로컬에서는 .env를 읽고, Render 같은 배포 환경에서는 대시보드에 등록한 환경 변수를 사용한다.
try {
  process.loadEnvFile();
} catch {
  // .env 파일이 없으면 이미 설정된 환경 변수만 사용
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`환경 변수 ${name}이(가) 설정되지 않았습니다. .env.example을 참고하세요.`);
  return value;
}

const num = (name, fallback) => Number(process.env[name]) || fallback;

export const config = {
  port: num('PORT', 3000),
  serviceKey: required('DATA_GO_KR_SERVICE_KEY'),
  seoul: {
    positionUrl: process.env.SEOUL_BUS_POSITION_URL ?? 'http://ws.bus.go.kr/api/rest/buspos',
    routeUrl: process.env.SEOUL_BUS_ROUTE_URL ?? 'http://ws.bus.go.kr/api/rest/busRouteInfo',
    pollMs: num('SEOUL_POLL_MS', 30_000),
    dailyLimit: num('SEOUL_DAILY_LIMIT', 1_000),
  },
  tago: {
    locationUrl: process.env.TAGO_BUS_LOCATION_URL ?? 'https://apis.data.go.kr/1613000/BusLcInfoInqireService',
    routeUrl: process.env.TAGO_BUS_ROUTE_URL ?? 'https://apis.data.go.kr/1613000/BusRouteInfoInqireService',
    pollMs: num('TAGO_POLL_MS', 20_000),
    dailyLimit: num('TAGO_DAILY_LIMIT', 10_000),
  },
};
