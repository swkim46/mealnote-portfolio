// 2.0 시작 안내(2026-10-30 사용자 요청): 정식 2.0을 처음 열면 한 번 띄운다. 기기마다 한 번(이 기기에서 닫으면 다시 뜨지 않음),
// 머리글의 사용 안내(?) 버튼으로 다시 볼 수 있다(2026-11-01 사용자 결정: 설정 안이 아니라 종 버튼 옆).

const KEY = 'mealnote:start-guide';
export const START_GUIDE_VERSION = '2.0';
/** 새 아이콘·이름을 적용하는 배포면 true — '이미 홈 화면에 추가했다면 다시 추가' 쪽을 보인다(2.0: 이름 FITORY · 아이콘 brand/fitory v4) */
export const REINSTALL_NOTICE: boolean = false; // 11-06 사용자 요청으로 끔(2.0 전환이 끝났다)

export function shouldShowStartGuide() {
  try {
    return localStorage.getItem(KEY) !== START_GUIDE_VERSION;
  } catch {
    return false; // 저장소를 못 쓰는 브라우저에서는 매번 띄우지 않는다
  }
}

export function markStartGuideSeen() {
  try {
    localStorage.setItem(KEY, START_GUIDE_VERSION);
  } catch {
    /* 못 적어도 이번 화면에서는 닫힌다 */
  }
}

// 새 기능 소개(2.3): 업데이트 뒤 처음 열 때 한 번. 시작 안내를 보는 기기는 앱을 처음 쓰는 기기라 소개를 띄우지 않는다
const NEWS_KEY = 'mealnote:whats-new';
export const WHATS_NEW_VERSION = '2.3';

function seenNews() {
  try {
    return localStorage.getItem(NEWS_KEY) === WHATS_NEW_VERSION;
  } catch {
    return true; // 저장소를 못 쓰는 브라우저에서는 매번 띄우지 않는다
  }
}

function markNewsSeen() {
  try {
    localStorage.setItem(NEWS_KEY, WHATS_NEW_VERSION);
  } catch {
    /* 못 적어도 이번 화면에서는 닫힌다 */
  }
}

/** 앱을 열 때 띄울 창. 띄우는 순간 '봤음'으로 적어 ✕로 닫아도 다시 뜨지 않는다 */
export function firstOpenSheet(): 'guide' | 'whatsNew' | null {
  if (shouldShowStartGuide()) {
    markStartGuideSeen();
    markNewsSeen();
    return 'guide';
  }
  if (seenNews()) return null;
  markNewsSeen();
  return 'whatsNew';
}
