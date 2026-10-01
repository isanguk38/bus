import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approachingBuses, DEFAULT_ROUTE_SPEED, formatDistance, formatDuration, routeSpeed } from '../public/js/eta.js';

// 정류장이 500m 간격으로 있는 노선, 내 정류장은 2000m 지점
const stopDistances = [0, 500, 1000, 1500, 2000, 2500, 3000];
const stopS = 2000;

test('내 정류장보다 앞에 있는 버스만 가까운 순서로 보여준다', () => {
  const buses = [
    { id: 'far', s: 200 },
    { id: 'passed', s: 2600 },
    { id: 'near', s: 1700 },
  ];
  const list = approachingBuses({ stopS, stopDistances, buses, speed: 5 });
  assert.deepEqual(list.map((b) => b.id), ['near', 'far']);
  assert.equal(list[0].distance, 300);
  assert.equal(list[0].seconds, 60);
});

test('남은 정류장 수는 내 정류장을 포함해 센다', () => {
  // 1500m 정류장과 2000m(내 정류장) 사이 → 1정거장 전
  const [near] = approachingBuses({ stopS, stopDistances, buses: [{ id: 'a', s: 1700 }] });
  assert.equal(near.stopsAway, 1);
  // 1000m 정류장에 서 있는 버스 → 1500, 2000 두 정류장이 남음
  const [atStop] = approachingBuses({ stopS, stopDistances, buses: [{ id: 'b', s: 1000 }] });
  assert.equal(atStop.stopsAway, 2);
});

test('정류장에 거의 닿은 버스는 곧 도착으로 본다', () => {
  const [bus] = approachingBuses({ stopS, stopDistances, buses: [{ id: 'a', s: 1985 }] });
  assert.equal(bus.seconds, 0);
  assert.equal(bus.stopsAway, 0);
  const [justPassed] = approachingBuses({ stopS, stopDistances, buses: [{ id: 'b', s: 2020 }] });
  assert.equal(justPassed.seconds, 0);
});

test('노선 평균 속도는 움직이는 버스들의 중앙값', () => {
  assert.equal(routeSpeed([0, 0, 5, 6, 7]), 6);
  assert.equal(routeSpeed([5]), DEFAULT_ROUTE_SPEED, '표본이 적으면 기본값');
  assert.equal(routeSpeed([20, 20, 20]), 8, '비현실적으로 빠르면 제한');
});

test('시간과 거리를 읽기 쉽게 표시한다', () => {
  assert.equal(formatDuration(30), '곧 도착');
  assert.equal(formatDuration(150), '2분');
  assert.equal(formatDuration(3900), '1시간 5분');
  assert.equal(formatDistance(123), '120m');
  assert.equal(formatDistance(1530), '1.5km');
});
