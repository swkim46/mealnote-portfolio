// v2.0 운동 탭: 루틴(트레이너가 정한 계획) · 운동 기록(회원이 실제로 한 것) · 트레이너의 루틴 등록(직접·붙여넣기) · 연결한 시트 자동 반영.
// 계획과 실제는 따로 저장한다 — 루틴을 받았다고 수행으로 치지 않고, 완료 표시한 세트만 운동한 것으로 센다.
// 루틴 양식은 트레이너의 실제 시트를 따른다: 운동 날마다 블록(루틴 1·2·3 — 2026-10-30 사용자 결정으로 '일차' 대신 '루틴 N'), 본 운동 전 필수 동작, 중량·횟수는 글자('32+40', '10/10').
// 조회는 useLive(마지막 정상 값 유지·실패 따로 표시), 저장은 잠근 채 한 번만 보내고 서버 응답으로 확정한다.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { sheetGuideImage, type SheetGuideRole } from '../lib/sheetGuide';
import { copyText as copyAccount } from '../lib/clipboard';
import {
  deleteWorkout,
  fetchRoutine,
  fetchRoutineSheet,
  fetchRoutines,
  fetchWorkout,
  fetchWorkoutCompare,
  fetchWorkoutOverview,
  fetchWorkouts,
  importSheetRecords,
  previewSheetRecords,
  saveRoutine,
  saveWorkout,
  setRoutineSheet,
  SHEETS_ACCOUNT,
  WORKOUT_LIMIT,
  syncRoutineSheet,
  writeSheetRecord,
  type RoutineSheetLink,
  type SheetRecordsPreview,
  type SheetWrite,
  type Routine,
  type RoutineItemInput,
  type WorkoutCompare,
  type WorkoutOverview,
  type WorkoutSession,
  type WorkoutSet,
} from '../lib/api';
import { dateKey, prettyDay, todayKey } from '../lib/dates';
import { useToday } from '../lib/useToday';
import { blockCellValues, formatSheetDate, parseRoutinePaste } from '../lib/routineSheet';
import { focusOf, goalLine } from '../lib/routineText';
import { dayNos, progressOf } from '../lib/workoutStats';
import { restSeconds } from '../lib/restTime';
import { CARDIO_KINDS, CARDIO_RANGE, cardioLabel, cardioNumber, type CardioEntry, type CardioKind } from '../lib/cardio';
import { savingSetup } from '../lib/setupNudge';
import { useLive } from '../lib/useLive';
import { uuid } from '../lib/uuid';
import { PrimaryAction, StaleNotice, StatePanel } from '../ui/kit';
import { Icon } from './Icon';
import { SheetsAccountCode } from './Bits';
import { useSheetDraft } from './Sheet';
import { primeRestBeep } from '../lib/restBeep';
import { RestTimer, type RestRun } from './RestTimer';
import { RoutineTab } from './RoutineViews';
import { WorkoutRecords, type AuxState } from './WorkoutRecords';
import { ExerciseHistory, MemoBox, type Viewer } from './ExerciseFind';
import { useExerciseMemos, useLastSets } from './useExercise';
import { exerciseKey, lastLine, latestWeight, leaveMemo, memoPair, memoStateOf, type MemoState } from '../lib/exercise';

export interface WorkoutData {
  current: Routine | null;
  previous: Routine | null;
  /** 최근 운동 기록(WORKOUT_LIMIT개) */
  workouts: WorkoutSession[];
  sheet: RoutineSheetLink | null;
  /** 서버 요약 — 꾸준함·달력·지금 판의 진행(최근 목록 밖 기록 포함). 받지 못하면 null(루틴 진행은 받아 둔 기록으로, 요약은 다시 불러오기) */
  overview: WorkoutOverview | null;
  /** 서버 비교 — 보이는 기록 카드의 최고 기록·지난번 무게. 받지 못하면 null(최고·오름 표시 없음) */
  compare: WorkoutCompare | null;
  /** 루틴 진행에 쓸 요약 — 지금 세대의 것만(아니면 null — progressOf가 받아 둔 기록만 쓴다). 없으면 overview */
  progressOverview?: WorkoutOverview | null;
  /** 지금 세대의 요약을 기다리는 중 — 목록 밖 진행은 '확인 중' */
  progressChecking?: boolean;
}

/** 루틴 카드가 쓰는 진행(progressOf + 목록 밖 진행을 확인하는 중인지). 목록이 한도로 잘렸을 때만 요약이 필요하다 */
export function progressFor(routine: Routine, data: WorkoutData) {
  const truncated = data.workouts.length >= WORKOUT_LIMIT;
  const ov = data.progressOverview === undefined ? data.overview : data.progressOverview;
  return { ...progressOf(routine, data.workouts, ov, truncated), checking: truncated && !!data.progressChecking };
}

/** 기본 자료: 회원 한 명의 루틴(최신·직전 판)·최근 운동 기록·연결한 시트. version이 바뀌면(저장 뒤) 다시 받는다 */
export function useWorkoutData(memberId: string, version: number) {
  return useLive<Omit<WorkoutData, 'overview' | 'compare'>>(`workout-${memberId}`, String(version), async () => {
    const [r, workouts, sheet] = await Promise.all([fetchRoutines(memberId), fetchWorkouts(memberId), fetchRoutineSheet(memberId)]);
    return { ...r, workouts, sheet };
  });
}

/**
 * 받아 둔 기록 목록의 내용 표시(짧은 해시) — 같은 id라도 무게·완료·날짜가 바뀌면 달라진다. 요약·비교가 쓰는 칸만 본다:
 * 시트 자동 반영은 바뀐 것이 없어도 그 달 시트 기록의 수정 시각(updated_at)을 새로 적어, 전부 보면 반영할 때마다 최고 표시가 깜빡이고 요청이 겹쳤다(적대 검토)
 */
function contentSig(workouts: WorkoutSession[]) {
  const text = JSON.stringify(
    workouts.map((w) => [w.id, w.day, w.started_at, w.day_no, w.routine_id, w.source, w.sets.map((x) => [x.name, x.kg, x.done]), w.cardio.length]),
  );
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${workouts.length}:${(h >>> 0).toString(36)}`;
}

/**
 * 보조 자료: 서버 요약(꾸준함·달력·지금 판의 진행)과 기록 카드 비교(Codex 3차 리뷰 P2·P3). 기본 자료와 따로 받는다 —
 * 함께 기다리면 보조 조회가 늦을 때 루틴·기록·운동 시작까지 막혔다(4차 리뷰 P2). 각각 읽는 중·실패·마지막 정상 값을 따로 가진다.
 *  - 자료 세대(gen): 기록이 바뀌었을 수 있는 일마다 올린다 — 받아 둔 기록의 내용(contentSig)이 바뀔 때, 시트 가져오기·다시 읽기·자동 반영이
 *    끝날 때(invalidate — 목록 밖 기록만 바뀌어도). 요약·비교는 세대가 바뀌면 다시 받는다(Codex v2.2.0 1차 리뷰 P2-1)
 *  - 비교 값은 받은 세대와 기록 내용을 함께 둔다. 지금 세대의 결과일 때만 최고·오름 표시에 쓴다 — 목록 밖 이력이 바뀐 뒤 새 비교를 받지
 *    못하면 옛 비교로 최고를 남기지 않는다(2차 리뷰 P2-2). 같은 세대에서 다시 받기만 실패하면(앱 복귀 등) 마지막 값을 두고 'stale'로 알린다
 *  - 요약은 날짜(today)도 조회 기준에 넣는다: 앱을 켜 둔 채 날이 바뀌면 새 기간으로 다시 받는다(4차 리뷰 P2). 요약 숫자는 새로 받는 동안
 *    마지막 값을 보이고, 루틴 진행은 요약이 옛 값이어도 받아 둔 기록 기간 안의 사실을 되살리지 않는다(progressOf)
 *  - 실패는 지금 조회 기준의 실패만 센다(useLive failedNow) — 기준이 바뀌어 새로 받는 중에는 옛 실패로 안내하지 않는다
 */
export function useWorkoutAux(memberId: string, version: number, workouts: WorkoutSession[] | undefined, routineId: string | null = null) {
  const today = useToday();
  const sig = useMemo(() => (workouts ? contentSig(workouts) : null), [workouts]);
  const ids = workouts ? workouts.map((s) => s.id) : null;
  const [gen, setGen] = useState(0);
  // 세대는 새 기록 목록이 도착했을 때 한 번만 올린다(적대 검토 — 저장 뒤 version과 내용이 차례로 바뀌어 요약·비교를 두 번씩 받았다):
  //  - 저장·시트 연결 변경처럼 version이 바뀌면 '바뀔 예정'으로만 적어 두고, 그 뒤 도착한 목록에서 올린다(연결을 풀면 목록 밖 시트 기록도 지워진다)
  //  - 목록의 내용(contentSig)이 바뀌어 도착해도 올린다(다른 기기의 수정 등)
  //  - 같은 회원의 처음 도착은 바뀐 것으로 치지 않는다(요약·비교는 기본 자료와 함께 받기 시작)
  // 둘 다 화면에 그리기 전(layout effect)에 처리한다 — 새 목록과 직전 세대 요약이 한 번이라도 함께 그려지지 않게(적대 검토)
  const pending = useRef(false);
  const lastVersion = useRef({ memberId, version });
  useLayoutEffect(() => {
    const prev = lastVersion.current;
    lastVersion.current = { memberId, version };
    if (prev.memberId === memberId && prev.version !== version) pending.current = true;
  }, [memberId, version]);
  //  - 지금 루틴 판이 바뀌어 도착해도 올린다(다른 기기에서 트레이너가 새 판을 저장 — 요약의 진행은 옛 판의 것이다 · 적대 검토)
  const seen = useRef<{ memberId: string; sig: string; routineId: string | null } | null>(null);
  useLayoutEffect(() => {
    if (sig === null) return;
    const prev = seen.current;
    seen.current = { memberId, sig, routineId };
    if (!prev || prev.memberId !== memberId) {
      pending.current = false;
      return;
    }
    if (pending.current || prev.sig !== sig || prev.routineId !== routineId) {
      pending.current = false;
      setGen((n) => n + 1);
    }
  }, [memberId, workouts, sig, routineId]);
  const overview = useLive<{ gen: number; data: WorkoutOverview }>(`overview-${memberId}`, `${today}|${gen}`, async () => ({ gen, data: await fetchWorkoutOverview(memberId, today) }));
  // 비교는 목록이 처음 도착할 때와 세대가 바뀔 때만 받는다(목록 내용이 바뀌면 세대도 바뀐다)
  const compare = useLive<{ sig: string | null; gen: number; data: WorkoutCompare | null }>(`compare-${memberId}`, `${sig === null ? 'wait' : 'ready'}|${gen}`, async () => ({
    sig,
    gen,
    data: ids === null ? null : await fetchWorkoutCompare(memberId, ids),
  }));
  const ov = overview.value?.data ?? null;
  const ovCurrent = !!ov && overview.value?.gen === gen;
  const cv = compare.value;
  const cmp = cv && sig !== null && cv.sig === sig && cv.gen === gen ? cv.data : null;
  const state = (has: boolean, current: boolean, failed: boolean): AuxState =>
    has ? (failed ? 'stale' : current ? 'ok' : 'refreshing') : failed ? 'failed' : 'loading';
  return {
    overview: ov,
    overviewState: state(!!ov, ovCurrent, overview.failedNow),
    /**
     * 루틴 진행에 쓸 요약: 지금 세대의 것만(Codex v2.2.0 3차 리뷰 P2). 화면 숫자는 새로 받는 동안 직전 값을 보여도 되지만,
     * 진행(마지막 한 날·한 바퀴)은 자료가 바뀐 뒤 직전 요약으로 확정하지 않는다 — 시트 맞추기로 지운 목록 밖 기록이 대기 중에 남았다
     */
    progressOverview: ovCurrent ? ov : null,
    /** 지금 세대의 요약을 기다리는 중(아직 실패 전) — 목록 밖 진행은 '확인 중' */
    progressChecking: !ovCurrent && !overview.failedNow,
    compare: cmp,
    compareState: state(!!cmp, true, compare.failedNow),
    /** 같은 기준으로 다시 받기(다시 불러오기 버튼·앱 복귀) */
    reload: () => {
      overview.reload();
      compare.reload();
    },
    /** 기록이 바뀌었을 수 있음(시트 가져오기·다시 읽기·자동 반영) — 세대를 올려 둘 다 새로 받고, 받기 전까지 옛 비교를 쓰지 않는다 */
    invalidate: () => setGen((n) => n + 1),
  } as const;
}

/** 루틴 탭 안내: 받아 둔 기록이 한도로 잘렸는데(그 밖의 진행은 요약에서) 지금 쓸 요약이 없고 받기에 실패했을 때만 */
function progressNotice(data: WorkoutData, state: AuxState, retry: () => void) {
  if (!data.current || data.workouts.length < WORKOUT_LIMIT || data.progressOverview || (state !== 'stale' && state !== 'failed')) return null;
  return <StaleNotice text={`최근 ${WORKOUT_LIMIT}개 밖의 운동 진행을 불러오지 못해 최근 기록으로만 보여 드려요.`} onRetry={retry} />;
}

const SHEET_ERROR: Record<string, string> = {
  no_access: '시트를 읽을 수 없어요. FITORY 이메일을 편집자로 공유했는지 확인해 주세요.',
  no_items: '시트에서 운동을 찾지 못했어요. 양식(SET·REPS·중량 제목줄)을 확인해 주세요.',
  no_tab: '시트에 탭이 없어요.',
};
const syncErrorText = (code: string) => (code === 'no_access' ? `시트를 읽을 수 없어요. 시트를 ${SHEETS_ACCOUNT} 에 '편집자'로 공유해 주세요.` : SHEET_ERROR[code] ?? '시트를 읽지 못했어요. 잠시 후 다시 시도해 주세요.');

/**
 * 연결한 시트 자동 반영(2026-10-30 사용자 결정): 운동 탭을 열면 한 번 읽어 보고(서버가 1시간 안이면 건너뜀), 바뀌었으면 새 판을 다시 받는다.
 * '지금 다시 읽기'는 바로 읽는다. 결과는 시작한 회원·화면에 묶는다 — 끝났을 때 화면을 떠났거나 다른 회원으로 바뀌었으면 버린다(Codex v2.0.0 1차 리뷰 2).
 */
/** reload: 시트를 읽은 뒤(기록이 바뀌었을 수 있음 — 요약·비교까지) · reloadBase: 읽지 못했을 때(실패 안내만 새로 — 기록은 그대로) */
function useSheetSync(memberId: string, linked: boolean, reload: () => void, onError?: (msg: string) => void, reloadBase: () => void = reload) {
  const [syncing, setSyncing] = useState(false);
  const req = useRef(0);
  const cur = useRef({ memberId, mounted: true });
  const auto = useRef('');
  useEffect(() => {
    // 다른 회원으로 바뀌면 진행 중인 읽기는 버리고 '읽는 중'도 푼다(버린 요청은 끝나도 상태를 건드리지 않으므로)
    if (cur.current.memberId !== memberId) {
      req.current++;
      setSyncing(false);
    }
    cur.current.memberId = memberId;
  }, [memberId]);
  useEffect(() => {
    const c = cur.current;
    c.mounted = true;
    return () => {
      c.mounted = false;
      req.current++;
    };
  }, []);
  const run = async (force: boolean) => {
    const target = memberId;
    const n = ++req.current;
    const mine = () => cur.current.mounted && n === req.current && cur.current.memberId === target;
    setSyncing(true);
    try {
      const r = await syncRoutineSheet(target, force);
      if (!mine()) return;
      // 시트를 실제로 읽었으면(updated·same) 다시 받는다 — same도 목표 중량·회차 기록이 바뀌었을 수 있다(Codex v2.1 1차 리뷰 P2).
      // 1시간 안이라 읽지 않은 fresh는 그대로(직접 누른 다시 읽기는 마지막으로 읽은 때를 새로)
      if (r.status !== 'fresh' || force) reload();
    } catch (e) {
      if (!mine()) return;
      if (force) onError?.(syncErrorText((e as Error).message));
      reloadBase(); // 실패 안내(last_error)를 화면에 — 기록은 바뀌지 않았으니 요약·비교는 그대로(최고 표시가 깜빡이지 않게)
    } finally {
      if (mine()) setSyncing(false);
    }
  };
  // 이 회원 화면을 처음 열 때 한 번(연결돼 있을 때만). 같은 회원으로 다시 그려도 또 부르지 않는다
  useEffect(() => {
    if (!linked || auto.current === memberId) return;
    auto.current = memberId;
    void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, memberId]);
  return { syncing, syncNow: () => void run(true) };
}

/** 시트 연결 줄: 연결한 시트·마지막으로 읽은 때·읽지 못한 이유. 회원 본인이나 담당 트레이너가 연결·변경하고 바로 다시 읽을 수 있다 */
function SheetLine({ data, onLink, syncing, onSync }: { data: WorkoutData; onLink: () => void; syncing: boolean; onSync: () => void }) {
  const sh = data.sheet;
  return (
    <div className="sheet-line" data-testid="sheet-line">
      <Icon name="list" />
      <span>
        <strong>{sh ? '운동 시트 연결됨' : '운동 시트 연결'}</strong>
        <small>
          {!sh
            ? '트레이너와 쓰는 구글 운동 시트를 연결하면 루틴이 자동으로 들어와요'
            : syncing
              ? '시트를 읽고 있어요…'
              : sh.last_error
                ? (SHEET_ERROR[sh.last_error] ?? '마지막으로 읽지 못했어요. 잠시 후 다시 읽어 주세요.')
                : sh.last_read_at
                  ? `시트 내용이 자동으로 반영돼요 · 마지막으로 읽은 때 ${prettyDay(dateKey(new Date(sh.last_read_at)))} ${new Date(sh.last_read_at).toTimeString().slice(0, 5)}`
                  : '아직 읽지 않았어요'}
        </small>
      </span>
      {sh && (
        <button type="button" className="secondary small" data-testid="sync-sheet" disabled={syncing} onClick={onSync}>
          다시 읽기
        </button>
      )}
      <button type="button" className="text-button" onClick={onLink}>
        {sh ? '바꾸기' : '연결'}
      </button>
    </div>
  );
}

/**
 * 시트의 지난 기록 가져오기(v2.1, 2026-11-02 사용자 피드백 "이전까지의 운동 기록 불러오기"): 미리보기(탭마다 가져올 회차 수·읽지 못한 칸) → 가져오기.
 * 같은 회차는 다시 가져와도 하나, 같은 날·같은 루틴의 앱 기록이 있는 회차는 건너뛴다(서버 sheet_records_save). 회원을 바꾸면 새로(key=회원)
 */
function SheetRecordsImport({ memberId, onImported, onError }: { memberId: string; onImported: (msg: string) => void; onError?: (msg: string) => void }) {
  const [step, setStep] = useState<'closed' | 'loading' | 'saving' | SheetRecordsPreview>('closed');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const open = () => {
    setStep('loading');
    previewSheetRecords(memberId).then(
      (p) => alive.current && setStep(p),
      () => {
        if (!alive.current) return;
        setStep('closed');
        onError?.('시트의 지난 기록을 읽지 못했어요. 시트 공유를 확인하고 다시 시도해 주세요.');
      },
    );
  };
  const save = () => {
    setStep('saving');
    importSheetRecords(memberId).then(
      (r) => {
        if (!alive.current) return;
        setStep('closed');
        onImported(
          // 지운 수는 저장 응답의 실제 수 — 미리보기 뒤에 시트가 바뀌었을 수 있다(Codex v2.1 2차 리뷰)
          [r.saved ? `시트의 지난 기록 ${r.saved}회를 가져왔어요.` : '시트와 맞췄어요.', r.removed ? ` 시트에서 없어진 ${r.removed}회는 앱에서도 지웠어요.` : '', r.skipped ? ` 앱 기록과 겹친 ${r.skipped}회는 앱 기록을 두었어요.` : ''].join(''),
        );
      },
      (e: Error) => {
        if (!alive.current) return;
        setStep('closed');
        // superseded: 그사이 시트를 다시 읽는 작업(다른 기기·자동 반영)이 시작돼 이 가져오기는 멈췄다(Codex v2.1.0 3차 리뷰 P2)
        onError?.(e.message === 'superseded' ? '그사이 시트를 다시 읽기 시작해서 이번 가져오기는 멈췄어요. 잠시 뒤 다시 가져와 주세요.' : '지난 기록을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.');
      },
    );
  };
  if (step === 'closed')
    return (
      <button type="button" className="text-button sheet-records-open" onClick={open}>
        <Icon name="list" /> 시트의 지난 기록 가져오기
      </button>
    );
  if (step === 'loading' || step === 'saving') return <p className="tiny sheet-records-busy">{step === 'loading' ? '시트를 읽고 있어요…' : '가져오는 중…'}</p>;
  const total = step.tabs.reduce((n, t) => n + t.sessions, 0);
  const removes = step.removes ?? 0;
  const problems = step.tabs.flatMap((t) => t.problems);
  return (
    <div className="sheet-records" data-testid="sheet-records">
      <strong>시트의 지난 기록 {total}회</strong>
      {removes > 0 && <p className="tiny">시트에서 없어진 기록 {removes}회는 앱에서도 지워요.</p>}
      {/* 월별 탭이 하나도 없으면 가져올 것은 없고 정리만 한다(Codex v2.1 2차 리뷰 P2) */}
      {step.tabs.length ? (
        <ul>
          {step.tabs.map((t) => (
            <li key={t.tab}>
              {t.tab} 탭 · {t.sessions}회{t.skipped ? ` (앱 기록과 겹친 ${t.skipped}회는 앱 기록을 둠)` : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p className="tiny">시트에 ‘2611’처럼 연월로 시작하는 탭이 없어요.</p>
      )}
      {problems.length > 0 && (
        <details>
          <summary>읽지 못한 칸 {problems.length}곳(가져오지 않음)</summary>
          <ul className="paste-problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="tiny">가져온 기록은 ‘시트 기록’으로 보이고, 고칠 때는 시트에서 고쳐요. 같은 날 앱에 남긴 기록이 있으면 앱 기록을 둬요.</p>
      <div className="word-actions">
        <button type="button" className="text-button" onClick={() => setStep('closed')}>
          취소
        </button>
        {/* 가져올 것이 0개여도 지울 것이 있으면 맞춘다 — 시트에서 지운 지난 기록이 앱에 남지 않게(Codex v2.1 1차 리뷰 P2) */}
        <button type="button" className="secondary small" disabled={!total && !removes} onClick={save}>
          {total ? '가져오기' : '시트와 맞추기'}
        </button>
      </div>
    </div>
  );
}

/**
 * 회원 운동 탭 '루틴'·'운동 기록'(2.1 — 2026-11-03 사용자 확정 시안 3·4). 두 탭이 같은 자료(useWorkoutData)와 시트 자동 반영을 쓰므로 한 부품이 mode로 나눠 그린다
 * (탭을 바꿔도 다시 받지 않게 같은 자리에 그린다).
 *  - 루틴: 요약 → 바뀐 점(새 루틴 한 바퀴 전) → 루틴 카드(가로) → 바뀐 점(한 바퀴 뒤) → 시트 연결 → [루틴 N로 운동 시작] — 보이는 카드의 루틴으로 바로 시작
 *  - 운동 기록: 시트의 지난 기록 가져오기 → 꾸준함·최근 5주 달력 → 달별 기록 카드 → [운동 기록하기]
 * 오늘 이어서 기록할 앱 기록이 있으면 두 탭 모두 [오늘 운동 이어서 기록하기]
 */
export function MemberWorkoutPanel({ memberId, version, mode, onStart, onLinkSheet, onFind, onError }: {
  memberId: string;
  version: number;
  mode: 'routine' | 'records';
  onStart: (data: WorkoutData, session: WorkoutSession | null, dayNo?: number | null) => void;
  onLinkSheet: (data: WorkoutData) => void;
  /** 2.4 운동 찾기 창(그날 기록을 열 때 쓸 자료와 함께) */
  onFind?: (data: WorkoutData) => void;
  onError?: (msg: string) => void;
}) {
  const live = useWorkoutData(memberId, version);
  const memos = useExerciseMemos(memberId);
  const aux = useWorkoutAux(memberId, version, live.value?.workouts, live.value?.current?.id ?? null);
  const data: WorkoutData | undefined = useMemo(
    () => live.value && { ...live.value, overview: aux.overview, compare: aux.compare, progressOverview: aux.progressOverview, progressChecking: aux.progressChecking },
    [live.value, aux.overview, aux.compare, aux.progressOverview, aux.progressChecking],
  );
  // 시트 가져오기·다시 읽기가 끝나면 기본 자료와 요약·비교를 함께 다시 받는다(받아 둔 목록 밖 기록만 바뀌어도 횟수·달력이 맞게 — 1차 리뷰 P2-1)
  const reloadAll = () => {
    live.reload();
    aux.invalidate();
  };
  const sync = useSheetSync(memberId, !!data?.sheet, reloadAll, onError, live.reload);
  const [shown, setShown] = useState<number | null>(null);
  // 루틴 탭을 떠나거나 판이 바뀌면 보던 카드를 잊는다 — 돌아오면 카드가 루틴 1부터 다시 보이므로, 버튼이 한 순간 옛 루틴 번호를 보이지 않게(적대 검토 11-03)
  const currentId = live.value?.current?.id;
  useEffect(() => {
    setShown(null);
  }, [mode, currentId]);
  if (!data) return live.failed ? <StatePanel kind="failed" title="운동 기록을 불러오지 못했어요" onRetry={reloadAll} /> : <StatePanel kind="loading" />;
  // 오늘 이어서 기록할 것은 앱 기록만 — 시트에서 가져온 오늘 회차(읽기 전용)를 열면 새 기록을 남길 수 없다(적대 검토 11-02)
  const today = data.workouts.find((s) => s.day === todayKey() && s.source === 'app') ?? null;
  const days = data.current ? dayNos(data.current.items) : [];
  // 처음(또는 탭·판이 바뀐 직후)에는 카드와 같이 루틴 1(첫 루틴)
  const startDay = mode === 'routine' && days.length > 1 ? (shown !== null && days.includes(shown) ? shown : days[0]) : null;
  const startLabel = today
    ? '오늘 운동 이어서 기록하기'
    : mode === 'records'
      ? '운동 기록하기'
      : startDay
        ? `루틴 ${startDay}로 운동 시작`
        : data.current
          ? '운동 시작'
          : '운동 직접 기록하기';
  return (
    <>
      {/* 다시 불러오기는 요약·비교도 함께(기록이 그대로면 요약·비교 안내가 남았다 — 적대 검토) */}
      {live.failed && <StaleNotice text="운동 기록을 새로 불러오지 못했어요. 이전 기록을 보여 드려요." onRetry={reloadAll} />}
      {mode === 'routine' ? (
        <>
          {/* 최근 30개 밖의 진행은 요약에서 온다 — 받지 못하면 그 사실을 루틴 탭에도 알린다(적대 검토: 루틴 탭은 요약 실패를 몰랐다) */}
          {progressNotice(data, aux.overviewState, aux.reload)}
          {/* 메모를 받지 못하면 '메모 없음'처럼 보이지 않게 알린다 */}
          {data.current && memos.failed && <StaleNotice text="운동 메모를 불러오지 못했어요." onRetry={memos.reload} />}
          {data.current ? (
            <RoutineTab routine={data.current} previous={data.previous} progress={progressFor(data.current, data)} onShow={setShown} memos={{ memos: memos.memos, viewer: 'member' }} />
          ) : (
            <StatePanel kind="empty" title="아직 받은 루틴이 없어요" description="트레이너가 루틴을 등록하거나 운동 시트를 연결하면 여기에 보여요. 그 전에도 직접 기록할 수 있어요." />
          )}
          <SheetLine data={data} onLink={() => onLinkSheet(data)} syncing={sync.syncing} onSync={sync.syncNow} />
        </>
      ) : (
        <>
          {data.sheet && <SheetRecordsImport key={memberId} memberId={memberId} onImported={(msg) => { onError?.(msg); reloadAll(); }} onError={onError} />}
          <WorkoutRecords sessions={data.workouts} overview={data.overview} overviewState={aux.overviewState} compare={data.compare} compareState={aux.compareState} onOpen={(s) => onStart(data, s)} onRetry={aux.reload} onFind={onFind && (() => onFind(data))} />
        </>
      )}
      <PrimaryAction testId="start-workout" onClick={() => onStart(data, today, today ? null : startDay)}>
        <Icon name={today ? 'check' : 'plus'} /> {startLabel}
      </PrimaryAction>
    </>
  );
}

/**
 * 트레이너 회원 화면 '루틴'·'운동 기록'(2.1): 회원 화면과 같은 구성을 읽기 전용으로. 루틴 탭에는 시트 연결·[루틴 등록하기·새 루틴 만들기].
 * 연결한 시트는 화면을 열 때 자동으로 읽어 반영한다(useSheetSync — 결과는 시작한 회원·화면에 묶음).
 */
export function TrainerWorkoutPanel({ memberId, version, mode, onEditRoutine, onOpenSession, onLinkSheet, onFind, onMemo, onError }: {
  memberId: string;
  version: number;
  mode: 'routine' | 'records';
  onEditRoutine: (memberId: string, current: Routine | null, initial?: RoutineDraft) => void;
  onOpenSession: (s: WorkoutSession) => void;
  onLinkSheet: (data: WorkoutData) => void;
  /** 2.4 운동 찾기 창 · 루틴 카드의 '메모 추가'(그 운동의 기록을 열고 바로 메모 쓰기) */
  onFind?: (memberId: string) => void;
  onMemo?: (memberId: string, name: string) => void;
  onError: (msg: string) => void;
}) {
  const live = useWorkoutData(memberId, version);
  const memos = useExerciseMemos(memberId);
  const aux = useWorkoutAux(memberId, version, live.value?.workouts, live.value?.current?.id ?? null);
  const data: WorkoutData | undefined = useMemo(
    () => live.value && { ...live.value, overview: aux.overview, compare: aux.compare, progressOverview: aux.progressOverview, progressChecking: aux.progressChecking },
    [live.value, aux.overview, aux.compare, aux.progressOverview, aux.progressChecking],
  );
  const reloadAll = () => {
    live.reload();
    aux.invalidate();
  };
  const sync = useSheetSync(memberId, !!data?.sheet, reloadAll, onError, live.reload);
  if (!data) return live.failed ? <StatePanel kind="failed" title="운동 기록을 불러오지 못했어요" onRetry={reloadAll} /> : <StatePanel kind="loading" />;
  return (
    <>
      {live.failed && <StaleNotice text="운동 기록을 새로 불러오지 못했어요." onRetry={reloadAll} />}
      {mode === 'routine' ? (
        <>
          {progressNotice(data, aux.overviewState, aux.reload)}
          {data.current && memos.failed && <StaleNotice text="운동 메모를 불러오지 못했어요." onRetry={memos.reload} />}
          {data.current ? (
            <RoutineTab routine={data.current} previous={data.previous} progress={progressFor(data.current, data)} memos={{ memos: memos.memos, viewer: 'trainer', onWrite: onMemo && ((name) => onMemo(memberId, name)) }} />
          ) : (
            <StatePanel kind="empty" title="아직 등록한 루틴이 없어요" description="운동 시트를 연결하거나 직접 등록하면 회원 운동 탭에 보여요." />
          )}
          <SheetLine data={data} onLink={() => onLinkSheet(data)} syncing={sync.syncing} onSync={sync.syncNow} />
          <PrimaryAction testId="edit-routine" onClick={() => onEditRoutine(memberId, data.current)}>
            <Icon name="plus" /> {data.current ? '새 루틴 만들기' : '루틴 등록하기'}
          </PrimaryAction>
        </>
      ) : (
        <>
          {data.sheet && <SheetRecordsImport key={memberId} memberId={memberId} onImported={(msg) => { onError(msg); reloadAll(); }} onError={onError} />}
          <WorkoutRecords sessions={data.workouts} overview={data.overview} overviewState={aux.overviewState} compare={data.compare} compareState={aux.compareState} onOpen={onOpenSession} onRetry={aux.reload} onFind={onFind && (() => onFind(memberId))} />
        </>
      )}
    </>
  );
}


/** 시트 연결(회원·트레이너): 우리 서비스 계정에 '편집자'로 공유한 뒤(v2.1 — 앱 기록을 시트에 쓴다. 2.0은 '뷰어') 링크를 붙여 넣으면 바로 연결하고 읽어 반영(확인 코드 없음·자동 반영, 2026-10-30 사용자 결정) */
/**
 * 운동 시트 연결 창(2026-11-03 사용자 요청 — "설명이 복잡하고 한 번에 이해하기 어렵다, 설명과 연결 화면이 이어져 있지 않다"):
 * 한 화면에 ① FITORY 이메일을 시트에 추가 ② 시트 링크 붙여 넣기 ③ 연결하기를 단계 카드로 두고, 단계마다 '그림으로 보기'를 그 자리에서 펼친다
 * (예전에는 설명 글 두 줄과 따로 넘어가는 그림 안내 화면이었다). 자세한 규칙은 맨 아래 접힌 칸에
 */
export function SheetLinkForm({ role, memberId, link: current, onDone, onError }: { role: SheetGuideRole; memberId: string; link: RoutineSheetLink | null; onDone: (msg: string) => void; onError: (msg: string) => void }) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  useSheetDraft(!!link.trim(), busy);
  const [open, setOpen] = useState<0 | 1 | 2>(0);
  const [copied, setCopied] = useState<'' | 'ok' | 'fail'>('');
  const [pasteFail, setPasteFail] = useState(false);
  async function save(value: string) {
    if (busy) return;
    setBusy(true);
    try {
      await savingSetup(() => setRoutineSheet(memberId, value));
      if (!value) return onDone('시트 연결을 풀었어요.');
      // 연결하는 순간 바로 읽어 반영한다(2026-10-30 자동 반영). 읽기에 실패해도 연결은 남고, 이유를 알린다
      try {
        const r = await syncRoutineSheet(memberId, true);
        onDone(r.status === 'updated' ? '시트를 연결하고 루틴을 가져왔어요.' : '시트를 연결했어요. 루틴은 바뀐 것이 없어요.');
      } catch (e) {
        onDone(`시트를 연결했어요. 다만 ${syncErrorText((e as Error).message)}`);
      }
    } catch (e) {
      const c = (e as Error).message;
      onError(c === 'sheet_taken' ? '이미 다른 회원에게 연결된 시트예요. 내 시트가 맞다면 운영자에게 알려 주세요.' : c === 'bad_sheet' ? '구글 시트 링크를 확인해 주세요.' : '저장하지 못했어요. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }
  const paste = async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (t) setLink(t);
      setPasteFail(!t);
    } catch {
      setPasteFail(true); // 붙여넣기 권한이 없으면 칸을 길게 눌러 붙여 넣는다
    }
  };
  const pics = (steps: number[]) => (
    <div className="sheet-step-pics">
      {steps.map((n) => (
        <img key={n} src={sheetGuideImage(role, n)} alt="운동 시트 연결 화면 예시" width={720} height={1400} loading="lazy" decoding="async" />
      ))}
    </div>
  );
  return (
    <fieldset className="sheet-link-form form-lock" disabled={busy} data-testid="sheet-link-form">
      <p className="hint">트레이너와 쓰는 구글 운동 시트를 연결하면 그 달 루틴이 자동으로 들어오고, 앱에 남긴 운동 기록이 시트에도 적혀요.</p>
      <ol className="sheet-connect">
        <li className="sheet-step">
          <b className="sheet-step-no">1</b>
          <div>
            <strong>시트에 FITORY 이메일을 편집자로 추가</strong>
            <p className="tiny">이메일 복사 → 구글 시트 → 공유 → 붙여 넣기 → 편집자 → 보내기</p>
            <div className="guide-copy">
              <SheetsAccountCode />
              <button type="button" className="secondary small" onClick={() => void copyAccount(SHEETS_ACCOUNT).then((ok) => setCopied(ok ? 'ok' : 'fail'))}>
                이메일 복사
              </button>
              <span className="tiny" aria-live="polite">
                {copied === 'ok' ? '이메일을 복사했어요.' : copied === 'fail' ? '복사하지 못했어요. 이메일을 길게 눌러 복사해 주세요.' : ''}
              </span>
            </div>
            <button type="button" className="text-button" aria-expanded={open === 1} onClick={() => setOpen(open === 1 ? 0 : 1)}>
              {open === 1 ? '그림 접기' : '그림으로 보기'}
            </button>
            {open === 1 && pics([1, 2])}
          </div>
        </li>
        <li className="sheet-step">
          <b className="sheet-step-no">2</b>
          <div>
            <strong>시트 링크를 복사해 붙여 넣기</strong>
            <p className="tiny">공유 창의 ‘링크 복사’ 또는 주소창의 주소</p>
            <div className="sheet-link-input">
              <input value={link} aria-label="시트 링크" placeholder="시트 링크 붙여 넣기" onChange={(e) => setLink(e.target.value)} />
              <button type="button" className="secondary small" onClick={() => void paste()}>
                붙여넣기
              </button>
            </div>
            {pasteFail && <p className="tiny">칸을 길게 눌러 붙여 넣어 주세요.</p>}
            <button type="button" className="text-button" aria-expanded={open === 2} onClick={() => setOpen(open === 2 ? 0 : 2)}>
              {open === 2 ? '그림 접기' : '그림으로 보기'}
            </button>
            {open === 2 && pics([3])}
          </div>
        </li>
        <li className="sheet-step">
          <b className="sheet-step-no">3</b>
          <div>
            <button type="button" className="primary full" disabled={busy || !link.trim()} onClick={() => void save(link.trim())}>
              시트 연결하기
            </button>
          </div>
        </li>
      </ol>
      <details className="sheet-more">
        <summary>연결하면 어떻게 되나요?</summary>
        <ul>
          <li>그 달 탭(예: 2611)의 루틴이 바로 들어오고, 시트를 고치면 운동 탭을 열 때 다시 읽어요.</li>
          <li>운동 기록을 저장하면 그 달 탭의 빈 회차 칸에 적어요. 시트에 직접 적거나 고친 값은 그대로 두고, 앱에서 적은 칸은 기록을 고치면 함께 바뀌고 완료 표시를 끄면 비워져요.</li>
          <li>{role === 'member' ? '연결은 회원이 해도 되고 트레이너가 해도 돼요.' : '회원이 직접 연결해도 돼요.'} 시트 하나는 회원 한 명에게만 연결할 수 있어요.</li>
          <li>구글 시트 그림은 설명을 위한 예시예요. 기기에 따라 메뉴 이름과 위치가 조금 다를 수 있어요.</li>
        </ul>
      </details>
      {current && (
        <button type="button" className="text-button" disabled={busy} onClick={() => void save('')}>
          연결 풀기
        </button>
      )}
    </fieldset>
  );
}

// auto: 루틴 무게로 채운 뒤 아직 최신 무게로 바꾸지 않았고 손대지도 않은 세트(2.4.1 — 이전 기록을 받으면 한 번 바꾼다)
type Row = { key: string; item_id: string | null; name: string; set_no: number; kg: string; reps: string; done: boolean; auto?: boolean };
const toRows = (sets: WorkoutSet[]): Row[] => sets.map((s) => ({ key: uuid(), item_id: s.item_id, name: s.name, set_no: s.set_no, kg: s.kg ?? '', reps: s.reps ?? '', done: s.done }));
const fromRoutine = (r: Routine, dayNo: number): Row[] =>
  r.items
    .filter((i) => i.day_no === dayNo)
    .flatMap((i) =>
      Array.from({ length: i.sets ?? 1 }, (_, n) => ({
        key: uuid(),
        item_id: i.id,
        name: i.name,
        set_no: n + 1,
        // 계획의 중량·횟수를 글자 그대로 미리 채운다(v2.1: '32+40'·'10/10'도) — 회원은 실제로 한 값으로 고친다.
        // 무게는 이전 기록을 받으면 최신 무게로 바꾼다(auto, 2.4.1)
        kg: i.weight,
        reps: i.reps,
        done: false,
        auto: true,
      })),
    );
type CardioRow = { key: string; kind: CardioKind; minutes: string; km: string; speed: string };
const toCardioRows = (list: CardioEntry[]): CardioRow[] => list.map((c) => ({ key: uuid(), kind: c.kind, minutes: String(c.minutes), km: c.km === null ? '' : String(c.km), speed: c.speed === null ? '' : String(c.speed) }));
const blankCardio = (): CardioRow => ({ key: uuid(), kind: 'run', minutes: '', km: '', speed: '' });
/** 클립보드 복사(https·localhost에서만 된다 — 안 되면 실패로) */
const copyText = (text: string) => ('clipboard' in navigator ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no_clipboard')));
/** 쉬는 시간 타이머 하나(끝나는 시각 = 지금 + 초) */
const restRun = (name: string, sec: number): RestRun => ({ name, until: Date.now() + sec * 1000, total: sec * 1000 });
/** 시트 쓰기 응답을 기다리는 시간 — 넘으면 쓰지 못한 것으로 보고 복사 길을 보인다 */
const SHEET_WRITE_WAIT_MS = 20000;
/** 시트에 쓴 결과 한 줄(저장 안내 뒤에 붙임) */
const sheetNote = (w: SheetWrite) => {
  if (w.status === 'written') return ` 시트 ${w.tab} 탭 ${w.col}열에도 적었어요.`;
  if (w.status !== 'partial') return '';
  // 앱이 쓴 칸이 하나도 없으면(모두 이미 적힌 칸) '적었어요'라고 하지 않는다
  return [w.owned === 0 ? '' : ' 시트에도 적었어요.', w.skipped?.length ? ` 시트에 없는 운동 ${w.skipped.length}개는 앱에만 남겼어요.` : '', w.kept?.length ? ` 이미 적힌 칸 ${w.kept.length}개는 그대로 두었어요.` : ''].join('');
};
const sheetFailReason = (w: SheetWrite | 'timeout' | null, dayNo: number) =>
  // 응답을 기다리다 넘김·서버가 보낸 쓰기의 결과를 모름(unknown): 이미 적혔을 수 있다
  w === 'timeout' || w?.status === 'unknown'
    ? '기록은 저장했어요. 시트에 적은 결과를 아직 확인하지 못했어요. 이미 적혔을 수 있으니 시트를 먼저 확인하고, 비어 있을 때만 아래 값을 붙여 넣어 주세요.'
    : w?.status === 'denied'
    ? `기록은 저장했어요. 시트에 바로 쓰려면 시트 공유에서 FITORY 이메일(${SHEETS_ACCOUNT})을 ‘편집자’로 바꿔 주세요. 지금은 아래 값을 복사해 붙여 넣을 수 있어요.`
    : w?.status === 'no_column'
      ? `기록은 저장했어요. 시트의 루틴 ${dayNo}에 빈 회차 칸이 없어 쓰지 못했어요. 아래 값을 복사해 붙여 넣어 주세요.`
      : w?.status === 'busy'
        ? '기록은 저장했어요. 먼저 보낸 시트 쓰기가 아직 끝나지 않아 이번 기록은 쓰지 못했어요. 잠시 뒤 다시 저장하거나 아래 값을 붙여 넣어 주세요.'
        : '기록은 저장했어요. 시트에 쓰지 못했어요. 아래 값을 복사해 붙여 넣거나, 잠시 뒤 다시 저장해 주세요.';
/**
 * 시트용 복사 글: 그 루틴 블록의 운동 순서대로 한 줄에 한 칸(시트 쓰기와 같은 칸 값 — blockCellValues, 안 한 운동은 빈 줄).
 * 끝의 빈 줄은 뺀다 — 붙여 넣을 때 그 아래 칸을 빈 값으로 덮지 않게
 */
const sheetCopyText = (routine: Routine, dayNo: number, sets: WorkoutSet[]) =>
  blockCellValues(routine.items.filter((i) => i.day_no === dayNo), sets)
    .join('\n')
    .replace(/\n+$/, '');
/** 숫자·소수점·공백 말고 다른 글자(+, /, 초 등)가 있는지 — 있으면 그 운동은 처음부터 일반 키보드로 연다 */
const hasSymbol = (v: string) => /[^\d.\s]/.test(v);
const numOrNull = (s: string, max: number, int: boolean) => {
  const t = s.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= max && (!int || Number.isInteger(n)) ? n : NaN;
};

/**
 * 운동 기록(회원). 새 기록은 오늘 할 루틴을 먼저 고른다(2026-10-30 사용자 요청 — 루틴이 하나면 바로). 고른 루틴의 목표가 미리 채워지고,
 * 실제로 한 값으로 고쳐 완료를 표시한다.
 * 세션 id는 이 창을 열 때 한 번 만든다(이어서 기록이면 그 세션) — 저장 응답이 끊겨 다시 보내도 기록이 두 개 생기지 않는다.
 */
export function WorkoutForm({ memberId, viewer = 'member', data, session, initialDay, readOnly: readOnlyProp, onSaved, onDeleted, onError }: { memberId: string; viewer?: Viewer; data: WorkoutData | null; session: WorkoutSession | null; initialDay?: number | null; readOnly?: boolean; onSaved: (msg: string) => void; onDeleted?: () => void; onError: (msg: string) => void }) {
  // 시트에서 가져온 기록(v2.1)은 앱에서 고치지 않는다 — 시트에서 고치면 다음 가져오기 때 반영된다
  const fromSheet = session?.source === 'sheet';
  const readOnly = readOnlyProp || fromSheet;
  const routine = session ? (data?.current?.id === session.routine_id ? data.current : data?.previous?.id === session.routine_id ? data.previous : null) : (data?.current ?? null);
  const days = routine ? dayNos(routine.items) : [];
  const [sessionId, setSessionId] = useState(() => session?.id ?? uuid());
  const [day, setDay] = useState(() => session?.day ?? todayKey());
  const [routineId, setRoutineId] = useState<string | null>(() => (session ? session.routine_id : (routine?.id ?? null)));
  // 이 기기가 읽은 기록의 수정 시각(새 기록이면 null) — 다른 기기가 그 뒤에 고쳤으면 서버가 'conflict'로 거절한다(리뷰 3).
  // 저장 요청 id는 '보내는 저장 내용'에 묶는다: 같은 내용을 다시 보내면 같은 id(응답이 끊긴 재전송은 한 번만),
  // 내용이 하나라도 다르면(세트·일차·대상 기록 무엇이든) 새 id — 입력 종류마다 갱신을 챙기지 않아도 된다(Codex v2.0.0 2차 리뷰 2)
  const [base, setBase] = useState<string | null>(() => session?.updated_at ?? null);
  const sent = useRef<{ id: string; body: string } | null>(null);
  const saveIdFor = (body: string) => {
    if (sent.current?.body !== body) sent.current = { id: uuid(), body };
    return sent.current.id;
  };
  const [clash, setClash] = useState<{ kind: 'conflict'; latest: WorkoutSession } | { kind: 'gone' } | null>(null);
  // 루틴 탭에서 보던 카드의 루틴으로 시작하면(initialDay, 2.1) 그 루틴을 미리 고른다 — 다른 루틴은 아직 적은 것이 없을 때 고르기에서 바꾼다
  const [dayNo, setDayNo] = useState<number | null>(() => session?.day_no ?? (initialDay && days.includes(initialDay) ? initialDay : days.length === 1 ? days[0] : null));
  const [rows, setRows] = useState<Row[]>(() => (session ? toRows(session.sets) : routine && dayNo ? fromRoutine(routine, dayNo) : []));
  // 유산소(v2.1): 시간(분) 필수, 거리·속도는 필요에 따라. '유산소만'을 고르면 루틴 없이 유산소만 기록한다
  const [cardio, setCardio] = useState<CardioRow[]>(() => (session ? toCardioRows(session.cardio) : []));
  const [cardioOnly, setCardioOnly] = useState(false);
  const [touched, setTouched] = useState(false);
  // 저장하지 않은 입력이 있는가. touched는 저장 뒤에도 남아 루틴 바꾸기를 막는다. 세트 완료처럼 칸을 거치지 않는 입력도 여기로 창에 알린다
  const [unsavedEdit, setUnsavedEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 운동마다 '기호' 입력(일반 키보드)을 켰는지. 정하지 않았으면 목표·적은 값에 기호가 있을 때 켠다(v2.1 사용자 피드백 11-02)
  const [symbolic, setSymbolic] = useState<Record<string, boolean>>({});
  // 쉬는 시간 타이머: 세트 완료를 누르면 그 운동의 쉬는 시간으로 시작(v2.1)
  const [rest, setRest] = useState<RestRun | null>(null);
  // 시트에 쓰지 못함(v2.1): 기록은 저장됐다. 이유와 시트에 붙여 넣을 값을 보여 주고, 닫으면 저장 완료 안내
  const [sheetFail, setSheetFail] = useState<{ reason: string; text: string; date: string; msg: string } | null>(null);
  const [writing, setWriting] = useState(false);
  useSheetDraft(unsavedEdit || !!newName.trim(), writing);
  // 시트 쓰기만 실패한 화면을 ✕·뒤로 닫아도 저장 안내와 목록 새로 받기는 빠지지 않는다. ✕는 저장 중에도 닫으므로 닫힌 뒤에 난 결과도 여기로 온다
  const savedNotice = useRef<string | null>(null);
  const closed = useRef(false);
  const onSavedNow = useRef(onSaved);
  useEffect(() => {
    onSavedNow.current = onSaved;
  });
  const tellSaved = () => {
    const msg = savedNotice.current;
    savedNotice.current = null;
    if (msg !== null) onSavedNow.current(msg);
  };
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      tellSaved();
    };
  }, []);
  const groups = useMemo(() => {
    const g: { name: string; rows: Row[] }[] = [];
    for (const r of rows) {
      const last = g[g.length - 1];
      if (last && last.name === r.name) last.rows.push(r);
      else g.push({ name: r.name, rows: [r] });
    }
    return g;
  }, [rows]);
  // 2.4 지난번(결정 2-2 다): 운동마다 마지막으로 한 날과 그날 가장 무거운 세트. 누르면 그 운동의 기록을 이 창 안에서 연다(쓰던 입력은 그대로).
  // 받지 못하면 줄을 숨기고 입력은 막지 않는다
  const names = useMemo(() => [...new Set(groups.map((g) => g.name))], [groups]);
  const last = useLastSets(memberId, names, day, sessionId);
  // 2.4.1(2026-11-10 사용자 의견 '처음 불러온 무게가 아니라 최신 무게'): 루틴으로 채운 세트의 무게를 그 운동을 마지막으로 한 기록의 무게로 바꾼다.
  // 루틴의 무게는 시트 첫 회차 칸이라 회차가 지나도 그대로였다. 기록이 오기 전에 손댄 세트와 기록이 없는 운동은 루틴 무게 그대로 둔다.
  // 사용자가 적은 것이 아니므로 '쓰던 내용'으로 치지 않는다(그리는 중에 한 번 바꾼다 — 바꾼 세트는 auto가 꺼져 다시 바뀌지 않는다)
  if (last.ready && rows.some((r) => r.auto)) setRows((rs) => rs.map((r) => (r.auto ? { ...r, kg: latestWeight(last.sets[r.name], r.set_no) ?? r.kg, auto: false } : r)));
  // 2.4 동작별 메모: 세트 아래에 트레이너 칸·내 칸. 회원은 여기서 자기 칸을 쓴다(결정 3-3 가). 트레이너가 보는 기록 창에서는 읽기만
  const memos = useExerciseMemos(memberId);
  const [history, setHistory] = useState<string | null>(null);
  // 운동별 기록에서 돌아오면 보던 자리로(창에서 밀리는 것은 dialog — 폼을 숨기는 동안 위치를 잃었다, 넘기기 전 적대 검토 E)
  const formRef = useRef<HTMLFieldSetElement>(null);
  const scrollBack = useRef<number | null>(null);
  const openHistory = (name: string) => {
    scrollBack.current = formRef.current?.closest('dialog')?.scrollTop ?? null;
    setHistory(name);
  };
  useLayoutEffect(() => {
    if (history !== null || scrollBack.current === null) return;
    const d = formRef.current?.closest('dialog');
    if (d) d.scrollTop = scrollBack.current;
    scrollBack.current = null;
  }, [history]);
  // 메모 칸들의 상태: 운동 기록 저장(창이 닫힘)·루틴 바꾸기(칸이 사라짐) 전에 쓰는 중이면 묻는다(넘기기 전 적대 검토 F · Codex v2.4.0 1차 리뷰 P2-2).
  // 메모 저장 중이면 그대로 진행한다 — 메모 저장 결과는 lib/memoSaves가 따로 받는다(운동 기록 저장의 성공과 별개 · 2차 리뷰 1절)
  const memoStates = useRef(new Map<string, MemoState>());
  const memoOk = (ask: string) => leaveMemo(memoStateOf(memoStates.current.values()), ask);
  const memoDraftOk = () => memoOk('저장하지 않은 메모가 있어요. 메모는 버리고 운동 기록만 저장할까요?');
  const edit = (fn: (rs: Row[]) => Row[]) => {
    setTouched(true);
    setUnsavedEdit(true);
    setRows(fn);
  };
  const set = (key: string, patch: Partial<Row>) => edit((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch, auto: false } : r)));
  // 서버가 받는 범위(운동마다 세트 50개 · 기록 하나에 세트 200개)를 화면에서 먼저 지킨다 — 저장 때 '연결 실패'로 보이지 않게
  const addSet = (name: string) => {
    const same = rows.filter((r) => r.name === name);
    if ((same[same.length - 1]?.set_no ?? 0) >= 50) return onError('한 운동은 50세트까지 기록할 수 있어요.');
    if (rows.length >= 200) return onError('한 번에 200세트까지 기록할 수 있어요.');
    edit((rs) => {
      const same = rs.filter((r) => r.name === name);
      const last = same[same.length - 1];
      const at = rs.lastIndexOf(last) + 1;
      const row: Row = { key: uuid(), item_id: last?.item_id ?? null, name, set_no: (last?.set_no ?? 0) + 1, kg: last?.kg ?? '', reps: last?.reps ?? '', done: false };
      return [...rs.slice(0, at), row, ...rs.slice(at)];
    });
  };
  const removeSet = (key: string) => edit((rs) => rs.filter((r) => r.key !== key));
  const editCardio = (fn: (cs: CardioRow[]) => CardioRow[]) => {
    setTouched(true);
    setUnsavedEdit(true);
    setCardio(fn);
  };
  const setCardioRow = (key: string, patch: Partial<CardioRow>) => editCardio((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const addCardio = () => editCardio((cs) => (cs.length >= 20 ? cs : [...cs, blankCardio()]));
  const addExercise = () => {
    const name = newName.trim().slice(0, 60);
    if (!name) return;
    if (rows.length >= 200) return onError('한 번에 200세트까지 기록할 수 있어요.');
    edit((rs) => [...rs, { key: uuid(), item_id: null, name, set_no: 1, kg: '', reps: '', done: false }]);
    setNewName('');
  };
  // 루틴을 고르면(바꾸면) 그 루틴의 목표로 채운다 — 이미 적은 값이 있으면 날리지 않게 막는다
  const pickDay = (d: number) => {
    if (!routine || (d === dayNo && !cardioOnly)) return;
    if (touched) return onError('이미 적은 기록이 있어요. 다른 루틴은 저장한 뒤 새로 시작해 주세요.');
    if (!memoOk('저장하지 않은 메모가 있어요. 메모는 버리고 루틴을 바꿀까요?')) return;
    // '유산소만'이 자동으로 만든 빈 유산소 칸은 치운다 — 남겨 두면 근력 기록 저장이 '시간을 적어 주세요'로 막힌다
    if (cardioOnly) setCardio((cs) => cs.filter((c) => c.minutes.trim() || c.km.trim() || c.speed.trim()));
    setCardioOnly(false);
    setRoutineId(routine.id);
    setDayNo(d);
    setRows(fromRoutine(routine, d));
  };
  /** 오늘은 유산소만: 루틴 없이 유산소 칸 하나로 시작 */
  const pickCardioOnly = () => {
    if (cardioOnly) return;
    if (touched) return onError('이미 적은 기록이 있어요. 유산소만 기록하려면 저장한 뒤 새로 시작해 주세요.');
    if (!memoOk('저장하지 않은 메모가 있어요. 메모는 버리고 유산소만 기록할까요?')) return;
    setCardioOnly(true);
    setRoutineId(null);
    setDayNo(null);
    setRows([]);
    setCardio((cs) => (cs.length ? cs : [blankCardio()]));
  };
  const done = rows.filter((r) => r.done).length;
  const planned = routine && dayNo ? routine.items.filter((i) => i.day_no === dayNo) : [];

  async function save(over?: { base: string | null; sessionId: string; day: string }) {
    if (busy) return;
    // 중량·횟수는 적은 글자 그대로(앞뒤 공백만 지움, 빈 칸은 null) — 칸이 30자까지만 받는다
    const sets: WorkoutSet[] = rows.map((r) => ({ item_id: r.item_id, name: r.name, set_no: r.set_no, kg: r.kg.trim() || null, reps: r.reps.trim() || null, done: r.done }));
    // 유산소: 시간은 꼭(1～600분), 거리(km)·속도(km/h)는 적은 것만. 서버와 같은 범위를 먼저 확인한다
    const cardioOut: CardioEntry[] = [];
    for (const c of cardio) {
      const name = cardioLabel(c.kind);
      const minutes = cardioNumber(c.minutes, ...CARDIO_RANGE.minutes);
      const km = cardioNumber(c.km, ...CARDIO_RANGE.km);
      const speed = cardioNumber(c.speed, ...CARDIO_RANGE.speed);
      if (minutes === null || Number.isNaN(minutes)) return onError(`${name} 시간을 1～600분 사이로 적어 주세요.`);
      if (Number.isNaN(km)) return onError(`${name} 거리(km)를 확인해 주세요.`);
      if (Number.isNaN(speed)) return onError(`${name} 속도(km/h)를 확인해 주세요.`);
      cardioOut.push({ kind: c.kind, minutes: Math.round(minutes * 10) / 10, km: km === null ? null : Math.round(km * 100) / 100, speed: speed === null ? null : Math.round(speed * 10) / 10 });
    }
    const target = over ?? { base, sessionId, day };
    const payload = { sessionId: target.sessionId, day: target.day, routineId, dayNo, sets, cardio: cardioOut, finished: (sets.length > 0 || cardioOut.length > 0) && sets.every((s) => s.done), base: target.base };
    const saveId = saveIdFor(JSON.stringify(payload));
    setBusy(true);
    const earlierNotice = savedNotice.current;
    savedNotice.current = null;
    try {
      const updated = await saveWorkout({ ...payload, saveId });
      setBase(updated);
      setClash(null);
      const msg = `운동 기록을 저장했어요. ${[sets.length && `완료 ${sets.filter((s) => s.done).length}세트`, cardioOut.length && `유산소 ${cardioOut.length}개`].filter(Boolean).join(' · ') || '완료 0세트'}`;
      // 시트에서 온 루틴의 기록이면 시트의 그 회차 칸에도 쓴다(v2.1). 쓰지 못하면 창을 닫지 않고 복사해 붙여 넣는 길을 보인다
      // 시트 쓰기: 루틴이 있는 기록이면 부른다. 화면에 받아 둔 최근 두 판(routine)에 없는 옛 판도 서버가 기록 id로 판을 찾아 정한다(시트 판이 아니면 not_sheet) —
      // 표시용 데이터에 따라 쓰기를 건너뛰지 않게(Codex v2.1 1차 리뷰 P2). 완료 세트가 없어도 이미 저장한 기록을 다시 저장하면 부른다 — 완료를 끈 운동의 칸을 비우도록.
      // 화면에 받아 둔 '시트에 쓴 자리'(sheet_col)로 고르지 않는다: 결과를 모른 채 끝난 쓰기는 자리가 늦게 적히고, 새 기록 창은 저장 뒤에도 받아 둔 기록이 없다(적대 검토 F5)
      const sheetRoutine = routine && routine.id === routineId ? routine.source === 'sheet' : routineId !== null;
      if (sheetRoutine && routineId !== null && dayNo !== null && (sets.some((x) => x.done) || target.base !== null)) {
        setWriting(true);
        const w = await Promise.race([
          writeSheetRecord(target.sessionId).catch(() => null),
          new Promise<'timeout'>((r) => window.setTimeout(() => r('timeout'), SHEET_WRITE_WAIT_MS)),
        ]).finally(() => setWriting(false));
        if (!w || w === 'timeout' || w.status === 'denied' || w.status === 'no_column' || w.status === 'busy' || w.status === 'unknown') {
          // 붙여 넣을 값은 그 기록의 판 순서로 — 옛 판이면 따로 받는다
          const src = routine && routine.id === routineId ? routine : await fetchRoutine(routineId).catch(() => null);
          setSheetFail({ reason: sheetFailReason(w, dayNo), text: src ? sheetCopyText(src, dayNo, sets) : '', date: formatSheetDate(target.day, []), msg });
          setUnsavedEdit(false);
          savedNotice.current = msg;
          if (closed.current) tellSaved();
          return;
        }
        return onSaved(msg + sheetNote(w));
      }
      onSaved(msg);
    } catch (e) {
      savedNotice.current = earlierNotice;
      if (closed.current) tellSaved();
      const code = (e as Error).message;
      if (code === 'conflict' || code === 'gone') {
        // 입력은 그대로 두고 최신 기록을 받아 고르게 한다
        const latest = code === 'conflict' ? await fetchWorkout(target.sessionId).catch(() => undefined) : null;
        if (latest === undefined) onError('다른 기기에서 먼저 고친 기록이에요. 연결을 확인하고 다시 열어 주세요.');
        else setClash(latest ? { kind: 'conflict', latest } : { kind: 'gone' });
      } else if (code === 'bad_day') onError('새 운동 기록은 최근 7일 안의 날짜로만 만들 수 있어요.');
      else if (code === 'bad_cardio') onError('유산소 기록을 확인해 주세요. 시간은 1～600분이에요.');
      else onError('운동 기록을 저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }
  /** 충돌: 최신 기록으로 바꾸기(내 입력은 버림) */
  // 서버의 기록 하나를 이 창의 편집 상태로 그대로 옮긴다 — 저장 내용을 이루는 값(대상 기록·날짜·일차·세트·수정 시각)을 한꺼번에.
  // 일부만 바꾸면 이전 초안의 값(예: 고른 일차)이 최신 세트와 섞여 저장된다(Codex v2.0.0 4차 리뷰)
  const applySession = (latest: WorkoutSession) => {
    setSessionId(latest.id);
    setDay(latest.day);
    setRoutineId(latest.routine_id);
    setDayNo(latest.day_no);
    setRows(toRows(latest.sets));
    setCardio(toCardioRows(latest.cardio));
    setBase(latest.updated_at);
    setTouched(false);
    setUnsavedEdit(false);
    setClash(null);
  };
  /** 충돌: 그쪽(서버의 최신) 기록으로 바꾸기 — 내 입력은 버림 */
  // 그쪽 기록을 불러오면 운동 칸이 새로 만들어져 메모 칸도 사라진다 — 쓰던 메모를 먼저 묻는다(적대 검토 3차 R1)
  const takeLatest = (latest: WorkoutSession) => {
    if (memoOk('저장하지 않은 메모가 있어요. 메모는 버리고 그쪽 기록을 불러올까요?')) applySession(latest);
  };
  /** 충돌: 최신 기록을 본 뒤 내 입력으로 저장 / 지워진 기록: 새 기록으로 저장(오늘 날짜) */
  const keepMine = () => {
    if (!clash || !memoDraftOk()) return;
    if (clash.kind === 'conflict') {
      setBase(clash.latest.updated_at);
      void save({ base: clash.latest.updated_at, sessionId, day });
    } else {
      const id = uuid();
      const today = todayKey();
      setSessionId(id);
      setDay(today);
      setBase(null);
      void save({ base: null, sessionId: id, day: today });
    }
  };

  async function remove() {
    if (!session || busy) return;
    if (!confirmDelete) return setConfirmDelete(true);
    // 기록을 지우면 창이 닫힌다 — 메모는 기록이 아니라 운동에 붙으므로 쓰던 메모를 먼저 묻는다(3차 R3)
    if (!memoOk('저장하지 않은 메모가 있어요. 메모는 버리고 이 기록을 지울까요?')) return;
    setBusy(true);
    try {
      await deleteWorkout(session.id);
      savedNotice.current = null;
      onDeleted?.();
    } catch {
      onError('삭제하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  const goalOf = (name: string) => planned.find((i) => i.name === name);
  const isSymbolic = (g: { name: string; rows: Row[] }) => {
    const goal = goalOf(g.name);
    return symbolic[g.name] ?? (hasSymbol(goal?.weight ?? '') || hasSymbol(goal?.reps ?? '') || g.rows.some((r) => hasSymbol(r.kg) || hasSymbol(r.reps)));
  };
  /** 세트 완료를 표시하면 그 운동의 쉬는 시간 타이머를 새로 시작한다(완료를 끌 때는 그대로) */
  const complete = (r: Row, done: boolean) => {
    set(r.key, { done });
    const sec = done ? restSeconds(goalOf(r.name)?.rest ?? '') : null;
    if (sec) {
      primeRestBeep(); // 아이폰은 누르는 순간에만 소리 장치를 켤 수 있다 — 끝날 때 울리도록 미리 깨운다
      setRest(restRun(r.name, sec));
    }
  };
  // 루틴이 둘 이상인 새 기록: 오늘 할 루틴을 고르기 전에는 고르기만 보인다
  const choosing = !session && !readOnly && days.length > 1 && dayNo === null && !cardioOnly;
  const lastOf = (name: string) => lastLine(last.sets, name);
  return (
    <>
    {history !== null && (
      <ExerciseHistory
        memberId={memberId}
        target={{ type: 'strength', key: exerciseKey(history), name: history }}
        viewer={viewer}
        memoEditable={viewer === 'trainer' || !readOnlyProp}
        backLabel="운동 기록으로"
        onBack={() => setHistory(null)}
        onError={onError}
      />
    )}
    {/* 운동별 기록을 여는 동안 기록 폼은 숨기기만 한다 — 쓰던 입력·쉬는 시간 타이머가 그대로 남는다 */}
    <fieldset className="workout-form form-lock" disabled={busy} data-saved={unsavedEdit ? undefined : ''} data-testid="workout-form" ref={formRef} style={history !== null ? { display: 'none' } : undefined}>
      <p className="workout-form-head">
        <span>
          {day === todayKey() ? '오늘' : prettyDay(day)}
          {dayNo && session ? ` · 루틴 ${dayNo}` : ''}
        </span>
        <span className="tiny">
          {[rows.length || !cardio.length ? `완료 ${done}/${rows.length}세트` : '', cardio.length ? `유산소 ${cardio.length}개` : '', routine && !cardioOnly ? routine.title : ''].filter(Boolean).join(' · ')}
        </span>
      </p>
      {!session && !readOnly && days.length > 0 && (
        <div className="routine-pick" role="group" aria-label="오늘 할 루틴">
          <strong>{dayNo || cardioOnly ? '오늘 할 운동' : '오늘 할 루틴을 골라 주세요'}</strong>
          <div className="routine-pick-options">
            {days.map((d) => (
              <button key={d} type="button" aria-pressed={dayNo === d && !cardioOnly} onClick={() => pickDay(d)}>
                루틴 {d}
                {routine && focusOf(routine.items, d) && <span className="routine-pick-focus">{focusOf(routine.items, d)}</span>}
              </button>
            ))}
            <button type="button" aria-pressed={cardioOnly} onClick={pickCardioOnly}>
              유산소만
            </button>
          </div>
        </div>
      )}
      {!readOnly && !choosing && !cardioOnly && rows.length > 0 && <p className="hint">루틴은 계획이에요. 실제로 한 중량·횟수로 고치고, 끝낸 세트만 완료로 표시해 주세요.</p>}
      {!choosing && rows.length > 0 && memos.failed && <StaleNotice text="운동 메모를 불러오지 못했어요." onRetry={memos.reload} />}
      {!choosing && groups.map((g) => {
        const goal = goalOf(g.name);
        const sym = isSymbolic(g);
        return (
          <section key={g.name + g.rows[0].key} className="workout-group" aria-label={g.name}>
            <div className="workout-group-head">
              <span>
                <strong>{g.name}</strong>
                {goal && goalLine(goal) && <small>{goalLine(goal)}</small>}
                {lastOf(g.name) && (
                  <button type="button" className="last-line" aria-label={`${g.name} 이전 기록 보기: ${prettyDay(lastOf(g.name)!.day)} ${lastOf(g.name)!.text}`} onClick={() => openHistory(g.name)}>
                    이전 기록 {prettyDay(lastOf(g.name)!.day)} · {lastOf(g.name)!.text} ›
                  </button>
                )}
              </span>
              {!readOnly && (
                <span className="workout-group-actions">
                  {/* 숫자 키패드에는 +, / 가 없다 — 누르면 이 운동의 칸이 일반 키보드로 열린다 */}
                  <button type="button" className="text-button" aria-pressed={sym} aria-label={`${g.name} 기호 입력`} onClick={() => setSymbolic((m) => ({ ...m, [g.name]: !sym }))}>
                    기호
                  </button>
                  <button type="button" className="text-button" onClick={() => addSet(g.name)}>
                    세트 추가
                  </button>
                </span>
              )}
            </div>
            <div className="set-grid">
              <span className="set-label">세트</span>
              <span className="set-label">kg</span>
              <span className="set-label">횟수</span>
              <span className="set-label">완료</span>
              {g.rows.map((r) => (
                <div key={r.key} className="set-row">
                  <span>{r.set_no}</span>
                  <input inputMode={sym ? 'text' : 'decimal'} maxLength={30} aria-label={`${g.name} ${r.set_no}세트 중량`} value={r.kg} disabled={readOnly} onChange={(e) => set(r.key, { kg: e.target.value })} />
                  <input inputMode={sym ? 'text' : 'numeric'} maxLength={30} aria-label={`${g.name} ${r.set_no}세트 횟수`} value={r.reps} disabled={readOnly} onChange={(e) => set(r.key, { reps: e.target.value })} />
                  <input type="checkbox" className="set-done" aria-label={`${g.name} ${r.set_no}세트 완료`} checked={r.done} disabled={readOnly} onChange={(e) => complete(r, e.target.checked)} />
                  {!readOnly && g.rows.length > 1 && (
                    <button type="button" className="icon-button set-remove" aria-label={`${g.name} ${r.set_no}세트 빼기`} onClick={() => removeSet(r.key)}>
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
            {memos.memos && (
              <MemoBox
                key={g.name}
                memberId={memberId}
                name={g.name}
                viewer={viewer}
                pair={memoPair(memos.memos, g.name)}
                source={memos.memos}
                stamp={memos.stamp}
                hidden={history !== null}
                onDraft={(st) => memoStates.current.set(g.name + g.rows[0].key, st)}
                editable={viewer === 'member' && !readOnlyProp}
                compact
                onError={onError}
              />
            )}
          </section>
        );
      })}
      {!choosing && cardio.length > 0 && (
        <section className="workout-group cardio-box" aria-label="유산소">
          <div className="workout-group-head">
            <span>
              <strong>유산소</strong>
              {!readOnly && <small>시간은 꼭, 거리·속도는 필요한 것만 적어요</small>}
            </span>
          </div>
          {cardio.map((c, i) => (
            <div key={c.key} className="cardio-row">
              <div className="cardio-row-top">
                <select aria-label={`유산소 ${i + 1} 종류`} value={c.kind} disabled={readOnly} onChange={(e) => setCardioRow(c.key, { kind: e.target.value as CardioKind })}>
                  {CARDIO_KINDS.map((k) => (
                    <option key={k.code} value={k.code}>
                      {k.label}
                    </option>
                  ))}
                </select>
                {!readOnly && (
                  <button type="button" className="icon-button" aria-label={`유산소 ${i + 1} 빼기`} onClick={() => editCardio((cs) => cs.filter((x) => x.key !== c.key))}>
                    ×
                  </button>
                )}
              </div>
              <div className="cardio-fields">
                <label>
                  <span>시간(분)</span>
                  <input inputMode="decimal" maxLength={6} aria-label={`유산소 ${i + 1} 시간(분)`} value={c.minutes} disabled={readOnly} onChange={(e) => setCardioRow(c.key, { minutes: e.target.value })} />
                </label>
                <label>
                  <span>거리(km)</span>
                  <input inputMode="decimal" maxLength={6} aria-label={`유산소 ${i + 1} 거리(km)`} value={c.km} disabled={readOnly} onChange={(e) => setCardioRow(c.key, { km: e.target.value })} />
                </label>
                <label>
                  <span>속도(km/h)</span>
                  <input inputMode="decimal" maxLength={5} aria-label={`유산소 ${i + 1} 속도(km/h)`} value={c.speed} disabled={readOnly} onChange={(e) => setCardioRow(c.key, { speed: e.target.value })} />
                </label>
              </div>
            </div>
          ))}
        </section>
      )}
      {!readOnly && !choosing && (
        <div className="add-exercise">
          <input aria-label="운동 이름" placeholder="운동 추가 (예: 런지)" maxLength={60} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button type="button" className="secondary small" disabled={!newName.trim()} onClick={addExercise}>
            추가
          </button>
        </div>
      )}
      {!readOnly && !choosing && cardio.length < 20 && (
        <button type="button" className="text-button" onClick={addCardio}>
          <Icon name="plus" /> 유산소 추가
        </button>
      )}
      {clash && (
        <div className="workout-clash" role="status" data-testid="workout-clash">
          {clash.kind === 'conflict' ? (
            <>
              <p>
                다른 기기에서 이 기록을 먼저 고쳤어요(그쪽 기록: 완료 {clash.latest.sets.filter((x) => x.done).length}/{clash.latest.sets.length}세트). 내 입력은 그대로 있어요.
              </p>
              <div className="word-actions">
                <button type="button" className="text-button" disabled={busy} onClick={() => takeLatest(clash.latest)}>
                  그쪽 기록 불러오기
                </button>
                <button type="button" className="secondary small" disabled={busy} onClick={keepMine}>
                  내 입력으로 저장
                </button>
              </div>
            </>
          ) : (
            <>
              <p>다른 기기에서 지운 기록이에요. 내 입력은 그대로 있어요.</p>
              <div className="word-actions">
                <button type="button" className="secondary small" disabled={busy} onClick={keepMine}>
                  오늘 새 기록으로 저장
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {sheetFail && (
        <div className="workout-clash sheet-fail" role="status" data-testid="sheet-fail">
          <p>{sheetFail.reason}</p>
          <label className="field">
            시트의 루틴 {dayNo} 회차 칸에 붙여 넣을 값(위에서부터 시트의 운동 순서, 빈 줄은 안 한 운동)
            <textarea readOnly rows={Math.min(8, sheetFail.text.split('\n').length)} value={sheetFail.text} />
          </label>
          <p className="tiny">운동한 날 칸에는 {sheetFail.date}를 적어 주세요.</p>
          <div className="word-actions">
            <button
              type="button"
              className="text-button"
              onClick={() => {
                savedNotice.current = null;
                onSaved(sheetFail.msg);
              }}
            >
              닫기
            </button>
            <button
              type="button"
              className="secondary small"
              onClick={() =>
                void copyText(sheetFail.text).then(
                  () => onError('복사했어요. 시트에서 이 회차의 첫 운동 칸을 누르고 붙여 넣어 주세요.'),
                  () => onError('복사하지 못했어요. 위 칸의 값을 길게 눌러 복사해 주세요.'),
                )
              }
            >
              시트용으로 복사
            </button>
          </div>
        </div>
      )}
      {writing && (
        <p className="tiny" role="status">
          기록을 저장했어요. 시트에도 적는 중이에요…
        </p>
      )}
      {fromSheet && <p className="hint">시트에서 가져온 기록이에요. 고치려면 시트에서 고쳐 주세요. 다음에 시트를 읽을 때 반영돼요.</p>}
      {!readOnly && !clash && !choosing && (
        <button type="button" className="primary full" disabled={busy || (!rows.length && !cardio.length)} onClick={() => memoDraftOk() && void save()}>
          운동 기록 저장
        </button>
      )}
      {!readOnly && rest && <RestTimer run={rest} onChange={setRest} />}
      {!readOnly && session && (
        <button type="button" className={`text-button ${confirmDelete ? 'danger' : ''}`} disabled={busy} onClick={() => void remove()}>
          {confirmDelete ? '한 번 더 누르면 이 기록을 지워요' : '이 기록 지우기'}
        </button>
      )}
    </fieldset>
    </>
  );
}

export interface RoutineDraft {
  title: string;
  warmup: string;
  items: RoutineItemInput[];
  source: Routine['source'];
  sourceRef: string;
  problems?: string[];
}

type ItemRow = RoutineItemInput & { key: string; setsText: string; dayText: string };
const toItemRows = (items: RoutineItemInput[]): ItemRow[] => items.map((i) => ({ ...i, key: uuid(), setsText: i.sets === null ? '' : String(i.sets), dayText: String(i.day_no) }));
const blankItem = (day_no = 1): RoutineItemInput => ({ day_no, name: '', weight: '', reps: '', sets: 3, rest: '', note: '' });

/**
 * 트레이너: 담당 회원의 새 루틴 판. 직접 쓰거나, 시트에서 복사해 붙여 넣거나, 연결한 시트에서 가져온 내용(initial)을 확인·고친 뒤 저장한다.
 * 저장 전에는 회원에게 보이지 않는다(미리보기).
 */
export function RoutineForm({ memberId, current, initial, onSaved, onError }: { memberId: string; current: Routine | null; initial?: RoutineDraft; onSaved: () => void; onError: (msg: string) => void }) {
  const [title, setTitle] = useState(initial?.title ?? current?.title ?? '');
  const [goal, setGoal] = useState('');
  const [reason, setReason] = useState('');
  const [warmup, setWarmup] = useState(initial?.warmup ?? current?.warmup ?? '');
  const [rows, setRows] = useState<ItemRow[]>(() => toItemRows(initial ? initial.items : current ? current.items : [blankItem()]));
  const [source, setSource] = useState<Routine['source']>(initial?.source ?? 'manual');
  const [sourceRef] = useState(initial?.sourceRef ?? '');
  const [paste, setPaste] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>(initial?.problems ?? []);
  const [busy, setBusy] = useState(false);
  // 표로 읽기·줄 지우기는 칸을 거치지 않는다. 행 번호(key)는 다시 읽으면 달라져도 내용이 달라진 것이다
  const shape = JSON.stringify([title, goal, reason, warmup, rows]);
  const [startShape] = useState(shape);
  useSheetDraft(shape !== startShape || !!paste?.trim(), busy);
  const set = (key: string, patch: Partial<ItemRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  function readPaste() {
    const r = parseRoutinePaste(paste ?? '');
    setProblems(r.problems);
    if (!r.items.length) return setProblems((p) => [...p, '운동 줄을 찾지 못했어요. 운동·SET·REPS·중량 칸을 함께 복사해 주세요.']);
    setRows(toItemRows(r.items));
    if (r.warmup) setWarmup(r.warmup);
    setSource('paste');
    setPaste(null);
  }

  async function save() {
    if (busy) return;
    if (!title.trim()) return onError('루틴 이름을 적어 주세요.');
    const items: RoutineItemInput[] = [];
    for (const r of rows) {
      if (!r.name.trim()) continue;
      const sets = numOrNull(r.setsText, 20, true);
      const dayNo = numOrNull(r.dayText, 10, true);
      if (Number.isNaN(sets) || sets === 0) return onError(`${r.name}의 세트를 확인해 주세요.`);
      if (dayNo === null || Number.isNaN(dayNo) || dayNo === 0) return onError(`${r.name}의 루틴 번호(1～10)를 확인해 주세요.`);
      items.push({ day_no: dayNo, name: r.name.trim(), weight: r.weight.trim(), reps: r.reps.trim(), sets, rest: r.rest.trim(), note: r.note });
    }
    if (!items.length) return onError('운동을 하나 이상 넣어 주세요.');
    setBusy(true);
    try {
      await saveRoutine(memberId, { title: title.trim(), goal: goal.trim(), reason: reason.trim(), warmup: warmup.trim(), items, source, sourceRef });
      onSaved();
    } catch {
      onError('저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="routine-form form-lock" disabled={busy} data-testid="routine-form">
      {initial?.source === 'sheet' && <p className="hint">시트 '{initial.sourceRef}' 탭에서 읽은 내용이에요. 확인하고 고친 뒤 저장하면 회원에게 보여요.</p>}
      <label className="field">
        루틴 이름
        <input maxLength={60} value={title} placeholder="예) 26년 11월 루틴" onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        이번 목표
        <textarea rows={2} maxLength={300} value={goal} placeholder="예) 지난달보다 세트를 한 개 늘렸어요. 자세와 횟수를 지켜 주세요." onChange={(e) => setGoal(e.target.value)} />
      </label>
      {current && (
        <label className="field">
          바꾼 이유
          <textarea rows={2} maxLength={300} value={reason} placeholder="예) 스쿼트 자세가 안정돼 중량을 올렸어요." onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
      <label className="field">
        본 운동 전 필수 동작
        <textarea rows={3} maxLength={1000} value={warmup} placeholder="예) 1. 폼롤링 2. 오픈 북 스트레칭 10씩 X 2SET" onChange={(e) => setWarmup(e.target.value)} />
      </label>
      {paste === null ? (
        <button type="button" className="secondary small" onClick={() => setPaste('')}>
          시트에서 복사해 붙여넣기
        </button>
      ) : (
        <div className="paste-box">
          <label className="field">
            시트에서 루틴 번호·SET·REPS·중량 제목줄과 운동 줄을 함께 복사해 붙여 넣으세요
            <textarea rows={5} value={paste} placeholder={'1\n\tSET\tREPS\t중량\n데드버그+풀오버\t3\t20\t9'} onChange={(e) => setPaste(e.target.value)} />
          </label>
          <div className="word-actions">
            <button type="button" className="text-button" onClick={() => setPaste(null)}>
              취소
            </button>
            <button type="button" className="secondary small" disabled={!paste.trim()} onClick={readPaste}>
              표로 읽기
            </button>
          </div>
        </div>
      )}
      {problems.length > 0 && (
        <ul className="paste-problems" role="status">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="routine-rows">
        <div className="routine-row head" aria-hidden="true">
          <span>루틴</span>
          <span>운동</span>
          <span>세트</span>
          <span>횟수</span>
          <span>중량</span>
          <span>휴식(분)</span>
        </div>
        {rows.map((r, i) => (
          <div key={r.key} className="routine-row">
            <input aria-label={`${i + 1}번 루틴 번호`} inputMode="numeric" value={r.dayText} onChange={(e) => set(r.key, { dayText: e.target.value })} />
            <input aria-label={`${i + 1}번 운동 이름`} maxLength={60} value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} />
            <input aria-label={`${i + 1}번 세트`} inputMode="numeric" value={r.setsText} onChange={(e) => set(r.key, { setsText: e.target.value })} />
            <input aria-label={`${i + 1}번 횟수`} maxLength={30} value={r.reps} onChange={(e) => set(r.key, { reps: e.target.value })} />
            <input aria-label={`${i + 1}번 중량`} maxLength={30} value={r.weight} onChange={(e) => set(r.key, { weight: e.target.value })} />
            <input aria-label={`${i + 1}번 쉬는 시간(분)`} inputMode="decimal" maxLength={10} value={r.rest} onChange={(e) => set(r.key, { rest: e.target.value })} />
            <button type="button" className="icon-button" aria-label={`${i + 1}번 운동 빼기`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
              ×
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="text-button" disabled={rows.length >= 80} onClick={() => setRows((rs) => [...rs, ...toItemRows([blankItem(Number(rs[rs.length - 1]?.dayText) || 1)])])}>
        <Icon name="plus" /> 운동 추가
      </button>
      <button type="button" className="primary full" disabled={busy} onClick={() => void save()}>
        {current ? '새 루틴으로 저장' : '루틴 저장'}
      </button>
      {current && <p className="tiny">저장하면 새 루틴이 되고, 지난 루틴과 이미 남긴 운동 기록은 그대로 남아요.</p>}
    </fieldset>
  );
}
