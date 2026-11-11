// 루틴 운동 한 줄의 글자(운동 탭의 루틴 카드·기록 창이 같이 쓴다)
import { routineFocus } from './bodyParts';
import { restLabel } from './restTime';

const isKg = (w: string) => /^\d+(\.\d+)?([+/]\d+(\.\d+)?)*$/.test(w);
/** '65kg · 12회'(기호가 든 값은 그대로) */
export const targetText = (i: { weight: string; reps: string }) =>
  [i.weight && `${i.weight}${isKg(i.weight) ? 'kg' : ''}`, i.reps && (/^\d+$/.test(i.reps) ? `${i.reps}회` : i.reps)].filter(Boolean).join(' · ');
/** 운동 한 줄의 보조 글: '목표 65kg · 12회 · 쉬는 시간 1분 30초'(v2.1 쉬는 시간 표시) */
export const goalLine = (i: { weight: string; reps: string; rest: string }) =>
  [targetText(i) && `목표 ${targetText(i)}`, restLabel(i.rest) && `쉬는 시간 ${restLabel(i.rest)}`].filter(Boolean).join(' · ');
/** 루틴(운동 날) 하나의 주요 부위 — '하체'·'등·가슴'(운동 이름으로 정함, src/lib/bodyParts.ts) */
export const focusOf = (items: { day_no: number; name: string }[], d: number) => routineFocus(items.filter((i) => i.day_no === d).map((i) => i.name));
