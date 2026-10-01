import * as api from './api.js';
import { approachingBuses, formatDistance, formatDuration, routeSpeed, walkingMinutes } from './eta.js';
import { createPolyline, locateStops, pointAt, project, slicePath } from './geometry.js';
import { BusTrack, DEFAULT_SPEED } from './tracker.js';

const KOREA_CENTER = [36.4, 127.8];
const OFF_ROUTE_METERS = 500; // 경로에서 이보다 멀리 떨어진 GPS는 잘못된 값으로 보고 표시하지 않는다
const WINDOW_MARGIN = 300;
const HIDDEN_DISCONNECT_MS = 60_000; // 탭이 이만큼 가려져 있으면 연결을 끊어 API 호출을 아낀다
const ARRIVALS_REFRESH_MS = 30_000;
const MY_STOP_RANGE = 1500; // 내 위치에서 이 거리 안의 정류장만 "내 정류장" 후보로 본다
const SOON_SECONDS = 180;

// server/lib/query.js와 같은 규칙: "10번 버스" → "10"
const normalizeRouteQuery = (value) => value.replace(/\s+/g, '').replace(/(번버스|번|버스)$/, '');

const $ = (id) => document.getElementById(id);
const ui = {
  panel: $('panel'),
  back: $('back'),
  title: $('panel-title'),
  collapse: $('collapse'),
  tabs: $('tabs'),
  // 내 주변
  locateBtn: $('locate-btn'),
  centerBtn: $('center-btn'),
  nearbyMessage: $('nearby-message'),
  nearbyList: $('nearby-list'),
  placeForm: $('place-form'),
  placeRegion: $('place-region'),
  placeQuery: $('place-query'),
  placeMessage: $('place-message'),
  placeResults: $('place-results'),
  boardForm: $('board-form'),
  boardQuery: $('board-query'),
  boardMessage: $('board-message'),
  boardResults: $('board-results'),
  // 검색
  form: $('search-form'),
  region: $('region'),
  query: $('query'),
  searchMessage: $('search-message'),
  results: $('results'),
  // 정류장
  stopName: $('stop-name'),
  stopSub: $('stop-sub'),
  stopUpdated: $('stop-updated'),
  stopRefresh: $('stop-refresh'),
  stopMessage: $('stop-message'),
  arrivalList: $('arrival-list'),
  // 노선
  number: $('route-number'),
  type: $('route-type'),
  ends: $('route-ends'),
  legend: $('route-legend'),
  mystop: $('mystop'),
  mystopName: $('mystop-name'),
  mystopHint: $('mystop-hint'),
  dirChips: $('dir-chips'),
  approachList: $('approach-list'),
  busCount: $('bus-count'),
  lastUpdate: $('last-update'),
  progress: $('progress-bar'),
  liveMessage: $('live-message'),
  liveDot: $('live-dot'),
  pathNote: $('path-note'),
  showRaw: $('show-raw'),
  showAllBuses: $('show-all-buses'),
};

const VIEWS = ['nearby', 'search', 'stop', 'route'];
const VIEW_TITLES = { stop: '정류장 도착 정보', route: '실시간 버스 위치' };

const state = {
  view: 'nearby',
  stack: [],
  me: null, // { lat, lng, accuracy }
  nearby: [],
  // 정류장 화면
  stop: null,
  arrivals: null,
  arrivalsBaseAt: 0,
  arrivalsTimer: null,
  // 노선 화면
  routeToken: 0,
  route: null,
  line: null,
  stops: [], // 노선 정류장 + 경로 위 거리 s
  stopSByOrd: new Map(),
  stopsByOrd: new Map(),
  stopSorted: [],
  segments: [], // 방향별 경로 구간 [{ direction, from, to }]
  colorOf: new Map(), // 방향 → 색
  segmentLines: [],
  stopMarkers: [],
  myStop: null,
  focusPending: false,
  tracks: new Map(), // 버스 ID → { id, track, marker, arrow, root }
  source: null,
  hiddenTimer: null,
  receivedAt: 0,
  pollMs: 0,
};

// ── 공통 도구 ──
const escapeHtml = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function setMessage(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function routeTypeClass(type) {
  if (!type) return '';
  if (/간선/.test(type)) return 't-trunk';
  if (/광역|직행|좌석|급행|공항/.test(type)) return 't-express';
  if (/순환/.test(type)) return 't-circular';
  if (/지선|마을|일반/.test(type)) return 't-branch';
  return '';
}

function routeBadge(number, type) {
  return `<span class="route-badge ${routeTypeClass(type)}">${escapeHtml(number)}</span>`;
}

function updateUrl(params, title) {
  const entries = Object.entries(params ?? {}).filter(([, v]) => v != null && v !== '');
  history.replaceState(null, '', entries.length ? `?${new URLSearchParams(entries)}` : location.pathname);
  document.title = title ? `${title} · 버스 지금 어디` : '버스 지금 어디';
}

// ── 지도 ──
// 서버에 브이월드 키가 설정되어 있으면 브이월드 지도를, 아니면 OpenStreetMap을 쓴다.
const appConfig = await api.config().catch(() => ({ tiles: null, placeSearch: false }));
const darkMode = matchMedia('(prefers-color-scheme: dark)').matches;
const map = L.map('map', { zoomControl: false }).setView(KOREA_CENTER, 7);
L.control.zoom({ position: 'topright' }).addTo(map);
const DATA_CREDIT = '버스 데이터: 공공데이터포털';
if (appConfig.tiles) {
  const { light, dark, attribution, minZoom, maxZoom } = appConfig.tiles;
  document.documentElement.classList.add('native-dark-tiles');
  L.tileLayer(darkMode ? dark : light, { minZoom, maxZoom, attribution: `${attribution} · ${DATA_CREDIT}` }).addTo(map);
} else {
  // OpenStreetMap 기본 타일은 키 없이 무료로 쓸 수 있다. 다크 모드는 CSS 필터로 어둡게 바꾼다.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: `&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · ${DATA_CREDIT}`,
  }).addTo(map);
}

// 장소 검색(카카오·브이월드)이 켜져 있으면 상가·건물 이름으로도 찾을 수 있다고 안내한다.
if (appConfig.placeSearch) {
  ui.placeQuery.placeholder = '정류장·상가·건물 이름 (예: 범계역 스타벅스)';
  ui.boardQuery.placeholder = '탈 곳 검색 (정류장·상가·건물 이름)';
}

const LocateControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const box = L.DomUtil.create('div', 'leaflet-bar locate-control');
    const link = L.DomUtil.create('a', '', box);
    link.href = '#';
    link.role = 'button';
    link.title = '내 위치';
    link.setAttribute('aria-label', '내 위치로 이동');
    link.textContent = '◎';
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.on(link, 'click', (e) => {
      L.DomEvent.preventDefault(e);
      useMyLocation({ fromMapButton: true });
    });
    return box;
  },
});
new LocateControl().addTo(map);

const meLayer = L.layerGroup().addTo(map);
const nearbyLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const myStopLayer = L.layerGroup().addTo(map);
const busLayer = L.layerGroup().addTo(map);
const rawLayer = L.layerGroup();

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// 패널이 가리는 영역(데스크톱은 왼쪽, 모바일은 아래쪽)을 피해서 보이게 맞춘다.
function fitTo(points, maxZoom = 17) {
  const bounds = L.latLngBounds(points);
  if (!bounds.isValid()) return;
  const mobile = matchMedia('(max-width: 640px)').matches;
  const collapsed = ui.panel.classList.contains('collapsed');
  const panelW = mobile || collapsed ? 0 : ui.panel.offsetWidth + 16;
  const panelH = mobile && !collapsed ? ui.panel.offsetHeight : 0;
  map.fitBounds(bounds, {
    paddingTopLeft: [panelW + 32, 40],
    paddingBottomRight: [56, panelH + 40],
    maxZoom,
  });
}

// ── 화면 전환 ──
function show(view, { push = true } = {}) {
  if (state.view === view) return;
  if (push) state.stack.push(state.view);
  if (state.view === 'stop') stopArrivalsPolling();
  if (state.view === 'route') closeRoute();
  state.view = view;

  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  const isRoot = view === 'nearby' || view === 'search';
  ui.tabs.hidden = !isRoot;
  ui.back.hidden = isRoot;
  ui.title.innerHTML = isRoot ? '<span aria-hidden="true">🚌</span> 버스 지금 어디' : VIEW_TITLES[view];
  for (const tab of ui.tabs.querySelectorAll('[role="tab"]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }
  if (view === 'route') nearbyLayer.remove();
  else nearbyLayer.addTo(map);
  if (isRoot) updateUrl(null);
  ui.panel.querySelector('.panel-body').scrollTop = 0;
  expandPanel();
}

function back() {
  const previous = state.stack.pop() ?? 'nearby';
  show(previous, { push: false });
  if (previous === 'stop' && state.stop) {
    updateStopUrl();
    startArrivalsPolling();
    if (state.stop.lat != null) fitTo(stopFocusPoints(state.stop));
  }
}

function expandPanel() {
  ui.panel.classList.remove('collapsed');
  ui.collapse.textContent = '접기';
  ui.collapse.setAttribute('aria-expanded', 'true');
}

// ── 내 위치 ──
function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('이 브라우저는 위치 기능을 지원하지 않아요. 지도를 옮긴 뒤 "지도 중심에서 찾기"를 눌러주세요.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? '위치 권한이 꺼져 있어요. 브라우저 주소창의 자물쇠 아이콘에서 위치를 허용하거나, 지도를 옮긴 뒤 "지도 중심에서 찾기"를 눌러주세요.'
              : '현재 위치를 확인하지 못했어요. 잠시 후 다시 시도하거나 "지도 중심에서 찾기"를 이용해 주세요.',
          ),
        ),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });
}

// 기준 위치: GPS로 얻은 내 위치, 또는 검색으로 고른 장소({ label }이 있음)
function setMe(me) {
  state.me = me;
  meLayer.clearLayers();
  if (me.label) {
    L.marker([me.lat, me.lng], {
      icon: L.divIcon({
        className: 'map-icon',
        html: `<div class="origin-pin"><span>${escapeHtml(me.label)}</span></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
      keyboard: false,
      interactive: false,
      zIndexOffset: 500,
    }).addTo(meLayer);
    return;
  }
  if (me.accuracy && me.accuracy < 500) {
    L.circle([me.lat, me.lng], { radius: me.accuracy, color: css('--me'), weight: 1, fillOpacity: 0.08, interactive: false }).addTo(meLayer);
  }
  L.marker([me.lat, me.lng], {
    icon: L.divIcon({ className: 'map-icon', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    keyboard: false,
    interactive: false,
    zIndexOffset: 500,
  }).addTo(meLayer);
}

async function useMyLocation({ fromMapButton = false } = {}) {
  const inNearby = state.view === 'nearby';
  if (inNearby) {
    ui.locateBtn.disabled = true;
    setMessage(ui.nearbyMessage, '내 위치를 확인하는 중…');
  }
  let me;
  try {
    me = await locate();
  } catch (err) {
    if (inNearby || !fromMapButton) setMessage(ui.nearbyMessage, err.message, true);
    else alert(err.message);
    return;
  } finally {
    ui.locateBtn.disabled = false;
  }
  setMe(me);

  if (state.view === 'route') {
    if (!state.myStop) {
      const [nearest] = myStopCandidates();
      if (nearest) setMyStop(nearest);
    } else {
      renderDirectionChips();
    }
    map.panTo([me.lat, me.lng]);
  } else if (state.view === 'nearby' || !fromMapButton) {
    if (state.view !== 'nearby') {
      state.stack = [];
      show('nearby', { push: false });
    }
    await findNearby(me.lat, me.lng, '내 위치');
  } else {
    map.setView([me.lat, me.lng], Math.max(map.getZoom(), 16));
    if (state.view === 'search') detectRegion(me.lat, me.lng);
  }
}

// 위치로 지역을 알아내 노선 검색의 지역 선택을 미리 맞춰둔다.
async function detectRegion(lat, lng) {
  try {
    const [nearest] = await api.nearby(lat, lng);
    if (nearest) setRegion(nearest.region);
  } catch {
    // 지역 자동 선택은 편의 기능이라 실패해도 무시
  }
}

// 노선 검색과 정류장·장소 검색의 지역 선택은 항상 같은 값을 유지한다.
function setRegion(regionId) {
  if (![...ui.region.options].some((o) => o.value === regionId)) return;
  ui.region.value = regionId;
  ui.placeRegion.value = regionId;
}

// ── 지역 목록 ──
async function loadRegions() {
  try {
    const regions = await api.regions();
    const groups = new Map();
    for (const r of regions) {
      if (!groups.has(r.group)) groups.set(r.group, []);
      groups.get(r.group).push(r);
    }
    const options = () =>
      [...groups].map(([label, items]) => {
        const group = document.createElement('optgroup');
        group.label = label;
        group.append(...items.map((r) => new Option(r.name, r.id)));
        return group;
      });
    ui.region.replaceChildren(...options());
    ui.placeRegion.replaceChildren(...options());
  } catch (err) {
    // 전국 목록을 못 받아도 서울은 쓸 수 있다.
    setMessage(ui.searchMessage, `전국 지역 목록을 불러오지 못했습니다. (${err.message})`, true);
  }
}

// ── 내 주변 정류장 ──
async function findNearby(lat, lng, label) {
  ui.locateBtn.disabled = ui.centerBtn.disabled = true;
  setMessage(ui.nearbyMessage, '주변 정류장을 찾는 중…');
  try {
    const stops = await api.nearby(lat, lng);
    state.nearby = stops;
    renderNearby();
    drawNearbyPins();
    if (!stops.length) {
      setMessage(ui.nearbyMessage, '500m 안에 정류장이 없어요. 지도를 옮긴 뒤 "지도 중심에서 찾기"를 눌러보세요.');
      return;
    }
    setMessage(ui.nearbyMessage, `${label}에서 가까운 정류장이에요. 정류장을 누르면 도착 정보를 보여드려요.`);
    setRegion(stops[0].region);
    fitTo([[lat, lng], ...stops.slice(0, 6).map((s) => [s.lat, s.lng])], 17);
  } catch (err) {
    setMessage(ui.nearbyMessage, err.message, true);
  } finally {
    ui.locateBtn.disabled = ui.centerBtn.disabled = false;
  }
}

function stopMeta(stop) {
  const parts = [];
  if (stop.no) parts.push(`정류장 번호 ${stop.no}`);
  if (stop.distance != null) parts.push(`${formatDistance(stop.distance)} · 도보 ${walkingMinutes(stop.distance)}분`);
  return parts.join(' · ');
}

function renderNearby() {
  ui.nearbyList.replaceChildren(
    ...state.nearby.map((stop, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<button type="button" class="item">
        <span class="pin-num">${i + 1}</span>
        <span class="body"><span class="title">${escapeHtml(stop.name)}</span><span class="meta">${escapeHtml(stopMeta(stop))}</span></span>
        <span class="chev" aria-hidden="true">›</span>
      </button>`;
      li.querySelector('button').addEventListener('click', () => openStop(stop));
      return li;
    }),
  );
}

function drawNearbyPins() {
  nearbyLayer.clearLayers();
  const stops = [...state.nearby];
  if (state.stop?.lat != null && !stops.some((s) => s.id === state.stop.id)) stops.push(state.stop);
  stops.forEach((stop, i) => {
    const selected = state.stop?.id === stop.id && state.view === 'stop';
    const label = i < state.nearby.length ? i + 1 : '';
    L.marker([stop.lat, stop.lng], {
      icon: L.divIcon({
        className: 'map-icon',
        html: `<div class="stop-pin${selected ? ' selected' : ''}"><span>${label}</span></div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 30],
      }),
      title: stop.name,
      zIndexOffset: selected ? 400 : 0,
    })
      .on('click', () => openStop(stop))
      .addTo(nearbyLayer);
  });
}

// ── 정류장·장소 검색 ──
// 결과 목록을 "정류장" / "장소" 묶음으로 그린다. onRouteStop이 있으면 지금 노선의 정류장을 맨 위에 따로 보여준다.
function renderSearchResults(listEl, { stops, places }, { onStop, onPlace, routeStopIds = null }) {
  const items = [];
  const label = (text) => {
    const li = document.createElement('li');
    li.className = 'group-label';
    li.textContent = text;
    items.push(li);
  };
  const button = (icon, title, meta, onClick) => {
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" class="item">
      <span class="icon" aria-hidden="true">${icon}</span>
      <span class="body"><span class="title">${escapeHtml(title)}</span>${meta ? `<span class="meta">${escapeHtml(meta)}</span>` : ''}</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>`;
    li.querySelector('button').addEventListener('click', onClick);
    items.push(li);
  };
  const stopLine = (stop) => [stop.no && `정류장 번호 ${stop.no}`, stop.distance != null && formatDistance(stop.distance)].filter(Boolean).join(' · ');

  const onRoute = routeStopIds ? stops.filter((s) => routeStopIds.has(s.id)) : [];
  const others = routeStopIds ? stops.filter((s) => !routeStopIds.has(s.id)) : stops;
  if (onRoute.length) {
    label('이 노선이 서는 정류장');
    for (const stop of onRoute) button('🚏', stop.name, stopLine(stop), () => onStop(stop));
  }
  if (others.length) {
    label(routeStopIds ? '다른 정류장 (가까운 노선 정류장을 찾아드려요)' : '정류장');
    for (const stop of others) button('🚏', stop.name, stopLine(stop), () => onStop(stop));
  }
  if (places.length) {
    label('장소');
    for (const place of places) button('📍', place.name, place.address, () => onPlace(place));
  }
  listEl.replaceChildren(...items);
}

function noResultMessage() {
  return appConfig.placeSearch
    ? '검색 결과가 없어요. 지역을 확인하거나 다른 이름으로 검색해 보세요.'
    : '정류장 이름으로 찾지 못했어요. 지역을 확인하거나 정류장 이름 일부로 검색해 보세요. (예: 범계역, 시청)';
}

async function runSearch({ form, input, message, list, region, near, render }) {
  const query = input.value.trim();
  if (query.length < 2) return;
  input.blur();
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  list.replaceChildren();
  setMessage(message, '찾는 중… (지역에 따라 몇 초 걸릴 수 있어요)');
  try {
    const result = await api.search(region, query, near);
    if (!result.stops.length && !result.places.length) {
      setMessage(message, noResultMessage());
      return;
    }
    setMessage(message, '');
    render(result);
  } catch (err) {
    setMessage(message, err.message, true);
  } finally {
    submit.disabled = false;
  }
}

// 내 주변 탭: 정류장을 고르면 바로 도착 정보, 장소를 고르면 그 주변 정류장
function searchPlaces(event) {
  event.preventDefault();
  runSearch({
    form: ui.placeForm,
    input: ui.placeQuery,
    message: ui.placeMessage,
    list: ui.placeResults,
    region: ui.placeRegion.value,
    near: state.me,
    render: (result) =>
      renderSearchResults(ui.placeResults, result, {
        onStop: (stop) => openStop(stop),
        onPlace: (place) => {
          ui.placeResults.replaceChildren();
          setMe({ lat: place.lat, lng: place.lng, label: place.name });
          findNearby(place.lat, place.lng, `'${place.name}'`);
        },
      }),
  });
}

// 노선 화면: 검색한 곳에서 탈 정류장을 정한다
function searchBoarding(event) {
  event.preventDefault();
  const routeStopIds = new Set(state.stops.map((s) => s.id));
  runSearch({
    form: ui.boardForm,
    input: ui.boardQuery,
    message: ui.boardMessage,
    list: ui.boardResults,
    region: state.route.regionId,
    near: state.myStop ?? state.me,
    render: (result) =>
      renderSearchResults(ui.boardResults, result, {
        routeStopIds,
        onStop: (stop) => {
          const onRoute = state.stops.find((s) => s.id === stop.id);
          if (onRoute) {
            setMe({ lat: onRoute.lat, lng: onRoute.lng, label: onRoute.name });
            finishBoarding(onRoute);
          } else {
            boardNear({ lat: stop.lat, lng: stop.lng, label: stop.name });
          }
        },
        onPlace: (place) => boardNear({ lat: place.lat, lng: place.lng, label: place.name }),
      }),
  });
}

// 검색한 곳에서 가장 가까운 이 노선의 정류장을 고른다 (방향별 후보는 칩으로 바꿀 수 있음)
function boardNear(origin) {
  setMe(origin);
  const [nearest] = myStopCandidates();
  if (nearest) {
    finishBoarding(nearest);
    return;
  }
  // 1.5km 안에 이 노선 정류장이 없으면 가장 가까운 곳을 알려준다.
  const here = L.latLng(origin.lat, origin.lng);
  const closest = state.stops
    .map((s) => ({ ...s, distance: here.distanceTo([s.lat, s.lng]) }))
    .sort((a, b) => a.distance - b.distance)[0];
  ui.boardResults.replaceChildren();
  setMessage(
    ui.boardMessage,
    `'${origin.label}' 근처로는 이 노선이 지나지 않아요. 가장 가까운 정류장은 ${closest.name} (${formatDistance(closest.distance)})이에요.`,
    true,
  );
  fitTo([[origin.lat, origin.lng], [closest.lat, closest.lng]], 16);
}

function finishBoarding(stop) {
  ui.boardResults.replaceChildren();
  ui.boardQuery.value = '';
  setMessage(ui.boardMessage, '');
  setMyStop(stop, { focus: true });
}

// ── 정류장 도착 정보 ──
function stopFocusPoints(stop) {
  const points = [[stop.lat, stop.lng]];
  if (state.me) points.push([state.me.lat, state.me.lng]);
  return points;
}

function updateStopUrl() {
  const { stop } = state;
  updateUrl({ region: stop.region, stop: stop.id, name: stop.name }, stop.name);
}

function openStop(stop, { push = true } = {}) {
  if (state.view === 'stop') stopArrivalsPolling();
  state.stop = stop;
  state.arrivals = null;
  show('stop', { push });
  ui.stopName.textContent = stop.name ?? '정류장';
  ui.stopSub.textContent = stopMeta(stop);
  ui.stopUpdated.textContent = '';
  ui.arrivalList.replaceChildren();
  setMessage(ui.stopMessage, '도착 정보를 불러오는 중…');
  drawNearbyPins();
  if (stop.lat != null) fitTo(stopFocusPoints(stop));
  updateStopUrl();
  startArrivalsPolling();
}

function startArrivalsPolling() {
  stopArrivalsPolling();
  loadArrivals();
  state.arrivalsTimer = setInterval(loadArrivals, ARRIVALS_REFRESH_MS);
}

function stopArrivalsPolling() {
  clearInterval(state.arrivalsTimer);
  state.arrivalsTimer = null;
}

async function loadArrivals() {
  const stop = state.stop;
  if (!stop) return;
  try {
    const data = await api.arrivals(stop.region, stop.id);
    if (state.stop !== stop) return;
    // 위치 목록을 거치지 않고 링크로 들어온 경우 정류장 이름·좌표를 채운다.
    if (!stop.name && data.stop.name) {
      stop.name = data.stop.name;
      ui.stopName.textContent = stop.name;
      updateStopUrl();
    }
    if (stop.lat == null && data.stop.lat != null) {
      Object.assign(stop, { lat: data.stop.lat, lng: data.stop.lng });
      drawNearbyPins();
      fitTo(stopFocusPoints(stop));
    }
    state.arrivals = data;
    state.arrivalsBaseAt = Date.now() - data.ageMs;
    renderArrivals();
    setMessage(ui.stopMessage, data.routes.length ? '' : '이 정류장을 지나는 노선 정보가 없어요.');
  } catch (err) {
    if (state.stop === stop) setMessage(ui.stopMessage, err.message, true);
  }
}

function secondsLeft(seconds) {
  return Math.max(0, seconds - (Date.now() - state.arrivalsBaseAt) / 1000);
}

function arrivalTimeHtml(bus) {
  const left = secondsLeft(bus.seconds);
  const soon = bus.arriving || left < SOON_SECONDS;
  return `<span class="arr-time${soon ? ' soon' : ''}" data-sec="${bus.seconds}" data-arriving="${bus.arriving}">${
    bus.arriving ? '곧 도착' : formatDuration(left)
  }</span>`;
}

const stopsAwayText = (bus) => (bus.stopsAway > 0 ? `${bus.stopsAway}정거장 전` : '');

function renderArrivals() {
  const { routes } = state.arrivals;
  ui.arrivalList.replaceChildren(
    ...routes.map((route) => {
      const [first, second] = route.buses;
      const main = first
        ? `${arrivalTimeHtml(first)}<span class="arr-stops">${stopsAwayText(first)}</span>${first.lowFloor ? '<span class="tag">저상</span>' : ''}`
        : `<span class="arr-time none">${escapeHtml(route.message)}</span>`;
      const next = second
        ? `<span class="arr-next">다음 버스 ${arrivalTimeHtml(second)} ${stopsAwayText(second)}</span>`
        : '';
      const where = route.direction ?? route.ends;
      const li = document.createElement('li');
      li.innerHTML = `<button type="button" class="item">
        ${routeBadge(route.number, route.type)}
        <span class="body">
          <span class="arr-main">${main}</span>
          ${next}
          ${where ? `<span class="arr-dir">${escapeHtml(where)}</span>` : ''}
        </span>
        <span class="chev" aria-hidden="true">›</span>
      </button>`;
      li.querySelector('button').addEventListener('click', () =>
        openRoute(
          { regionId: state.stop.region, id: route.routeId, number: route.number, type: route.type },
          { stopId: state.stop.id },
        ),
      );
      return li;
    }),
  );
  // 다음 버스 줄의 시간은 작게 보이도록 크기만 줄인다.
  for (const el of ui.arrivalList.querySelectorAll('.arr-next .arr-time')) el.style.fontSize = '12px';
}

function tickArrivals() {
  if (state.view !== 'stop' || !state.arrivals) return;
  for (const el of ui.arrivalList.querySelectorAll('[data-sec]')) {
    if (el.dataset.arriving === 'true') continue;
    const left = secondsLeft(Number(el.dataset.sec));
    el.textContent = formatDuration(left);
    el.classList.toggle('soon', left < SOON_SECONDS);
  }
  const age = Math.floor((Date.now() - state.arrivalsBaseAt) / 1000);
  ui.stopUpdated.textContent = `${age}초 전 정보 · 30초마다 자동 갱신`;
}

// ── 노선 검색 ──
async function search(event) {
  event.preventDefault();
  const query = ui.query.value.trim();
  if (!query) return;
  ui.query.blur(); // 모바일에서 키보드를 내려 결과가 보이게 한다
  const button = ui.form.querySelector('button');
  button.disabled = true;
  setMessage(ui.searchMessage, '검색 중…');
  ui.results.replaceChildren();

  try {
    const regionId = ui.region.value;
    const routes = await api.searchRoutes(regionId, query);
    ui.results.replaceChildren(
      ...routes.map((route) => {
        const li = document.createElement('li');
        li.innerHTML = `<button type="button" class="item">
          ${routeBadge(route.number, route.type)}
          <span class="body"><span class="title">${escapeHtml(route.type ?? '')}</span>
          <span class="meta">${escapeHtml(route.start)} ↔ ${escapeHtml(route.end)}</span></span>
          <span class="chev" aria-hidden="true">›</span>
        </button>`;
        li.querySelector('button').addEventListener('click', () => openRoute({ regionId, ...route }));
        return li;
      }),
    );

    // 결과가 하나뿐이거나 입력한 번호와 정확히 같은 노선이 하나면 클릭 없이 바로 보여준다.
    const number = normalizeRouteQuery(query);
    const exact = routes.filter((route) => route.number === number);
    const best = routes.length === 1 ? routes[0] : exact.length === 1 ? exact[0] : null;
    if (!routes.length) {
      setMessage(ui.searchMessage, '검색 결과가 없어요. 지역이 맞는지, 노선 번호만 입력했는지 확인해 주세요. (예: 10, 11-1)');
    } else if (best) {
      setMessage(ui.searchMessage, '');
      openRoute({ regionId, ...best });
    } else {
      setMessage(ui.searchMessage, `${routes.length}개 노선을 찾았어요. 볼 노선을 눌러주세요.`);
    }
  } catch (err) {
    setMessage(ui.searchMessage, err.message, true);
  } finally {
    button.disabled = false;
  }
}

// ── 노선 실시간 화면 ──
async function openRoute(route, { stopId = null, push = true } = {}) {
  if (state.view === 'route') closeRoute();
  show('route', { push });
  const token = ++state.routeToken;

  ui.number.textContent = route.number ?? '';
  ui.number.className = `route-badge ${routeTypeClass(route.type)}`;
  ui.type.textContent = route.type ?? '';
  ui.ends.textContent = route.start && route.end ? `${route.start} ↔ ${route.end}` : '';
  ui.pathNote.hidden = true;
  setLive('warn', '노선 정보를 불러오는 중… (처음 여는 노선은 몇 초 걸릴 수 있어요)');

  let detail;
  try {
    detail = await api.route(route.regionId, route.id);
  } catch (err) {
    if (token === state.routeToken) setLive('error', err.message);
    return;
  }
  if (token !== state.routeToken) return; // 그사이 다른 화면으로 이동함

  state.route = { ...route, number: route.number ?? detail.number, type: route.type ?? detail.type };
  ui.number.textContent = state.route.number ?? '';
  ui.number.className = `route-badge ${routeTypeClass(state.route.type)}`;
  ui.type.textContent = state.route.type ?? '';

  const path = detail.path.length >= 2 ? detail.path : detail.stops.map((s) => [s.lat, s.lng]);
  state.line = createPolyline(path);
  const distances = locateStops(state.line, detail.stops);
  state.stops = detail.stops.map((stop, i) => ({ ...stop, s: distances[i] }));
  state.stopSByOrd = new Map(state.stops.map((stop) => [stop.ord, stop.s]));
  state.stopsByOrd = new Map(state.stops.map((stop) => [stop.ord, stop]));
  state.stopSorted = [...distances].sort((a, b) => a - b);

  // 방향(가는 길 / 오는 길)마다 선과 버스 색을 다르게 그린다.
  const segments = directionSegments(state.stops, state.line.length);
  const colorOf = new Map(segments.map((seg, i) => [seg.direction, css(`--dir-${(i % 3) + 1}`)]));
  state.segments = segments;
  state.colorOf = colorOf;
  state.segmentLines = segments.map((seg) =>
    L.polyline(slicePath(state.line, seg.from, seg.to), { color: colorOf.get(seg.direction), weight: 5, opacity: 0.85 })
      .addTo(routeLayer),
  );
  renderLegend(segments, colorOf);
  state.stopMarkers = state.stops.map((stop) => ({
    stop,
    marker: L.circleMarker([stop.lat, stop.lng], {
      radius: 6,
      color: colorOf.get(stop.direction ?? null) ?? css('--route'),
      weight: 2,
      fillColor: css('--surface'),
      fillOpacity: 1,
    })
      .bindTooltip(stop.name, { direction: 'top', offset: [0, -6] })
      .bindPopup(() => stopPopup(stop))
      .addTo(routeLayer),
  }));

  const pathNotes = {
    osm: '이 지역은 공식 도로 경로가 없어 OpenStreetMap 도로를 따라 추정한 경로로 표시합니다.',
    stops: '이 지역은 도로 경로 데이터가 없어 정류장을 이은 선으로 표시합니다.',
  };
  ui.pathNote.textContent = pathNotes[detail.pathSource] ?? '';
  ui.pathNote.hidden = !pathNotes[detail.pathSource];

  const myStop = stopId ? state.stops.find((s) => s.id === stopId) : myStopCandidates()[0];
  if (myStop) setMyStop(myStop, { focus: true });
  else fitTo(state.line.latlngs, 16);

  updateRouteUrl();
  connect();
}

// 정류장 순서대로 방향 라벨이 바뀌는 지점에서 경로를 나눈다. 방향 정보가 없으면 한 덩어리.
function directionSegments(stops, length) {
  const segments = [];
  for (const stop of stops) {
    const direction = stop.direction ?? null;
    const last = segments.at(-1);
    if (last && last.direction === direction) continue;
    if (last) last.to = stop.s;
    segments.push({ direction, from: last ? stop.s : 0, to: length });
  }
  return segments.length ? segments : [{ direction: null, from: 0, to: length }];
}

// 경로 위 거리 s가 속한 방향 구간
function segmentIndexAt(s) {
  const i = state.segments.findIndex((seg) => s < seg.to);
  return i === -1 ? state.segments.length - 1 : i;
}

const directionColorAt = (s) => state.colorOf.get(state.segments[segmentIndexAt(s)].direction);

// 내 정류장을 정하면 그 방향의 선·정류장만 진하게, 반대 방향은 흐리게 보여준다.
function applyDirectionFocus() {
  const focus = state.myStop ? segmentIndexAt(state.myStop.s) : null;
  const focusDirection = focus == null ? undefined : state.segments[focus].direction;
  state.segmentLines.forEach((line, i) => line.setStyle({ opacity: focus == null || i === focus ? 0.85 : 0.15 }));
  for (const { stop, marker } of state.stopMarkers) {
    const visible = focus == null || (stop.direction ?? null) === focusDirection;
    marker.setStyle({ opacity: visible ? 1 : 0.15, fillOpacity: visible ? 1 : 0.15 });
  }
}

function renderLegend(segments, colorOf) {
  const labeled = [...new Set(segments.map((s) => s.direction).filter(Boolean))];
  ui.legend.innerHTML = labeled
    .map((dir) => `<span><i style="background:${colorOf.get(dir)}"></i>${escapeHtml(dir)}</span>`)
    .join('');
  ui.legend.hidden = labeled.length < 2;
}

function updateRouteUrl() {
  const { route, myStop } = state;
  updateUrl(
    { region: route.regionId, route: route.id, no: route.number, stop: myStop?.id },
    route.number ? `${route.number}번` : null,
  );
}

function closeRoute() {
  state.routeToken += 1;
  disconnect();
  clearBuses();
  routeLayer.clearLayers();
  myStopLayer.clearLayers();
  Object.assign(state, {
    route: null,
    line: null,
    stops: [],
    stopSorted: [],
    segments: [],
    colorOf: new Map(),
    segmentLines: [],
    stopMarkers: [],
    myStop: null,
    receivedAt: 0,
    focusPending: false,
  });
  ui.showAllBuses.checked = false;
  ui.mystop.hidden = true;
  ui.mystopHint.hidden = false;
  ui.legend.hidden = true;
  ui.boardResults.replaceChildren();
  ui.boardQuery.value = '';
  setMessage(ui.boardMessage, '');
  ui.busCount.textContent = '-';
  ui.lastUpdate.textContent = '-';
  ui.progress.style.width = '0';
  setLive('', '');
}

function stopPopup(stop) {
  const el = document.createElement('div');
  el.innerHTML = `<div class="popup-title">${escapeHtml(stop.name)}</div>
    ${stop.no ? `<div>정류장 번호 ${escapeHtml(stop.no)}</div>` : ''}
    ${stop.direction ? `<div>${escapeHtml(stop.direction)}</div>` : ''}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'popup-btn';
  const isMine = state.myStop?.id === stop.id && state.myStop?.ord === stop.ord;
  button.textContent = isMine ? '✓ 내 정류장' : '여기서 탈래요';
  button.disabled = isMine;
  button.addEventListener('click', () => {
    map.closePopup();
    setMyStop(stop, { focus: true });
  });
  el.append(button);
  return el;
}

// 내 위치에서 가까운 정류장을 방향별로 하나씩. 길 건너편 정류장 중 어느 쪽에서 탈지 고를 수 있게 한다.
function myStopCandidates() {
  if (!state.me || !state.stops.length) return [];
  const here = L.latLng(state.me.lat, state.me.lng);
  const best = new Map();
  for (const stop of state.stops) {
    const distance = here.distanceTo([stop.lat, stop.lng]);
    const key = stop.direction ?? '';
    if (!best.has(key) || distance < best.get(key).distance) best.set(key, { ...stop, distance });
  }
  return [...best.values()].filter((s) => s.distance <= MY_STOP_RANGE).sort((a, b) => a.distance - b.distance);
}

function setMyStop(stop, { focus = false } = {}) {
  state.myStop = stop;
  myStopLayer.clearLayers();
  L.marker([stop.lat, stop.lng], {
    icon: L.divIcon({
      className: 'map-icon',
      html: '<div class="mystop-marker"><span>여기서 탑승</span></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    }),
    zIndexOffset: 300,
    title: stop.name,
  })
    .bindPopup(() => stopPopup(stop))
    .addTo(myStopLayer);

  ui.mystop.hidden = false;
  ui.mystopHint.hidden = true;
  ui.mystopName.textContent = [stop.name, stop.no && `(${stop.no})`].filter(Boolean).join(' ');
  renderDirectionChips();
  applyDirectionFocus();
  renderApproach();
  updateRouteUrl();

  // 버스 위치가 오면 내 정류장과 가장 가까이 다가오는 버스가 함께 보이도록 맞춘다.
  state.focusPending = focus;
  if (focus) {
    fitTo([[stop.lat, stop.lng]], 15);
    if (state.tracks.size) focusMyStop();
  }
}

function renderDirectionChips() {
  const candidates = myStopCandidates();
  if (candidates.length < 2) {
    ui.dirChips.replaceChildren();
    return;
  }
  ui.dirChips.replaceChildren(
    ...candidates.map((stop) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${stop.direction ?? stop.name} · ${formatDistance(stop.distance)}`;
      button.setAttribute('aria-pressed', String(state.myStop?.direction === stop.direction));
      button.addEventListener('click', () => setMyStop(stop, { focus: true }));
      return button;
    }),
  );
}

// 내 정류장으로 오는 버스. 같은 방향 구간을 달리는 버스만 보여주고,
// 그런 버스가 없을 때만 반환점을 돌아서 올 버스를 보여준다.
function approachList() {
  const entries = [...state.tracks.values()];
  const speed = routeSpeed(entries.filter((e) => e.track.measured).map((e) => e.track.speed));
  const all = approachingBuses({
    stopS: state.myStop.s,
    stopDistances: state.stopSorted,
    buses: entries.map((e) => ({ id: e.id, s: e.track.s })),
    speed,
  });
  const segment = state.segments[segmentIndexAt(state.myStop.s)];
  const sameDirection = all.filter((bus) => state.myStop.s - bus.distance >= segment.from - 1);
  return sameDirection.length ? sameDirection : all.map((bus) => ({ ...bus, viaTurn: true }));
}

function renderApproach() {
  if (!state.myStop) return;
  if (!state.receivedAt) {
    ui.approachList.innerHTML = '<li class="empty">버스 위치를 불러오는 중…</li>';
    return;
  }
  const list = approachList();
  // 나에게 오는 버스만 지도에 남긴다. "다른 버스도 보기"를 켜면 나머지는 흐리게 보여준다.
  const coming = new Set(list.map((b) => b.id));
  for (const entry of state.tracks.values()) {
    const mine = coming.has(entry.id);
    entry.root?.classList.toggle('past', !mine);
    const el = entry.marker.getElement();
    if (el) el.style.display = mine || ui.showAllBuses.checked ? '' : 'none';
  }

  if (!list.length) {
    ui.approachList.innerHTML = '<li class="empty">이 방향으로 다가오는 버스가 없어요. 반대 방향 정류장인지 확인해 주세요.</li>';
    return;
  }
  ui.approachList.innerHTML = list
    .slice(0, 3)
    .map((bus) => {
      const soon = bus.seconds < SOON_SECONDS;
      const time = bus.seconds < 60 ? '곧 도착' : `약 ${formatDuration(bus.seconds)}`;
      const where = bus.seconds === 0
        ? '정류장에 거의 도착했어요'
        : [bus.stopsAway > 0 && `${bus.stopsAway}정거장 전`, formatDistance(bus.distance), bus.viaTurn && '반환점 돌아서 와요']
          .filter(Boolean)
          .join(' · ');
      return `<li><span class="arr-time${soon ? ' soon' : ''}">${time}</span><span class="arr-stops">${where}</span></li>`;
    })
    .join('');
}

function focusMyStop() {
  state.focusPending = false;
  const [nearest] = approachList();
  const points = [[state.myStop.lat, state.myStop.lng]];
  if (nearest) {
    const p = pointAt(state.line, nearest.distance > 0 ? state.myStop.s - nearest.distance : state.myStop.s);
    points.push([p.lat, p.lng]);
  }
  if (state.me) points.push([state.me.lat, state.me.lng]);
  fitTo(points, 16);
}

// ── 실시간 연결 (SSE) ──
function connect() {
  if (!state.route || state.source) return;
  setLive('warn', '실시간 위치에 연결하는 중…');
  const source = new EventSource(api.liveUrl(state.route.regionId, state.route.id));
  source.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'positions') onPositions(message);
    else if (message.type === 'error') setLive('error', message.message);
  };
  source.onerror = () => setLive('warn', '연결이 끊겨 다시 연결하는 중…');
  state.source = source;
}

function disconnect() {
  state.source?.close();
  state.source = null;
}

function setLive(level, text) {
  ui.liveDot.className = `live-dot ${level}`;
  setMessage(ui.liveMessage, text, level === 'error');
}

// 버스 GPS → 경로 위 거리. 정류장 순번으로 찾을 구간을 좁혀 왕복 노선에서도 올바른 방향에 붙인다.
function locateBus(bus) {
  const { line, stopSByOrd } = state;
  let minS = 0;
  let maxS = line.length;
  if (bus.stopOrd && stopSByOrd.has(bus.stopOrd)) {
    minS = (stopSByOrd.get(bus.stopOrd - 1) ?? stopSByOrd.get(bus.stopOrd)) - WINDOW_MARGIN;
    maxS = (stopSByOrd.get(bus.stopOrd + 1) ?? line.length) + WINDOW_MARGIN;
  }
  let hit = project(line, bus.lat, bus.lng, minS, maxS);
  if (hit.distance > OFF_ROUTE_METERS) hit = project(line, bus.lat, bus.lng);
  return hit.distance <= OFF_ROUTE_METERS ? hit.s : null;
}

function onPositions(message) {
  if (!state.line) return;
  // 서버 시계와 브라우저 시계 차이를 보정해 관측 시각을 브라우저 기준으로 바꾼다.
  const clockOffset = Date.now() - message.fetchedAt;
  state.receivedAt = Date.now();
  state.pollMs = message.pollMs;

  const seen = new Set();
  rawLayer.clearLayers();
  for (const bus of message.buses) {
    if (!Number.isFinite(bus.lat) || !Number.isFinite(bus.lng) || !bus.lat) continue;
    rawLayer.addLayer(L.circleMarker([bus.lat, bus.lng], { radius: 5, color: css('--raw'), weight: 2, fill: false }));
    const s = locateBus(bus);
    if (s == null) continue;

    seen.add(bus.id);
    const observation = { s, at: bus.observedAt + clockOffset, info: bus };
    const entry = state.tracks.get(bus.id);
    if (entry) entry.track.update(observation);
    else addBus(bus.id, new BusTrack(observation));
  }

  for (const [id, entry] of state.tracks) {
    if (!seen.has(id)) {
      busLayer.removeLayer(entry.marker);
      state.tracks.delete(id);
    }
  }

  ui.busCount.textContent = `${seen.size}대`;
  setLive('ok', seen.size ? '' : '지금 운행 중인 버스가 없어요.');
  renderApproach();
  if (state.focusPending && state.myStop) focusMyStop();
}

function addBus(id, track) {
  const { info } = track;
  // 버스 색 = 지금 달리는 방향의 노선 색. 저상버스는 라벨에 ♿ 표시.
  const label = `${state.route.number ?? ''}${info.lowFloor ? ' ♿' : ''}`;
  const icon = L.divIcon({
    className: 'map-icon',
    html: `<div class="bus" style="--bus-color:${directionColorAt(track.s)}"><div class="bus-arrow"></div><span class="bus-label">${escapeHtml(label)}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
  const start = pointAt(state.line, track.s);
  const marker = L.marker([start.lat, start.lng], { icon, keyboard: false, title: info.plate })
    .bindPopup(() => busPopup(id, track))
    .addTo(busLayer);
  const root = marker.getElement()?.querySelector('.bus');
  state.tracks.set(id, { id, track, marker, root, arrow: root?.querySelector('.bus-arrow') });
}

function busPopup(id, track) {
  const { info } = track;
  const lastStop = state.stopsByOrd.get(info.stopOrd);
  const speedText = track.measured
    ? `${Math.round(track.speed * 3.6)} km/h`
    : `측정 중 (기본 ${Math.round(DEFAULT_SPEED * 3.6)} km/h로 예측)`;
  const toMyStop = state.myStop ? approachList().find((b) => b.id === id) : null;
  const rows = [
    `<div class="popup-title">${escapeHtml(state.route.number ?? '')}번 버스</div>`,
    toMyStop ? `<b>내 정류장까지 약 ${formatDuration(toMyStop.seconds)}</b>` : null,
    `차량번호: ${escapeHtml(info.plate)}`,
    lastStop ? `최근 정류장: ${escapeHtml(lastStop.name)}` : null,
    `추정 속도: ${speedText}`,
    info.lowFloor ? '저상버스' : null,
    info.congestion ? `혼잡도: ${escapeHtml(info.congestion)}` : null,
  ];
  return rows.filter(Boolean).join('<br>');
}

function clearBuses() {
  busLayer.clearLayers();
  rawLayer.clearLayers();
  state.tracks.clear();
}

// ── 애니메이션 루프 ──
let lastFrame = performance.now();
function frame(time) {
  const dt = Math.min(0.25, (time - lastFrame) / 1000);
  lastFrame = time;
  if (state.line) {
    const now = Date.now();
    for (const entry of state.tracks.values()) {
      const p = pointAt(state.line, entry.track.step(now, dt));
      entry.marker.setLatLng([p.lat, p.lng]);
      if (!entry.root) {
        entry.root = entry.marker.getElement()?.querySelector('.bus');
        entry.arrow = entry.root?.querySelector('.bus-arrow');
      }
      entry.arrow?.style.setProperty('--bearing', `${p.bearing}deg`);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 수신 시각, 진행 막대, 도착 카운트다운
setInterval(() => {
  if (state.view === 'route' && state.receivedAt) {
    const elapsed = Date.now() - state.receivedAt;
    ui.lastUpdate.textContent = `${Math.floor(elapsed / 1000)}초 전`;
    ui.progress.style.width = `${Math.min(100, (elapsed / state.pollMs) * 100)}%`;
  }
}, 250);
setInterval(() => {
  tickArrivals();
  if (state.view !== 'route' || !state.line) return;
  // 반환점을 돈 버스는 색이 바뀐다.
  for (const entry of state.tracks.values()) entry.root?.style.setProperty('--bus-color', directionColorAt(entry.track.s));
  renderApproach();
}, 1000);

// ── 이벤트 ──
for (const tab of ui.tabs.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => {
    state.stack = [];
    show(tab.dataset.view, { push: false });
    if (tab.dataset.view === 'search') ui.query.focus();
  });
}

ui.back.addEventListener('click', back);
ui.locateBtn.addEventListener('click', () => useMyLocation());
ui.centerBtn.addEventListener('click', () => {
  const c = map.getCenter();
  if (map.getZoom() < 13) {
    setMessage(ui.nearbyMessage, '지도를 조금 더 확대해서 찾을 곳을 가운데에 맞춘 뒤 눌러주세요.', true);
    return;
  }
  findNearby(c.lat, c.lng, '지도 중심');
});
ui.stopRefresh.addEventListener('click', () => {
  setMessage(ui.stopMessage, '');
  loadArrivals();
});
ui.form.addEventListener('submit', search);
ui.placeForm.addEventListener('submit', searchPlaces);
ui.boardForm.addEventListener('submit', searchBoarding);
ui.region.addEventListener('change', () => setRegion(ui.region.value));
ui.placeRegion.addEventListener('change', () => setRegion(ui.placeRegion.value));

ui.showAllBuses.addEventListener('change', renderApproach);

ui.showRaw.addEventListener('change', () => {
  if (ui.showRaw.checked) rawLayer.addTo(map);
  else rawLayer.remove();
});

ui.collapse.addEventListener('click', () => {
  const collapsed = ui.panel.classList.toggle('collapsed');
  ui.collapse.textContent = collapsed ? '펼치기' : '접기';
  ui.collapse.setAttribute('aria-expanded', String(!collapsed));
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    state.hiddenTimer = setTimeout(() => {
      disconnect();
      stopArrivalsPolling();
      setLive('warn', '화면이 가려져 있어 업데이트를 잠시 멈췄어요.');
    }, HIDDEN_DISCONNECT_MS);
  } else {
    clearTimeout(state.hiddenTimer);
    if (state.view === 'route') connect();
    if (state.view === 'stop' && !state.arrivalsTimer) startArrivalsPolling();
  }
});

// ── 시작 ──
await loadRegions();
const params = new URLSearchParams(location.search);
const region = params.get('region');
if (region) setRegion(region);

if (region && params.get('route')) {
  if (params.get('no')) ui.query.value = params.get('no');
  openRoute({ regionId: region, id: params.get('route'), number: params.get('no') }, { stopId: params.get('stop') });
} else if (region && params.get('stop')) {
  openStop({ region, id: params.get('stop'), name: params.get('name'), lat: null, lng: null });
}

// 이미 위치 권한을 허용한 사용자는 버튼을 누르지 않아도 바로 주변 정류장을 보여준다.
navigator.permissions
  ?.query({ name: 'geolocation' })
  .then((status) => {
    if (status.state !== 'granted') return;
    if (state.view === 'nearby') useMyLocation();
    else locate().then((me) => {
      setMe(me);
      if (state.view === 'route' && state.stops.length) renderDirectionChips();
    }).catch(() => {});
  })
  .catch(() => {});
