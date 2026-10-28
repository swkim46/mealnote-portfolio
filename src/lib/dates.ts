export const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const todayKey = () => dateKey(new Date());

export const shiftDay = (day: string, amount: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + amount);
  return dateKey(d);
};

export const prettyDay = (day: string, full = false) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('ko-KR', {
    month: 'long',
    day: 'numeric',
    ...(full ? { weekday: 'long' as const } : {}),
  });

export const weekdayShort = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString('ko-KR', { weekday: 'short' });

export const nowTime = () => new Date().toTimeString().slice(0, 5);

export const defaultMealType = () => {
  const hour = new Date().getHours();
  return hour < 11 ? '아침' : hour < 16 ? '점심' : '저녁';
};

/** 댓글 시각: 방금 전 / n분 전 / n시간 전 / 10월 20일 13:05 */
export function relativeTime(iso: string) {
  const t = Date.parse(iso);
  const diff = Math.max(0, Date.now() - t) / 60000;
  if (diff < 1) return '방금 전';
  if (diff < 60) return `${Math.floor(diff)}분 전`;
  if (diff < 60 * 24) return `${Math.floor(diff / 60)}시간 전`;
  const d = new Date(t);
  return `${prettyDay(dateKey(d))} ${d.toTimeString().slice(0, 5)}`;
}
