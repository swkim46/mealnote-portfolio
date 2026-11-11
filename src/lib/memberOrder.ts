// 트레이너 회원 목록의 이름순(2.3 — 트레이너 의견 2026-11-03: 자음으로 구분). 된소리는 예사소리와 같은 칸으로 묶는다
export const CHOSEONG = ['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
/** 한글로 시작하지 않는 닉네임의 칸 */
export const OTHER_GROUP = '기타';

const FIRST = ['ㄱ', 'ㄱ', 'ㄴ', 'ㄷ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅂ', 'ㅅ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

/** 닉네임 첫 글자의 초성 칸 */
export function choseongOf(name: string) {
  const code = name.trim().charCodeAt(0) - 0xac00;
  return code >= 0 && code < 11172 ? FIRST[Math.floor(code / 588)] : OTHER_GROUP;
}
