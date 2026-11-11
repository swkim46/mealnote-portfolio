// 쉬는 시간(v2.1, 2026-11-02 사용자 피드백 "쉬는 시간 표시 추가"): 루틴의 REST 칸 글자 → 화면 글자·타이머 초.
// 시트의 REST 칸은 분 단위 숫자(0.5·1·1.5·2)이고 '1.5~2' 같은 범위도 있다. 'x'·'-'는 쉬는 시간 없음.
// '30초'·'30s'·'1분'·'1m'처럼 단위를 붙인 글자도 읽는다. 읽지 못한 글자는 그대로 보이고 타이머는 돌지 않는다.

const NONE = /^(x|×|-|–|—)?$/i;

/** 글자 하나 → 초(못 읽으면 null). 단위가 없으면 분 */
function seconds(t: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(초|s|sec|분|m|min)?$/i.exec(t.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const sec = m[2] && /^(초|s|sec)$/i.test(m[2]) ? n : n * 60;
  return sec > 0 && sec <= 3600 ? Math.round(sec) : null;
}

const UNIT = /(초|s|sec|분|m|min)\s*$/i;
/**
 * 범위('1.5~2')면 [앞, 뒤], 아니면 [값]. 단위를 끝에만 쓴 범위('30~60초'·'1~2분')는 그 단위를 앞에도 붙인다 —
 * 단위 없는 앞 숫자를 분으로 읽어 '30~60초'가 30분 타이머가 되던 것(Codex v2.1.0 4차 리뷰 P2)
 */
function parts(rest: string): string[] {
  const t = rest.trim();
  const range = /^(.+?)\s*[~～]\s*(.+)$/.exec(t);
  if (!range) return [t];
  const [a, b] = [range[1].trim(), range[2].trim()];
  const unit = UNIT.exec(b)?.[1];
  return [!UNIT.test(a) && unit ? `${a}${unit}` : a, b];
}

/** 초 → '1분 30초' */
export function durationText(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return [m && `${m}분`, s && `${s}초`].filter(Boolean).join(' ') || '0초';
}

/** 타이머에 쓸 초(범위면 짧은 쪽). 쉬는 시간이 없거나 읽지 못하면 null */
export function restSeconds(rest: string): number | null {
  if (NONE.test(rest.trim())) return null;
  return seconds(parts(rest)[0]);
}

/** 화면 글자: '1분 30초' · '1분 30초～2분'. 없으면 빈 글자, 읽지 못하면 원래 글자 */
export function restLabel(rest: string): string {
  const t = rest.trim();
  if (NONE.test(t)) return '';
  const secs = parts(t).map(seconds);
  if (secs.some((s) => s === null)) return t;
  return (secs as number[]).map(durationText).join('～');
}
