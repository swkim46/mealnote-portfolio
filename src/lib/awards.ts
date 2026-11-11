// 수상·순위 표시 규칙. 화면은 components/Awards.tsx
/** 공동 순위는 이름 하나와 나머지 수로 적는다(사용자 11-06: 내 순위는 따로 보인다). 내가 있으면 내 이름을 앞에 둔다 */
export function tieLabel(list: { nickname: string; is_me: boolean }[]) {
  const first = list.find((x) => x.is_me) ?? list[0];
  if (!first) return '';
  return `${first.nickname}${first.is_me ? ' (나)' : ''}${list.length > 1 ? ` 외 ${list.length - 1}명` : ''}`;
}

/** 이번 달이 끝날 때까지 남은 날 */
export function monthLeftText(today: string) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)), d = Number(today.slice(8, 10));
  const left = new Date(y, m, 0).getDate() - d;
  return left > 0 ? `${left}일 남음` : '오늘까지';
}
