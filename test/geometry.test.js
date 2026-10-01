import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolyline, locateStops, pointAt, project } from '../public/js/geometry.js';

// 서울 근처에서 동쪽으로 약 1km 간 뒤 북쪽으로 약 1km 가는 ㄱ자 경로
const EAST = 0.01131; // 위도 37.5에서 경도 0.01131도 ≈ 1000m
const NORTH = 0.008993; // 위도 0.008993도 ≈ 1000m
const L_SHAPE = [
  [37.5, 127.0],
  [37.5, 127.0 + EAST],
  [37.5 + NORTH, 127.0 + EAST],
];

test('경로 길이를 미터 단위로 계산한다', () => {
  const line = createPolyline(L_SHAPE);
  assert.ok(Math.abs(line.length - 2000) < 10, `length=${line.length}`);
});

test('중복된 연속 좌표는 제거한다', () => {
  const line = createPolyline([L_SHAPE[0], L_SHAPE[0], L_SHAPE[1]]);
  assert.equal(line.latlngs.length, 2);
});

test('pointAt은 거리에 맞는 좌표와 진행 방향을 준다', () => {
  const line = createPolyline(L_SHAPE);
  const onFirstLeg = pointAt(line, 500);
  assert.ok(Math.abs(onFirstLeg.lng - (127.0 + EAST / 2)) < 1e-4);
  assert.ok(Math.abs(onFirstLeg.bearing - 90) < 1, '동쪽(90도)으로 진행');

  const onSecondLeg = pointAt(line, 1500);
  assert.ok(Math.abs(onSecondLeg.lat - (37.5 + NORTH / 2)) < 1e-4);
  assert.ok(onSecondLeg.bearing < 1 || onSecondLeg.bearing > 359, '북쪽(0도)으로 진행');
});

test('pointAt은 범위를 벗어난 거리를 양 끝으로 고정한다', () => {
  const line = createPolyline(L_SHAPE);
  assert.deepEqual([pointAt(line, -10).lat, pointAt(line, -10).lng], L_SHAPE[0]);
  const end = pointAt(line, 99999);
  assert.ok(Math.abs(end.lat - L_SHAPE[2][0]) < 1e-9);
});

test('project는 경로에서 가장 가까운 지점의 거리를 찾는다', () => {
  const line = createPolyline(L_SHAPE);
  // 첫 구간 중간에서 남쪽으로 약 50m 떨어진 GPS
  const hit = project(line, 37.5 - 0.00045, 127.0 + EAST / 2);
  assert.ok(Math.abs(hit.s - 500) < 5, `s=${hit.s}`);
  assert.ok(Math.abs(hit.distance - 50) < 5, `distance=${hit.distance}`);
});

test('왕복 노선에서는 구간 제한으로 올바른 방향에 붙는다', () => {
  // 같은 도로를 갔다가 돌아오는 경로: 0~1000m 가는 길, 1000~2000m 오는 길
  const line = createPolyline([[37.5, 127.0], [37.5, 127.0 + EAST], [37.5, 127.0]]);
  const lat = 37.5;
  const lng = 127.0 + EAST * 0.3;
  assert.ok(Math.abs(project(line, lat, lng, 1000, 2000).s - 1700) < 5, '오는 길로 제한하면 1700m');
  assert.ok(Math.abs(project(line, lat, lng, 0, 1000).s - 300) < 5, '가는 길로 제한하면 300m');
});

test('정류장 위치는 순서대로 증가한다', () => {
  const line = createPolyline([[37.5, 127.0], [37.5, 127.0 + EAST], [37.5, 127.0]]);
  const stops = [
    { lat: 37.5, lng: 127.0 },
    { lat: 37.5, lng: 127.0 + EAST * 0.5 },
    { lat: 37.5, lng: 127.0 + EAST },
    { lat: 37.5, lng: 127.0 + EAST * 0.5 }, // 돌아오는 길의 같은 위치
  ];
  const s = locateStops(line, stops);
  assert.ok(Math.abs(s[1] - 500) < 5);
  assert.ok(Math.abs(s[3] - 1500) < 5, `돌아오는 길 정류장 s=${s[3]}`);
});
