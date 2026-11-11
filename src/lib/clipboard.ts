// 글자 복사(시트 공유 주소·앱 주소). 복사 기능이 없는 환경(https가 아닌 주소에서는 navigator.clipboard가 없다)과 권한 거절을 모두
// false로 돌려, 화면이 '직접 복사' 안내로 넘어가게 한다(Codex v2.0.0 정식 1차 리뷰 2 — 기능이 없으면 호출 자체가 예외였다)
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
