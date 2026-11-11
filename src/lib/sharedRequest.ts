// 같은 조회를 여러 화면이 함께 쓴다(2.4 — Codex v2.3.2 1차 리뷰: 수상 칸과 순위 창이 같은 자료를 따로 받아,
// 창이 열린 채 앱으로 돌아오면 같은 요청이 두 번 나갔다). 진행 중인 요청이 있으면 그 결과를 함께 받는다.
// 끝난 결과는 남기지 않는다 — 다음에 부르면 새로 받는다. 내용이 바뀌었다는 신호(version)는 key에 넣어 옛 요청을 함께 쓰지 않게 한다.
// 순위·중량왕은 로그인한 사람의 담당 집단과 '내 기록'을 담은 자료다 — 함께 받는 범위는 같은 로그인 안으로 한정한다
// (Codex v2.4.0 1차 리뷰 P1-1: A 계정의 늦은 요청을 로그아웃 뒤 B 계정이 받아 A 쪽 회원이 보였다)
const inflight = new Map<string, Promise<unknown>>();
let scope = '';
// 로그인 회차: 로그인한 사용자가 바뀔 때마다(로그아웃 포함) 하나씩 는다. 같은 사용자의 로그인 소식이 거듭 와도(앱으로 돌아옴 등) 그대로다.
// 로그아웃한 뒤 같은 계정으로 다시 들어오면 새 회차 — 같은 로그인 동안만 둘 값(저장하지 못한 메모 등)은 이 값으로 묶는다(Codex v2.4.0 2차 리뷰 4절)
let generation = 0;
const loginListeners = new Set<() => void>();

/** 로그인·로그아웃·계정 전환 때 부른다: 진행 중인 공유 요청을 모두 버리고 새 범위(사용자 id)로 시작한다 */
export function setRequestScope(userId: string) {
  const changed = userId !== scope;
  scope = userId;
  inflight.clear();
  if (changed) {
    generation++;
    loginListeners.forEach((f) => f());
  }
}

/** 지금 로그인 회차 — 시작할 때 읽어 두고 끝날 때 견주면 그사이 로그인이 바뀌었는지 안다 */
export const loginGeneration = () => generation;
/** 로그인한 사용자가 바뀌면(로그아웃 포함) 부른다 */
export function onLoginChange(f: () => void) {
  loginListeners.add(f);
  return () => {
    loginListeners.delete(f);
  };
}

export function sharedRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
  const k = `${scope}\n${key}`;
  const cur = inflight.get(k);
  if (cur) return cur as Promise<T>;
  const p = load().finally(() => {
    if (inflight.get(k) === p) inflight.delete(k);
  });
  inflight.set(k, p);
  return p;
}
