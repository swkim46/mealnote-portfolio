// 운동 이름 → 주로 쓰는 부위(2026-10-30 사용자 요청: 루틴을 '가슴 루틴'·'하체 루틴'처럼 부위로 부른다).
// 공개 운동 DB(free-exercise-db·wger)는 영어 이름뿐이고 한국어 이름이 없어, 트레이너 시트의 실제 이름(한글·헬스장 약어 — 사레레·라트익·불스스·ohp)에
// 맞춘 키워드 표를 둔다. 실제 시트 사본 8개월치 운동 이름 100개로 맞춰 봤다(scripts/unit-check.mjs에 대표 이름).
// 'A+B'처럼 묶은 운동은 나눠서 각각 센다. 표는 위에서부터 처음 맞는 줄을 쓴다 — 구체적인 낱말(레그 컬·노르딕컬)을 일반 낱말(컬)보다 위에.
export type BodyPart = '가슴' | '등' | '어깨' | '하체' | '팔' | '코어';

const RULES: [RegExp, BodyPart | null][] = [
  [/스트레칭|\bstr\b|흉추|폼롤/i, null], // 몸풀기는 세지 않는다
  [/레그\s*(익스텐션|프레스|컬)|노르딕|스[퀏쿼]|런지|불스스|불가리안|코사크|굿모닝|스윙|브릿지|루마니안|데드\s*리프트|힙\s*쓰러스트|아웃타이|이너타이|크램쉘|카프|스텝\s*업/i, '하체'],
  [/데드\s*버그|플랭크|크런치|레그\s*레이즈|l-?sit|드래곤|슈퍼맨|버드독|윈드밀|싯\s*업|롤\s*아웃|팔로프/i, '코어'],
  [/ohp|오버헤드\s*프레스|숄더|사레레|레터럴|레이즈|페이스\s*풀|업라이트|\by\s*t\b|헤일로|바텀\s*업|벤트\s*프레스|클린\s*앤|아놀드|리어|리버스\s*플라이/i, '어깨'],
  [/라트익|컬|익스|해머|킥백|트라이셉|바이셉/i, '팔'],
  // '내로우(그립)'의 로우·'플랫'의 랫은 등 운동이 아니다
  [/(?<!내)로우|랫\s*풀|라트(?!익)|풀\s*업|풀\s*다운|풀\s*오버|인버티드|슈러그|랙\s*풀|매달리기|행잉|턱걸이|팬들레이/i, '등'],
  [/벤치|체스트|플라이|푸[쉬시]\s*업|딥스|프레스/i, '가슴'],
];

/** 운동 이름 하나의 부위들(묶음 운동은 여러 개, 못 정하면 빈 배열) */
export function partsOf(name: string): BodyPart[] {
  const out: BodyPart[] = [];
  let prev: BodyPart | null = null;
  for (const piece of name.split('+')) {
    // '레그 익스텐션 + 컬'의 컬처럼 이름 없이 붙은 동작은 앞 동작과 같은 부위(레그 컬)
    const part: BodyPart | null = /^\s*(컬|익스(텐션)?)\s*$/.test(piece) && prev ? prev : (RULES.find(([re]) => re.test(piece))?.[1] ?? null);
    if (part && !out.includes(part)) out.push(part);
    prev = part;
  }
  return out;
}

/** 루틴 하나의 주요 부위: 가장 많이 나온 부위, 두 번째가 그 절반 이상(2번 이상)이면 함께 — '하체·코어'. 정하지 못하면 빈 글자 */
export function routineFocus(names: string[]): string {
  const count = new Map<BodyPart, number>();
  for (const n of names) for (const p of partsOf(n)) count.set(p, (count.get(p) ?? 0) + 1);
  const ranked = [...count].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return '';
  const [first, second] = ranked;
  return second && second[1] >= 2 && second[1] >= first[1] / 2 ? `${first[0]}·${second[0]}` : first[0];
}
