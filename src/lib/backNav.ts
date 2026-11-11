// 뒤로 가기 한 곳(2.3 — 사용자 요청 11-05 '위 화살표로만 돌아가 불편', 시안 design/v23-20261105 11번).
// 돌아갈 곳이 있는 화면이 층(layer)을 올리면 층마다 브라우저 기록 한 칸을 맞춘다. 안드로이드 시스템 뒤로·브라우저 뒤로는 popstate로,
// 홈 화면에 추가한 앱의 왼쪽 끝 밀기는 useEdgeSwipeBack으로 들어와 맨 위 층을 닫는다. 위 화살표·✕로 닫으면 남은 칸은 소리 없이 되돌린다.
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

/** 층 높이: 탭 < 회원 화면 < 창 < 창 안의 안내. 같은 순간에 올라와도 이 순서로 쌓는다 */
export const BACK_LEVEL = { tab: 0, screen: 1, sheet: 2, inner: 3 } as const;

/** 창이 자기 안의 화면에 내려 주는 묶음 표시. 창 안의 안내는 그 창과 함께 쌓인다 */
export const BackOwner = createContext<object | null>(null);

type Layer = { level: number; group: object; order: number; close: () => boolean | void; surface: () => HTMLElement[] | null };
const layers: Layer[] = [];
/** 창 묶음이 열린 차례 */
const groups = new Map<object, number>();
let opened = 0;
const depthOf = () => (history.state as { backDepth?: number } | null)?.backDepth ?? 0;
let depth = depthOf();
/** 코드가 되돌리는 중인 기록 이동. 끝나면 popstate가 온다 */
let moving = false;
let movingGuard = 0;
/** 안전 시간이 지나 끝난 것으로 친 이동. 이 시각까지 오는 popstate도 코드가 한 이동이다 — 사용자의 뒤로로 보면 방금 연 창이 닫힌다 */
let lateUntil = 0;

/** 아이폰 홈 화면 앱: 시스템 뒤로가 왼쪽 끝 밀기뿐이고, 기록에 칸이 있으면 앱과 상관없이 살아난다 */
const iosApp = () => (navigator as { standalone?: boolean }).standalone === true;
/**
 * 기록에 둘 칸 수. 탭의 칸은 안드로이드 시스템 뒤로를 받으려고 둔다. 아이폰 홈 화면 앱에 두면 끝을 밀어 탭이 바뀐다(11-06 사용자 지적).
 * 회원 화면도 아이폰에는 칸을 두지 않는다. 시스템 밀기는 칸을 만든 때의 화면을 보여 주는 것으로 보이는데, 알림으로 앱을 열면 그때 화면이
 * 아직 비어 있어 밀 때 빈 화면이 나왔다(11-06 사용자 지적). 칸이 없으면 시스템 밀기가 꺼지고 useEdgeSwipeBack이 지금 화면을 아래에 깐다
 */
const wanted = () => (iosApp() ? layers.filter((l) => l.level > BACK_LEVEL.screen).length : layers.length);

function reconcile() {
  if (moving) return;
  const want = wanted();
  while (depth < want) history.pushState({ backDepth: ++depth }, '');
  if (want < depth) {
    moving = true;
    history.go(want - depth);
    // 이동할 칸이 없으면 popstate가 오지 않는다. 다시 이동하지는 않는다 — 늦게 오는 popstate와 겹치면 층이 하나 더 닫힌다.
    // 느린 기기에서는 1초를 넘기기도 해 넉넉히 기다린다
    movingGuard = window.setTimeout(() => {
      moving = false;
      lateUntil = Date.now() + 30_000;
      depth = depthOf();
    }, 10_000);
  }
}

function onPop() {
  const mine = moving || Date.now() < lateUntil;
  window.clearTimeout(movingGuard);
  moving = false;
  lateUntil = 0;
  depth = depthOf();
  if (mine || depth >= wanted()) return reconcile();
  // 사용자가 뒤로 갔다. 닫는 층은 사라지면서 기록을 맞춘다. 막혔거나(쓰던 내용 보호) 닫히지 않았으면 칸을 되살린다
  if (layers[layers.length - 1].close() === false) reconcile();
  else window.setTimeout(reconcile, 300);
}

/**
 * 쌓는 차례: 탭 < 회원 화면 < 창 묶음(열린 차례). 묶음 안에서는 창 < 그 안의 안내. 안쪽 효과가 먼저 돌아도 이 차례는 같다.
 * 전체를 높이로만 세우면 나중에 뜬 보안 알림이 먼저 연 성별 확인 창 아래로 들어가, 뒤로가 보이지 않는 창을 닫았다(Codex v2.3.1 2차 리뷰 1번)
 */
function stackOrder(a: Layer, b: Layer) {
  const modalA = a.level >= BACK_LEVEL.sheet, modalB = b.level >= BACK_LEVEL.sheet;
  if (modalA !== modalB) return modalA ? 1 : -1;
  if (!modalA) return a.level - b.level || a.order - b.order;
  return groups.get(a.group)! - groups.get(b.group)! || a.level - b.level || a.order - b.order;
}

function addLayer(layer: Layer) {
  if (!groups.has(layer.group)) groups.set(layer.group, ++opened);
  layers.push(layer);
  layers.sort(stackOrder);
  reconcile();
}

function removeLayer(layer: Layer) {
  layers.splice(layers.indexOf(layer), 1);
  if (!layers.some((l) => l.group === layer.group)) groups.delete(layer.group);
  reconcile();
}

window.addEventListener('popstate', onPop);
reconcile(); // 새로고침 전에 쌓인 칸을 치운다

/**
 * active인 동안 뒤로 가기가 close를 부른다. close가 false를 돌려주면 닫지 않은 것이다.
 * surface는 왼쪽 끝을 밀 때 손가락을 따라 움직일 요소들이다. 없으면 시스템 뒤로만 받는다. own은 창이 자기 묶음 표시를 넘길 때 쓴다
 */
export function useBackLayer(active: boolean, close: () => boolean | void, { level = BACK_LEVEL.tab, surface, own }: { level?: number; surface?: () => (HTMLElement | null | undefined)[]; own?: object } = {}) {
  const parent = useContext(BackOwner);
  const latest = useRef({ close, surface });
  useEffect(() => {
    latest.current = { close, surface };
  });
  useEffect(() => {
    if (!active) return;
    const layer: Layer = {
      level,
      group: own ?? parent ?? {},
      order: ++opened,
      close: () => latest.current.close(),
      surface: () => latest.current.surface?.().filter((el) => !!el) ?? null,
    };
    addLayer(layer);
    return () => removeLayer(layer);
  }, [active, level, own, parent]);
}

/** 맨 위 층이 창 안의 안내인가. 시스템 뒤로가 창을 먼저 닫으려 할 때 안내만 닫는 데 쓴다 */
export const innerOnTop = () => (layers[layers.length - 1]?.level ?? BACK_LEVEL.tab) >= BACK_LEVEL.inner;
export const closeTopLayer = () => layers[layers.length - 1]?.close();

/** 앱 틀에서 밀 때 움직일 요소: 머리글·본문·주요 버튼 칸. 아래 탭은 그대로 둔다 */
export const shellSurface = () => [...document.querySelectorAll<HTMLElement>('.app-header:not(.swipe-under *), .app-main:not(.swipe-under *), .action-bar')];

const EDGE_PX = 24;
const FAST_PX_PER_MS = 0.5;
const FAST_MIN_PX = 40;
const SETTLE_MS = 180;

let swiping = false;
const swipeListeners = new Set<() => void>();
const setSwiping = (on: boolean) => {
  swiping = on;
  swipeListeners.forEach((l) => l());
};
/** 지금 화면 층을 밀고 있는가: 이전 화면을 아래에 깔아 줄 때 쓴다. 창을 밀 때는 지금 화면이 그대로 보여야 한다 */
export const useEdgeSwiping = () =>
  useSyncExternalStore(
    (l) => {
      swipeListeners.add(l);
      return () => swipeListeners.delete(l);
    },
    () => swiping,
  );

// 브라우저 안에서는 브라우저의 뒤로 몸짓이 있어 겹친다. 홈 화면에 추가한 앱에서만 받는다
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || iosApp();

/** 왼쪽 끝에서 오른쪽으로 밀기. 손가락을 따라 움직이고, 절반쯤 밀거나 빠르게 밀면 돌아가고 덜 밀면 제자리로 온다 */
export function useEdgeSwipeBack() {
  useEffect(() => {
    if (!standalone()) return;
    let s: { id: number; x: number; y: number; at: number; dx: number; layer: Layer; els: HTMLElement[] | null } | null = null;
    /** 손을 뗀 뒤 자리로 가는 중인 밀기를 그 자리에서 끝낸다 */
    let settling: (() => void) | null = null;
    const paint = (els: HTMLElement[], x: number, ms = 0) =>
      els.forEach((el) => {
        el.style.transition = ms ? `transform ${ms}ms ease-out` : 'none';
        el.style.transform = `translateX(${x}px)`;
      });
    const clear = (els: HTMLElement[]) =>
      els.forEach((el) => {
        el.classList.remove('edge-moving');
        el.style.transition = '';
        el.style.transform = '';
      });
    const start = (e: TouchEvent) => {
      // 밀던 중에 다른 손가락이 닿으면 취소한다. 그대로 덮어쓰면 화면이 밀린 채 남는다
      cancel();
      const t = e.touches[0];
      const layer = layers[layers.length - 1];
      if (e.touches.length !== 1 || t.clientX > EDGE_PX || !layer?.surface()) return;
      s = { id: t.identifier, x: t.clientX, y: t.clientY, at: e.timeStamp, dx: 0, layer, els: null };
      // 손가락 아래 요소가 화면에서 사라지면 끝 소식이 document까지 오지 않는다
      e.target?.addEventListener('touchend', end as EventListener, { once: true });
      e.target?.addEventListener('touchcancel', cancel, { once: true });
    };
    const move = (e: TouchEvent) => {
      if (!s) return;
      const id = s.id;
      const t = [...e.touches].find((x) => x.identifier === id);
      if (!t) return;
      const dx = t.clientX - s.x, dy = t.clientY - s.y;
      if (!s.els) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        // 스크롤이 먼저 시작됐으면(막을 수 없는 이동) 밀기로 받지 않는다
        if (dx <= 0 || Math.abs(dy) > dx || !e.cancelable) {
          s = null;
          return;
        }
        s.els = s.layer.surface() ?? [];
        s.els.forEach((el) => el.classList.add('edge-moving'));
        setSwiping(s.layer.level === BACK_LEVEL.screen);
      }
      e.preventDefault();
      s.dx = Math.max(0, dx);
      paint(s.els, s.dx);
    };
    function end(e: TouchEvent) {
      const cur = s;
      s = null;
      if (!cur?.els) return;
      const els = cur.els;
      const width = window.innerWidth;
      const go = cur.dx > width / 2 || (cur.dx > FAST_MIN_PX && cur.dx / (e.timeStamp - cur.at) > FAST_PX_PER_MS);
      paint(els, go ? width : 0, SETTLE_MS);
      const finish = () => {
        window.clearTimeout(timer);
        settling = null;
        clear(els);
        setSwiping(false);
      };
      const timer = window.setTimeout(() => {
        // 화면을 바꾼 뒤에 제자리로 돌려야 지금 화면이 번쩍이지 않는다. 막히면(쓰던 내용 보호) 그대로 돌아온다
        if (go) flushSync(() => void cur.layer.close());
        finish();
      }, SETTLE_MS);
      settling = finish;
    }
    function cancel() {
      if (s?.els) {
        clear(s.els);
        setSwiping(false);
      }
      s = null;
    }
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', cancel);
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', cancel);
      // 틀이 사라져도 밀던 상태를 남기지 않는다. 새 틀이 남은 값을 받아 아래 깔개가 화면에 남았다(Codex v2.3.1 2차 리뷰 2번)
      cancel();
      settling?.();
    };
  }, []);
}
