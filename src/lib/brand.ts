// 앱 이름은 이 한 곳에서 정한다(2.0부터 FITORY — 클로드전달_FITORY_2_0_브랜드_UI반영_261101.md).
// 저장소 이름·저장 키(mealnote:*)·계정 구조는 이름 때문에 바꾸지 않는다. 한글 표기는 아직 정하지 않아 앱 안에서는 영문만 쓴다.
// index.html과 설치 정보(vite.config.ts manifest)는 이 파일을 읽지 못해 같은 값을 직접 적는다 — scripts/unit-check.mjs가 대조한다.
export const APP_NAME = 'FITORY';
/** 1.8까지의 이름. 이미 홈 화면에 추가한 아이콘·휴대폰 설정의 알림 목록에는 다시 추가하기 전까지 이 이름으로 남는다 */
export const OLD_APP_NAME = '식단노트';
/** 화면 안에 보이는 앱 아이콘: Codex 고정 자산 v4의 설치 아이콘 출력(brand/fitory/README.md). 새로 그리거나 색을 바꾸지 않고 그대로 불러온다.
 *  /app-icon.svg는 1MB가 넘어 화면 표시에는 192px PNG를 쓴다 */
export const APP_ICON = '/pwa-192x192.png';
/** 휴대폰 설정에서 찾을 앱 이름: 새로 추가했으면 FITORY, 1.8 때 추가한 그대로면 식단노트 */
export const SETTINGS_APP_NAME = `${APP_NAME}(예전에 추가했다면 ${OLD_APP_NAME})`;
