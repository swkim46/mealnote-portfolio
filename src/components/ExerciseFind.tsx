// v2.4 운동 찾기 · 운동별 기록 · 동작별 메모(문서/기획/2_4_범위와_결정_261107.md 2·3절, 회원 의견 11-05·11-06).
//  - 운동 찾기: 운동 기록 탭의 '운동 기록' 제목 줄 오른쪽에서 연다(결정 2-1 나). 처음에는 자주 한 운동, 글자를 치면 이름에 그 글자가 든 운동만
//  - 운동별 기록: 가장 무거운 무게·기록 수·마지막 날·메모·날짜별 세트. 서버에서 그 운동의 기록을 처음 것까지 찾는다(목록의 최근 30개 제한과 무관)
//  - 운동 기록 창의 '지난번' 줄(결정 2-2 다)도 같은 운동별 기록을 창 안에서 연다. 쓰던 입력은 그대로 남는다
//  - 메모: 회원 칸·트레이너 칸을 따로(결정 3-2). 각자 자기 칸만 고친다. 200자. 저장하면 바로 저장되고 운동 기록 저장과는 따로
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BACK_LEVEL, useBackLayer } from '../lib/backNav';
import { fetchCardioHistory, fetchExerciseHistory, fetchExerciseList, fetchWorkout, type CardioDay, type ExerciseDay, type ExerciseMemo, type WorkoutSession } from '../lib/api';
import { cardioDetail, cardioLabel, type CardioKind } from '../lib/cardio';
import { prettyDay, todayKey, weekdayShort } from '../lib/dates';
import { byMonth, findExercises, historySummary, leaveMemo, matchRange, MEMO_MAX, memoPair, setsLine, type MemoPair, type MemoState } from '../lib/exercise';
import { useLive } from '../lib/useLive';
import { StatePanel, StaleNotice } from '../ui/kit';
import { Icon } from './Icon';
import { useSheetDraft } from './Sheet';
import { saveMemo, useExerciseMemos, useMemoSaves } from './useExercise';
import { dropMemoFailure, type MemoOwner } from '../lib/memoSaves';

export type Viewer = 'member' | 'trainer';
export type ExerciseTarget = { type: 'strength'; key: string; name: string } | { type: 'cardio'; kind: CardioKind };

/** 메모 칸 이름: 회원에게는 트레이너·내 메모, 트레이너에게는 내 메모·회원 메모 */
const slotLabel = (viewer: Viewer, author: ExerciseMemo['author']) => (author === viewer ? '내 메모' : author === 'trainer' ? '트레이너' : '회원 메모');

/**
 * 한 운동의 메모 두 칸. 남이 쓴 칸은 읽기만, 내 칸은 고치기·추가(editable일 때).
 * startEditing: 트레이너가 루틴 카드의 '메모 추가'로 열었을 때 바로 쓰기.
 * onDraft: 메모 상태(없음·쓰는 중·저장 중)와 글이 바뀔 때마다 알린다 — 이 칸을 담은 층·폼은 떠나기 전에 쓰는 중이면 묻는다.
 * 저장 중에는 떠나도 된다(사용자 결정 11-09): 저장 결과는 lib/memoSaves가 받고, 칸이 닫힌 뒤 실패하면 이 칸이 다시 보일 때
 * 다른 글을 쓰고 있지 않으면 그 글을 편집 칸으로 바로 되돌린다(Codex v2.4.0 3차 리뷰 — 카드·버튼을 거치지 않는다)
 */
export function MemoBox({ memberId, name, viewer, pair, source, stamp, hidden = false, editable, startEditing = false, compact = false, onDraft, onError }: {
  memberId: string;
  name: string;
  viewer: Viewer;
  pair: MemoPair;
  /** pair를 만든 메모 목록(받을 때마다 바뀌는 값) — 저장 뒤 새 목록이 오면 방금 저장한 값 대신 그 목록을 쓴다 */
  source: unknown;
  /** 그 목록을 받기 시작한 번호(useExerciseMemos) — 저장하지 못한 메모가 서버에 이미 있는지는 실패 뒤에 받은 목록으로만 본다 */
  stamp: number;
  /** 이 칸이 가려져 있다(운동 기록 창 위에 운동별 기록을 연 동안). 가려진 동안 끝난 저장의 실패는 닫힌 칸처럼 모듈에 맡긴다 */
  hidden?: boolean;
  editable: boolean;
  startEditing?: boolean;
  compact?: boolean;
  onDraft?: (state: MemoState) => void;
  onError: (msg: string) => void;
}) {
  const fromServer = viewer === 'member' ? pair.member : pair.trainer;
  const other = viewer === 'member' ? pair.trainer : pair.member;
  // 방금 저장한 내 칸: 저장 뒤 메모 목록을 새로 받기 전에는 이 값을 보인다(다시 받기가 실패하면 저장한 글이 안 보였다).
  // 저장 전에 시작한 조회의 늦은 응답은 useLive가 버리므로, 저장 뒤 새로 온 목록은 이 저장을 담고 있다
  const [saved, setSaved] = useState<{ body: string; at: string | null; source: unknown } | null>(null);
  const own: Pick<ExerciseMemo, 'author' | 'body' | 'updated_at'> | null =
    saved && saved.source === source ? (saved.at ? { author: viewer, body: saved.body, updated_at: saved.at } : null) : fromServer;
  const ownAt = own?.updated_at ?? null;
  const fieldId = useId();
  // 저장이 끝난 때의 목록과 그때 보이는 내 칸의 수정 시각(저장 중에 다른 조회·저장이 끝났을 수 있다)
  const sourceNow = useRef(source);
  const shownAt = useRef(ownAt);
  useEffect(() => {
    sourceNow.current = source;
    shownAt.current = ownAt;
  });
  const startNow = startEditing && editable;
  const [editing, setEditing] = useState(startNow);
  const [text, setText] = useState(startNow ? (own?.body ?? '') : '');
  // 쓰기 시작할 때 본 내 칸의 수정 시각 = 저장 기준. 쓰는 동안 목록이 새로 와도(앱으로 돌아옴·다른 곳의 저장) 바꾸지 않는다 —
  // 바꾸면 그사이 다른 기기가 고친 글을 보지도 못하고 덮어썼다(넘기기 전 적대 검토 B)
  const [base, setBase] = useState<string | null>(startNow ? ownAt : null);
  // 다른 기기가 먼저 고쳐 거절된 뒤: 새로 받은 내 칸을 '보인 그대로' 붙잡아 두고, 다음 저장은 그 판의 수정 시각으로 보낸다(검토 C).
  // 그 뒤 또 바뀌어도 보이는 글이 몰래 바뀌지 않는다 — 서버가 다시 거절하면 그때 새 판을 붙잡는다(2차 N2)
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<{ body: string | null; at: string | null } | null>(null);
  // 새로 받은 판이 오면 그 자리에서 붙잡는다(렌더 중 갱신 — 이전 렌더의 값에서 이끌어 낸 상태)
  if (conflict && latest === null && ownAt !== base) setLatest({ body: own?.body ?? null, at: ownAt });
  const latestShown = conflict && latest !== null;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  // 진행 중인 내 저장: 이 칸이 닫히거나 가려지면 결과를 lib/memoSaves에 맡긴다 — 가려진 칸이 실패를 맡으면 사용자가 보는 칸에는
  // 아무것도 없고, 그대로 창을 닫으면 글을 잃었다(넘기기 전 적대 검토 P2-A: 운동 기록 창의 메모 저장 중 '이전 기록'을 연 경우)
  const owner = useRef<MemoOwner | null>(null);
  const alive = useRef(true);
  const hiddenNow = useRef(hidden);
  useEffect(() => {
    hiddenNow.current = hidden;
    if (owner.current) owner.current.alive = !hidden;
  }, [hidden]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (owner.current) owner.current.alive = false;
    };
  }, []);
  // 이 칸에서 저장하지 못한 메모(닫힌 뒤 실패한 저장)와 다른 칸에서 진행 중인 저장 — 열려 있는 동안 와도 바로 보인다(Codex v2.4.0 2차 리뷰 P3-1)
  const slot = { memberId, name, viewer };
  const saves = useMemoSaves(slot, editable);
  // 서버에 이미 그 글이 있으면(저장은 됐는데 응답만 끊김) 되살릴 것이 없다. 실패 뒤에 받기 시작한 목록으로만 판단한다 —
  // 방금 이 칸이 저장한 값(saved)이나 실패 전에 받은 목록은 서버의 지금 글이 아닐 수 있다(검토 P3-B)
  const fresh = !(saved && saved.source === source) && !!saves.failure && stamp > saves.failure.stamp;
  const settled = fresh && !!saves.failure && saves.failure.body === (fromServer?.body ?? '');
  useEffect(() => {
    if (settled && saves.failure) dropMemoFailure(slot, saves.failure.seq);
    // slot은 매번 새 객체 — 실패 번호로만 다시 본다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, saves.failure?.seq]);
  const failure = settled ? null : saves.failure;
  const dirty = editing && text.trim() !== (own?.body ?? '');
  // 저장하지 못한 메모 되돌리기: 이 칸이 보이고, 다른 글을 쓰고 있지 않으면 그 글을 편집 칸에 바로 넣는다(Codex v2.4.0 3차 리뷰 — 카드·버튼 없이).
  //  - 다른 글을 쓰는 중이면 그 글을 바꾸지 않는다(그 글의 저장이 성공하면 옛 실패는 지워지고, 취소하면 그때 되돌린다)
  //  - 되돌린 글을 손대지 않은 채(untouched)면 '다른 글'이 아니다 — 더 새 실패가 오면 그 글로 바꾸고, 실패가 없어지면 편집을 닫는다
  //  - 이 메모의 저장이 진행 중이면 기다린다(그 결과가 정한다 — 옛 실패를 먼저 넣으면 더 새 글의 실패를 가렸다, 넘기기 전 적대 검토 3차 P2-1)
  //  - 저장 기준은 보낼 때의 것 그대로 — 새로 받은 수정 시각을 붙이면 그사이 다른 기기가 고친 글을 몰래 덮었다(2차 리뷰 P2-1).
  //    지금 저장된 메모가 그 기준과 다를 때만 충돌 안내와 최신 글을 함께 보인다
  //  - 남은 실패는 그 글의 저장이 성공하거나 취소해야 지워진다 — 되돌린 채 창을 닫으면 다음에 다시 되돌린다(적대 검토 P3-D)
  const [restored, setRestored] = useState<{ seq: number; body: string } | null>(null);
  const untouched = !!restored && editing && text === restored.body;
  if (failure && editable && !hidden && !busy && !saves.saving && !(dirty && !untouched) && restored?.seq !== failure.seq) {
    const changed = ownAt !== failure.base;
    setRestored({ seq: failure.seq, body: failure.body });
    setText(failure.body);
    setBase(failure.base);
    setConflict(changed);
    setLatest(changed ? { body: own?.body ?? null, at: ownAt } : null);
    setNote(
      changed
        ? '저장된 메모가 변경됐어요. 최신 내용을 확인한 뒤 다시 저장해 주세요.'
        : failure.body
          ? '저장하지 못한 메모예요. 확인한 뒤 다시 저장해 주세요.'
          : '메모를 지우지 못했어요. 이대로 저장하면 지워져요.',
    );
    setEditing(true);
  }
  // 편집 끝내기 — 취소·변경 없는 저장·저장 성공·닫힌 칸의 실패·되돌린 실패가 없어짐이 모두 같은 상태를 정리한다
  // (Codex v2.4.0 4차 리뷰 P3-2: 변경 없는 저장만 편집을 닫고 되돌린 표시를 남겨, 다음에 연 칸에 고르지 않은 옛 실패가 다시 들어왔다)
  const endEdit = () => {
    setRestored(null);
    setEditing(false);
    setConflict(false);
    setLatest(null);
    setNote('');
  };
  // 되돌린 글을 손대지 않았는데 그 실패가 없어졌으면(실패 뒤 받은 목록에 같은 글 · 다른 칸에서 더 나중의 저장 성공) 편집을 닫는다
  if (untouched && !failure && !busy) endEdit();
  // 떠날 때 잃는 글만 '쓰던 내용'으로 알린다: 저장 중인 글(결과는 화면 밖에서 받음)과 손대지 않은 되돌린 글(남은 실패로 다음에 다시 되돌림)은
  // 떠나도 사라지지 않는다(적대 검토 3차 P3-4 — 매번 '버리고 이동할까요?'를 물었다)
  const keptElsewhere = untouched && failure?.seq === restored?.seq;
  const loses = dirty && !keptElsewhere;
  useSheetDraft(loses && !busy);
  // 층·폼에 알리는 상태(날짜 열기 대기 중 새로 쓴 글을 가리려고 글이 바뀔 때마다도 알린다 — P2-1)
  const draftNow = useRef(onDraft);
  useEffect(() => {
    draftNow.current = onDraft;
  });
  useEffect(() => {
    draftNow.current?.(busy ? 'saving' : loses ? 'dirty' : 'clean');
  }, [loses, busy, text]);
  useEffect(() => () => draftNow.current?.('clean'), []);
  // 사용자가 쓰기를 시작했을 때만 편집 칸으로 옮겨 간다 — 저절로 되돌릴 때 옮기면 다른 칸에 치던 글자가 메모로 들어갔다(적대 검토 3차 P3-2)
  const focusOnEdit = useRef(startNow);
  useEffect(() => {
    if (editing && focusOnEdit.current) box.current?.focus();
    focusOnEdit.current = false;
  }, [editing]);
  const open = () => {
    focusOnEdit.current = true;
    setRestored(null);
    setText(own?.body ?? '');
    setBase(ownAt);
    setConflict(false);
    setLatest(null);
    setNote('');
    setEditing(true);
  };
  // 되돌린 글을 취소하거나 저장된 글과 같게 고쳐 저장하면 그 실패도 버린다(뜻이 분명한 행동 — 다시 되돌리지 않는다).
  // 지우는 것은 되돌린 그 실패 번호뿐이다 — 그사이 더 새 실패가 왔으면 남아 다음에 되돌린다
  const dropRestored = () => {
    if (restored) dropMemoFailure(slot, restored.seq);
  };
  const cancel = () => {
    dropRestored();
    endEdit();
  };
  const save = async () => {
    if (busy) return;
    const body = text.trim();
    if (body.length > MEMO_MAX) return setNote(`${MEMO_MAX}자까지 쓸 수 있어요.`);
    const sendBase = latestShown ? latest.at : base;
    if (!conflict && body === (own?.body ?? '')) {
      dropRestored();
      return endEdit();
    }
    setBusy(true);
    const run = saveMemo(slot, body, sendBase, onError);
    owner.current = run.owner;
    if (hiddenNow.current) run.owner.alive = false;
    const r = await run.done;
    if (owner.current === run.owner) owner.current = null;
    // 이 칸이 닫혔으면 결과는 lib/memoSaves가 맡았다(실패한 글은 다음에 이 칸에서 보인다)
    if (!alive.current) return;
    setBusy(false);
    if (!r.current) return;
    // 가려진 동안 실패했다 — 실패는 모듈이 맡았거나(보이는 칸에 '저장하지 못한 메모'), 그사이 더 나중의 저장이 있어 버려졌다.
    // 이 칸은 쓰기를 닫는다(돌아오면 남은 실패로 보인다)
    if (!r.ok && (r.kept || hiddenNow.current)) return endEdit();
    if (r.ok) {
      // 이 성공을 화면 값으로 쓰는 것은 그 칸에서 더 나중의 저장이 없었고, 지금 보이는 내 칸이 보낼 때의 판이거나 이 저장의 결과일 때뿐이다.
      // 그사이 다른 칸·기기의 더 새 메모를 받았으면 그 메모를 둔다(Codex v2.4.0 3차 리뷰 P3-1 · 지우기의 늦은 성공도 — 적대 검토 3차 P3-5).
      // 메모가 없던 칸의 첫 저장(보낸 기준 없음)은 그사이 받은 목록도 '없음'이면 이 성공을 쓴다. 수정 시각으로는 '저장 전에 읽은 목록'과
      // '저장 뒤 다른 기기에서 지운 목록'을 가를 수 없고, 앞의 경우가 훨씬 흔하다(두 운동에 메모를 잇달아 저장 등) — 그 목록을 따르면
      // 저장에 성공한 글이 사라져 보였다(Codex v2.4.0 4차 리뷰 P3-1을 고쳤다가 적대 검토에서 되돌림 · 저장 뒤 다시 받는 목록이 바로잡는다)
      if (r.newest && (shownAt.current === sendBase || shownAt.current === r.at)) setSaved({ body, at: r.at, source: sourceNow.current });
      endEdit();
    } else if (r.code === 'conflict') {
      // 다른 기기에서 먼저 고쳤다 — 덮어쓰지 않는다. 쓰던 글은 칸에 남기고, 새로 받은 내용을 칸 위에 보인다
      setSaved(null);
      setBase(sendBase);
      setConflict(true);
      setLatest(null);
      setNote('저장된 메모가 변경됐어요. 최신 내용을 확인한 뒤 다시 저장해 주세요.');
    } else if (r.code === 'not_allowed')
      onError(viewer === 'trainer' ? '메모를 쓸 수 없어요. 담당이 바뀌었는지 확인해 주세요.' : '메모를 저장하지 못했어요. 다시 로그인한 뒤 시도해 주세요.');
    else if (r.code === 'too_long') setNote(`${MEMO_MAX}자까지 쓸 수 있어요.`);
    else onError('메모를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
  };
  const ownLabel = slotLabel(viewer, viewer);
  return (
    <div className={`memo-box${compact ? ' is-compact' : ''}`} data-testid="memo-box">
      {other && (
        <div className={`memo-slot ${other.author === 'trainer' ? 'is-coach' : ''}`}>
          <b>{slotLabel(viewer, other.author)}</b>
          <p>{other.body}</p>
        </div>
      )}
      {saves.saving && !busy && (
        <p className="memo-saving" role="status">
          {ownLabel}를 저장하는 중이에요.
        </p>
      )}
      {editing ? (
        <div className="memo-edit">
          {latestShown && (
            <div className={`memo-slot is-latest${viewer === 'trainer' ? ' is-coach' : ''}`} data-testid="memo-latest">
              <b>현재 저장된 {ownLabel}</b>
              <p>{latest.body ?? '현재 저장된 메모가 없어요.'}</p>
              {latest.body !== null && (
                <button type="button" className="text-button memo-fix" onClick={() => setText(latest.body ?? '')}>
                  이 내용으로 바꾸기
                </button>
              )}
            </div>
          )}
          <label className="sr-only" htmlFor={fieldId}>
            {name} {ownLabel}
          </label>
          <textarea
            id={fieldId}
            ref={box}
            value={text}
            maxLength={MEMO_MAX}
            rows={3}
            placeholder={viewer === 'trainer' ? '회원이 운동할 때 참고할 내용을 적어 주세요.' : '이 운동을 할 때 볼 내용을 적어 두세요.'}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="memo-edit-bar">
            <small>
              {text.trim().length}/{MEMO_MAX}
              {own && !text.trim() ? ' · 비우고 저장하면 지워져요' : ''}
            </small>
            <span>
              <button type="button" className="secondary small" disabled={busy} onClick={cancel}>
                취소
              </button>
              <button type="button" className="primary small" disabled={busy || (!own && !text.trim())} onClick={() => void save()}>
                {busy ? '저장 중…' : '저장'}
              </button>
            </span>
          </div>
          {note && (
            <p className="field-error" role="alert">
              {note}
            </p>
          )}
        </div>
      ) : own ? (
        <div className={`memo-slot ${own.author === 'trainer' ? 'is-coach' : ''}`}>
          <b>{ownLabel}</b>
          <p>{own.body}</p>
          {editable && (
            <button type="button" className="text-button memo-fix" aria-label={`${name} ${ownLabel} 고치기`} onClick={open}>
              고치기
            </button>
          )}
        </div>
      ) : editable ? (
        <button type="button" className="text-button memo-add" onClick={open}>
          <Icon name="plus" /> {ownLabel} 추가
        </button>
      ) : null}
    </div>
  );
}



/** 운동별 기록(창 안의 한 층). 뒤로 가기·밀기는 이 층만 닫는다 */
export function ExerciseHistory({ memberId, target, viewer, memoEditable, startEditing, backLabel, onBack, onOpenDay, onMemoState, onError }: {
  memberId: string;
  target: ExerciseTarget;
  viewer: Viewer;
  memoEditable: boolean;
  startEditing?: boolean;
  backLabel: string;
  onBack: () => void;
  /** 날짜를 누르면 그날 기록으로(운동 기록 창 안에서 열면 없음 — 쓰던 기록을 떠나지 않게) */
  onOpenDay?: (sessionId: string) => void;
  /** 메모 상태가 바뀔 때(운동 찾기가 날짜 열기 대기 중 새로 시작한 메모를 가린다) */
  onMemoState?: (state: MemoState) => void;
  onError: (msg: string) => void;
}) {
  const top = useRef<HTMLDivElement>(null);
  // 창에서 실제로 밀리는 것은 dialog다(.sheet-body가 아님 — 넘기기 전 적대 검토 E)
  useEffect(() => {
    const d = top.current?.closest('dialog');
    if (d) d.scrollTop = 0;
  }, []);
  // 메모를 쓰던 중이면 이 층을 닫기 전(뒤로 가기·밀기·안드로이드 뒤로·← 버튼·날짜 열기) 묻는다(검토 A1·A2·H)
  const memoState = useRef<MemoState>('clean');
  const leave = () => {
    if (!leaveMemo(memoState.current)) return false;
    memoState.current = 'clean';
    onBack();
  };
  const openDay = onOpenDay && ((id: string) => leaveMemo(memoState.current) && onOpenDay(id));
  const onDraft = (st: MemoState) => {
    memoState.current = st;
    onMemoState?.(st);
  };
  useBackLayer(true, leave, { level: BACK_LEVEL.inner, surface: () => [top.current?.closest<HTMLElement>('dialog')] });
  const scope = `${memberId}:${target.type === 'strength' ? target.key : `cardio:${target.kind}`}`;
  const live = useLive<ExerciseDay[] | CardioDay[]>(scope, '0', () => (target.type === 'strength' ? fetchExerciseHistory(memberId, target.key) : fetchCardioHistory(memberId, target.kind)));
  const memos = useExerciseMemos(target.type === 'strength' ? memberId : null);
  const title = target.type === 'strength' ? target.name : cardioLabel(target.kind);
  return (
    <div className="exercise-history" ref={top} data-testid="exercise-history">
      <button type="button" className="text-button guide-back" onClick={() => void leave()}>
        ← {backLabel}
      </button>
      <h3>{title}</h3>
      {live.value === undefined ? (
        live.failed ? <StatePanel kind="failed" title="운동 기록을 불러오지 못했어요" onRetry={live.reload} /> : <StatePanel kind="loading" />
      ) : (
        <>
          {live.failedNow && <StaleNotice text="새로 불러오지 못해 이전 기록을 보여 드려요." onRetry={live.reload} />}
          {target.type === 'strength' ? (
            <StrengthHistory
              memberId={memberId}
              name={target.name}
              days={live.value as ExerciseDay[]}
              viewer={viewer}
              memos={memos}
              memoEditable={memoEditable}
              startEditing={startEditing}
              onOpenDay={openDay}
              onDraft={onDraft}
              onError={onError}
            />
          ) : (
            <CardioHistory days={live.value as CardioDay[]} onOpenDay={openDay} />
          )}
        </>
      )}
    </div>
  );
}

const monthTitle = (m: string) => `${Number(m.slice(5, 7))}월`;
const yearOf = (m: string) => m.slice(0, 4);

function DayRow({ id, day, dayNo, sheet, line, record, onOpenDay }: { id: string; day: string; dayNo: number | null; sheet: boolean; line: string; record?: boolean; onOpenDay?: (id: string) => void }) {
  const body = (
    <>
      <span className="record-date" aria-hidden="true">
        <b>{Number(day.slice(8))}</b>
        <small>{weekdayShort(day)}</small>
      </span>
      <span className="record-main">
        <span className="sr-only">{prettyDay(day, true)}</span>
        <span className="record-top">
          <strong className="record-title">{dayNo ? `루틴 ${dayNo}` : '운동'}</strong>
          {sheet && <span className="sheet-tag">시트 기록</span>}
        </span>
        <span className="record-stats history-sets">
          {line}
          {record && <em className="record-pr">최고</em>}
        </span>
      </span>
    </>
  );
  return onOpenDay ? (
    <button type="button" className="workout-row record-row history-row" onClick={() => onOpenDay(id)}>
      {body}
    </button>
  ) : (
    <div className="workout-row record-row history-row">{body}</div>
  );
}

function Months<T extends { day: string }>({ rows, render }: { rows: T[]; render: (r: T) => ReactNode }) {
  const groups = byMonth(rows);
  const thisYear = todayKey().slice(0, 4);
  return (
    <div className="workout-list history-list">
      {groups.map((g) => (
        <div key={g.month} className="records-group">
          <h4>
            {yearOf(g.month) !== thisYear ? `${yearOf(g.month)}년 ` : ''}
            {monthTitle(g.month)} <span className="tiny">· {g.rows.length}건</span>
          </h4>
          {g.rows.map(render)}
        </div>
      ))}
    </div>
  );
}

function StrengthHistory({ memberId, name, days, viewer, memos, memoEditable, startEditing, onOpenDay, onDraft, onError }: {
  memberId: string;
  name: string;
  days: ExerciseDay[];
  viewer: Viewer;
  memos: ReturnType<typeof useExerciseMemos>;
  memoEditable: boolean;
  startEditing?: boolean;
  onOpenDay?: (id: string) => void;
  onDraft: (state: MemoState) => void;
  onError: (msg: string) => void;
}) {
  const s = historySummary(days);
  return (
    <>
      <div className="records-tiles history-tiles">
        <div>
          <small>최고 중량</small>
          <b>{s.heaviest ?? '—'}</b>
        </div>
        <div>
          <small>기록 수</small>
          <b>{s.count}건</b>
        </div>
        <div>
          <small>최근 운동일</small>
          <b>{s.last ? prettyDay(s.last) : '—'}</b>
        </div>
      </div>
      {memos.memos === undefined ? (
        memos.failed && <StaleNotice text="메모를 불러오지 못했어요." onRetry={memos.reload} />
      ) : (
        <>
          {memos.failed && <StaleNotice text="메모를 새로 불러오지 못했어요." onRetry={memos.reload} />}
          <MemoBox memberId={memberId} name={name} viewer={viewer} pair={memoPair(memos.memos, name)} source={memos.memos} stamp={memos.stamp} editable={memoEditable} startEditing={startEditing} onDraft={onDraft} onError={onError} />
        </>
      )}
      {s.rows.length ? (
        <Months rows={s.rows} render={(r) => <DayRow key={r.id} id={r.id} day={r.day} dayNo={r.day_no} sheet={r.source === 'sheet'} line={setsLine(r.sets)} record={r.record} onOpenDay={onOpenDay} />} />
      ) : (
        <StatePanel kind="empty" title="완료한 세트 기록이 없어요" description="완료로 표시하고 저장한 세트를 모아서 보여 드려요." />
      )}
    </>
  );
}

function CardioHistory({ days, onOpenDay }: { days: CardioDay[]; onOpenDay?: (id: string) => void }) {
  const total = days.reduce((n, d) => n + d.cardio.reduce((m, c) => m + c.minutes, 0), 0);
  return (
    <>
      <div className="records-tiles history-tiles">
        <div>
          <small>기록 수</small>
          <b>{days.length}건</b>
        </div>
        <div>
          <small>합계</small>
          <b>{Math.round(total)}분</b>
        </div>
        <div>
          <small>최근 운동일</small>
          <b>{days[0] ? prettyDay(days[0].day) : '—'}</b>
        </div>
      </div>
      <Months
        rows={days}
        render={(d) => (
          <DayRow key={d.id} id={d.id} day={d.day} dayNo={d.day_no} sheet={d.source === 'sheet'} line={d.cardio.map(cardioDetail).join(' / ')} onOpenDay={onOpenDay} />
        )}
      />
    </>
  );
}

/** 이름에서 친 글자를 강조 */
function Marked({ name, query }: { name: string; query: string }) {
  const r = matchRange(name, query);
  if (!r) return <>{name}</>;
  return (
    <>
      {name.slice(0, r[0])}
      <mark>{name.slice(r[0], r[1])}</mark>
      {name.slice(r[1])}
    </>
  );
}

/** 운동 찾기 창의 본문: 찾기 → 운동별 기록(같은 창 안의 한 층). 찾던 글자는 돌아와도 남는다 */
export function ExerciseFind({ memberId, viewer, initial, onOpenDay, onClose, onError }: {
  memberId: string;
  viewer: Viewer;
  /** 처음부터 이 운동의 기록을 연다(트레이너 루틴 카드의 '메모 추가' — 바로 메모 쓰기). 그때 돌아가기는 창을 닫는다(찾기 목록을 연 적이 없다) */
  initial?: { target: ExerciseTarget; editMemo?: boolean };
  /** 날짜를 눌러 받은 그 기록을 연다(이 부품이 받고, 열어도 되는지 확인한 뒤에만 부른다) */
  onOpenDay: (session: WorkoutSession) => void;
  onClose?: () => void;
  onError: (msg: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<{ target: ExerciseTarget; editMemo?: boolean } | null>(initial ?? null);
  const live = useLive(`find:${memberId}`, '0', () => fetchExerciseList(memberId));
  // 날짜 열기: 바깥 창이 그대로여도 그 안의 운동·메모는 바뀔 수 있다(Codex v2.4.0 1차 리뷰 P2-1). 응답은 마지막 요청이고, 그때 보던 운동 그대로이고,
  // 그사이 메모를 건드리지 않았을 때만 연다. 다른 운동으로 가거나 이 창이 닫히면 요청을 버린다
  const dayReq = useRef(0);
  const pickedNow = useRef(picked);
  const memoTouch = useRef(0);
  useEffect(() => {
    pickedNow.current = picked;
    dayReq.current++;
  }, [picked]);
  useEffect(
    () => () => {
      dayReq.current++;
    },
    [],
  );
  const openDay = (id: string) => {
    const n = ++dayReq.current;
    const at = pickedNow.current;
    const touch = memoTouch.current;
    fetchWorkout(id)
      .then((session) => {
        if (n !== dayReq.current || pickedNow.current !== at || memoTouch.current !== touch) return;
        if (!session) onError('그 기록이 지워졌어요.');
        else onOpenDay(session);
      })
      .catch(() => {
        if (n === dayReq.current) onError('기록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
      });
  };
  const onMemoState = (st: MemoState) => {
    if (st !== 'clean') memoTouch.current++;
  };
  // 운동별 기록에서 돌아오면 목록의 보던 위치로(창에서 밀리는 것은 dialog — 2.4 넘기기 전 적대 검토 2차 P)
  const root = useRef<HTMLDivElement>(null);
  const listTop = useRef<number | null>(null);
  const pick = (target: ExerciseTarget) => {
    listTop.current = root.current?.closest('dialog')?.scrollTop ?? null;
    setPicked({ target });
  };
  useLayoutEffect(() => {
    if (picked || listTop.current === null) return;
    const d = root.current?.closest('dialog');
    if (d) d.scrollTop = listTop.current;
    listTop.current = null;
  }, [picked]);
  if (picked) {
    const direct = picked === initial && !!onClose;
    return (
      <ExerciseHistory
        memberId={memberId}
        target={picked.target}
        viewer={viewer}
        memoEditable
        startEditing={picked.editMemo}
        backLabel={direct ? '루틴으로' : '운동 찾기로'}
        onBack={direct ? onClose : () => setPicked(null)}
        onOpenDay={openDay}
        onMemoState={onMemoState}
        onError={onError}
      />
    );
  }
  const found = live.value ? findExercises(live.value, query) : null;
  const none = found && !found.strength.length && !found.cardio.length;
  return (
    <div className="exercise-find" data-testid="exercise-find" ref={root}>
      {/* 찾던 글자는 쓰던 내용이 아니다 — 창을 닫을 때 묻지 않는다(검토 D) */}
      <label className="find-field" data-saved="">
        <Icon name="search" />
        <span className="sr-only">운동 이름</span>
        <input type="search" value={query} placeholder="운동 이름" autoComplete="off" enterKeyHint="search" onChange={(e) => setQuery(e.target.value)} />
      </label>
      {!live.value ? (
        live.failed ? <StatePanel kind="failed" title="운동 목록을 불러오지 못했어요" onRetry={live.reload} /> : <StatePanel kind="loading" />
      ) : none ? (
        <p className="find-empty">
          {query.trim() ? '검색 결과가 없어요.' : '아직 완료한 운동 기록이 없어요.'}
        </p>
      ) : (
        <>
          {live.failedNow && <StaleNotice text="목록을 새로 불러오지 못했어요." onRetry={live.reload} />}
          <p className="find-sub">{query.trim() ? '검색 결과' : '자주 한 운동'}</p>
          <div className="find-list">
            {found!.strength.map((x) => (
              <button key={x.key} type="button" className="find-row" onClick={() => pick({ type: 'strength', key: x.key, name: x.name })}>
                <span>
                  <strong>
                    <Marked name={x.name} query={query} />
                  </strong>
                  <small>
                    기록 {x.count}건 · 최근 {prettyDay(x.last)}
                  </small>
                </span>
                <Icon name="right" />
              </button>
            ))}
            {found!.cardio.map((c) => (
              <button key={c.kind} type="button" className="find-row" onClick={() => pick({ type: 'cardio', kind: c.kind })}>
                <span>
                  <strong>
                    <Marked name={cardioLabel(c.kind)} query={query} /> <span className="find-kind">유산소</span>
                  </strong>
                  <small>
                    기록 {c.count}건 · 최근 {prettyDay(c.last)}
                  </small>
                </span>
                <Icon name="right" />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
