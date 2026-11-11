import { supabase } from './supabase';
import type { Comment, InbodyInput, InbodyRecord, Meal, MealInput } from './types';
import { uuid } from './uuid';
import { fetchAllPages } from './paging';
import type { DietReport } from './report';
import type { CardioEntry } from './cardio';

/** 회원 목록·트레이너의 회원별 기록에 불러오는 기간. 그보다 오래된 날짜는 기록 화면에서 고를 때 따로 불러온다. */
export const WINDOW_DAYS = 60;
/** 트레이너 확인 목록은 최근 2주 + 처리할 식사만 받는다(1분마다 새로 고치므로 가볍게). */
export const TRAINER_RECENT_DAYS = 14;

const BUCKET = 'meal-photos';
const MEAL_SELECT =
  'id, member_id, eaten_on, eaten_at, meal_type, food, note, photo_path, created_at, reviewed_at, member_seen_at, note_updated_at, member_msg_at, trainer_msg_at, rating, rated_at, shared_at, ' +
  'comments(id, meal_id, author_role, body, created_at), member:profiles!meals_member_id_fkey(nickname)';

interface MealRow extends Omit<Meal, 'member_nickname'> {
  member: { nickname: string } | null;
}

function toMeal(row: MealRow): Meal {
  const { member, ...rest } = row;
  return {
    ...rest,
    eaten_at: row.eaten_at.slice(0, 5),
    comments: [...(row.comments ?? [])].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
    member_nickname: member?.nickname ?? '',
  };
}

export const sortMeals = (list: Meal[]) =>
  [...list].sort((a, b) => `${b.eaten_on} ${b.eaten_at}`.localeCompare(`${a.eaten_on} ${a.eaten_at}`));

export function mergeMeals(base: Meal[], incoming: Meal[]) {
  const map = new Map(base.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  return sortMeals([...map.values()]);
}

/**
 * 식사 조회.
 * - day: 그날 하루
 * - since(+memberId): 그 날짜 이후(회원 본인, 트레이너의 회원별 기록)
 * - trainer: 트레이너 확인 목록 — 최근 2주 + 아직 확인 안 한 식사 + 최근 60일 안에 회원이 말을 남긴 식사(오래된 식사의 새 질문 포함)
 */
export async function fetchMeals(opts: {
  since?: string;
  day?: string;
  memberId?: string;
  trainer?: { recentSince: string; messageSince: string };
  /** 회원 본인: since 이후 + 기간 밖이라도 최근 60일 안에 트레이너가 답한 식사(Codex P2: 오래된 식사의 새 피드백 누락) */
  member?: { since: string; feedbackSince: string };
}) {
  const rows = await fetchAllPages<MealRow>((from, to) => {
    let q = supabase.from('meals').select(MEAL_SELECT);
    if (opts.memberId) q = q.eq('member_id', opts.memberId);
    if (opts.day) q = q.eq('eaten_on', opts.day);
    else if (opts.trainer)
      q = q.or(`eaten_on.gte.${opts.trainer.recentSince},reviewed_at.is.null,member_msg_at.gte."${opts.trainer.messageSince}"`);
    else if (opts.member) q = q.or(`eaten_on.gte.${opts.member.since},trainer_msg_at.gte."${opts.member.feedbackSince}"`);
    else if (opts.since) q = q.gte('eaten_on', opts.since);
    // 페이지가 겹치거나 빠지지 않도록 id까지 넣어 순서를 고정한다
    return q
      .order('eaten_on', { ascending: false })
      .order('eaten_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: MealRow[] | null; error: unknown }>;
  });
  return rows.map(toMeal);
}

export async function fetchMeal(id: string): Promise<Meal | null> {
  const { data, error } = await supabase.from('meals').select(MEAL_SELECT).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? toMeal(data as unknown as MealRow) : null;
}

/** 사진 올리기. 교체할 때는 새 이름으로 올려서, DB 저장이 실패해도 원래 사진이 남게 한다. */
async function uploadPhoto(memberId: string, mealId: string, photo: Blob, fresh = false) {
  const path = `${memberId}/${mealId}${fresh ? `-${Date.now()}` : ''}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, photo, { contentType: 'image/jpeg', upsert: !fresh });
  if (error) throw error;
  return path;
}

type SavedRow = { eaten_on: string; eaten_at: string; meal_type: string; food: string; note: string; photo_path: string | null };

/** 서버에 실제로 저장된 값이 보낸 값과 같은가(시각은 HH:MM까지). photo_path가 undefined면 사진은 보내지 않은 것이라 비교하지 않는다. */
const sameAsSent = (row: SavedRow, input: MealInput, photo_path: string | null | undefined) =>
  row.eaten_on === input.eaten_on &&
  row.eaten_at.slice(0, 5) === input.eaten_at.slice(0, 5) &&
  row.meal_type === input.meal_type &&
  row.food === input.food &&
  row.note === input.note &&
  (photo_path === undefined || row.photo_path === photo_path);

/**
 * 응답이 실패로 왔을 때 서버에 지금 저장된 행을 다시 읽는다(응답만 끊기는 경우, Codex 재검토 P2).
 * ok=false면 확인도 못 한 것이다 — 그때는 아무 파일도 지우지 않는다.
 */
async function readSaved(id: string): Promise<{ ok: boolean; row: SavedRow | null }> {
  const { data, error } = await supabase.from('meals').select('eaten_on, eaten_at, meal_type, food, note, photo_path').eq('id', id).maybeSingle();
  return error ? { ok: false, row: null } : { ok: true, row: (data as SavedRow | null) ?? null };
}

/**
 * 사진 파일 정리 원칙(Codex 재검토 P2): '저장 성공 여부'와 '이 파일을 DB가 가리키는가'를 따로 본다.
 * DB가 지금 가리키는 파일은 어떤 경우에도 지우지 않는다(그 사이 다른 수정이 들어와 값이 달라졌어도).
 */
async function removeIfUnreferenced(path: string | null, current: SavedRow | null) {
  if (path && current?.photo_path !== path) await supabase.storage.from(BUCKET).remove([path]);
}

export async function createMeal(memberId: string, input: MealInput, photo: Blob | null) {
  const id = uuid();
  const photo_path = photo ? await uploadPhoto(memberId, id, photo) : null;
  const { error } = await supabase.from('meals').insert({ id, ...input, photo_path });
  if (error) {
    const saved = await readSaved(id);
    if (!saved.ok) throw error;
    if (saved.row && sameAsSent(saved.row, input, photo_path)) return id; // 실제로는 등록됨
    await removeIfUnreferenced(photo_path, saved.row);
    throw error;
  }
  return id;
}

/**
 * photo: Blob이면 교체, null이면 삭제, undefined면 그대로.
 * 순서: 새 사진 올리기(새 이름) → DB 저장 → 성공하면 옛 사진 지우기.
 * 실패 응답이면 저장된 행을 다시 읽어, 보낸 값 전체가 저장됐는지(성공 여부)와 어떤 사진을 가리키는지(지울 파일)를 따로 판단한다.
 */
export async function updateMeal(meal: Meal, input: MealInput, photo: Blob | null | undefined) {
  // Codex 재검토(ad10d77) P2: 사진을 안 바꿨으면 사진 경로를 보내지 않는다.
  // 오래 열어 둔 폼이 예전 경로를 다시 보내면, 그 사이 다른 기기가 바꾸고 지운 사진 경로로 되돌아간다.
  if (photo === undefined) {
    const { error } = await supabase.from('meals').update({ ...input }).eq('id', meal.id);
    if (error) {
      const saved = await readSaved(meal.id);
      if (saved.ok && saved.row && sameAsSent(saved.row, input, undefined)) return; // 실제로는 저장됨
      throw error;
    }
    return;
  }
  const oldPath = meal.photo_path;
  const photo_path = photo ? await uploadPhoto(meal.member_id, meal.id, photo, true) : null;
  const { error } = await supabase.from('meals').update({ ...input, photo_path }).eq('id', meal.id);
  if (error) {
    const saved = await readSaved(meal.id);
    if (!saved.ok) throw error;
    if (photo) await removeIfUnreferenced(photo_path, saved.row);
    if (oldPath !== photo_path) await removeIfUnreferenced(oldPath, saved.row);
    if (saved.row && sameAsSent(saved.row, input, photo_path)) return; // 실제로는 저장됨
    throw error;
  }
  if (oldPath && oldPath !== photo_path) await supabase.storage.from(BUCKET).remove([oldPath]);
}

export async function deleteMeal(meal: Meal) {
  const { error } = await supabase.from('meals').delete().eq('id', meal.id);
  if (error) throw error;
  if (meal.photo_path) await supabase.storage.from(BUCKET).remove([meal.photo_path]);
}

export async function addComment(mealId: string, body: string): Promise<Comment> {
  const { data, error } = await supabase.from('comments').insert({ meal_id: mealId, body }).select().single();
  if (error) throw error;
  if ((data as Comment).author_role === 'trainer') nudgePush();
  return data as Comment;
}

/** 트레이너가 피드백을 저장한 직후: 회원에게 알림을 바로 보내 달라고 요청한다(기다리지 않고, 실패해도 저장에는 영향 없음) */
function nudgePush() {
  void Promise.resolve(supabase.rpc('push_nudge')).catch(() => {});
}

export async function markReviewed(mealId: string) {
  const { error } = await supabase.rpc('mark_reviewed', { p_meal: mealId });
  if (error) throw error;
}

/** 식단 평가(담당 트레이너만). 고르면 확인 완료로 치고 답변 대기도 정리된다. */
export async function rateMeal(mealId: string, rating: 1 | 2 | 3) {
  const { error } = await supabase.rpc('rate_meal', { p_meal: mealId, p_rating: rating });
  if (error) throw error;
  nudgePush();
}

/** 읽은 시각은 서버 시계로 기록한다(기기 시계가 어긋나면 새 피드백 표시가 남는다) */
export async function markSeen(mealId: string) {
  const { error } = await supabase.rpc('mark_seen', { p_meal: mealId });
  if (error) throw error;
}

/** 피드백 탭 '모두 읽음': 보여 준 식사들만, 보여 준 가장 늦은 피드백 시각(through)까지 읽음으로. 그 뒤에 온 피드백은 새 피드백으로 남는다 */
export async function markSeenMany(mealIds: string[], through: string) {
  const { error } = await supabase.rpc('mark_seen_many', { p_meals: mealIds, p_through: through });
  if (error) throw error;
}

/** 비공개 사진의 1시간짜리 주소 */
export async function signPhotos(paths: string[]): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const item of data ?? []) if (item.path && item.signedUrl) out[item.path] = item.signedUrl;
  return out;
}

/** 담당 트레이너 닉네임. 담당이 없으면(내보내진 회원) null. */
export async function fetchMyTrainerName(): Promise<string | null> {
  const { data, error } = await supabase
    .from('assignments')
    .select('trainer:profiles!assignments_trainer_id_fkey(nickname)')
    .maybeSingle();
  if (error) throw error;
  const row = data as unknown as { trainer: { nickname: string } | null } | null;
  return row ? (row.trainer?.nickname ?? '') : null;
}

export async function fetchMyMembers(): Promise<{ id: string; nickname: string }[]> {
  const { data, error } = await supabase
    .from('assignments')
    .select('member_id, member:profiles!assignments_member_id_fkey(nickname)');
  if (error) throw error;
  return ((data ?? []) as unknown as { member_id: string; member: { nickname: string } | null }[])
    .map((r) => ({ id: r.member_id, nickname: r.member?.nickname ?? '' }))
    .sort((a, b) => a.nickname.localeCompare(b.nickname, 'ko'));
}

/** 오늘 보일 트레이너 한마디. 회원은 담당 트레이너 것만, 트레이너는 자기 것만 읽힌다(RLS). 없으면 null. */
export async function fetchTrainerMessage(day: string): Promise<string | null> {
  const { data, error } = await supabase.from('trainer_messages').select('body').eq('day', day).maybeSingle();
  if (error) throw error;
  return (data as { body: string } | null)?.body ?? null;
}

/** 트레이너 한마디 저장. 빈 글이면 지워서 기본 문구로 돌아간다. */
/** 쓴 한마디 하나(운동 꿀팁 표시 포함). 없으면 null */
export type TrainerMessage = { day: string; body: string; is_tip: boolean };
export async function fetchTrainerMessageRow(day: string): Promise<TrainerMessage | null> {
  const { data, error } = await supabase.from('trainer_messages').select('day, body, is_tip').eq('day', day).maybeSingle();
  if (error) throw error;
  return (data as TrainerMessage | null) ?? null;
}

/** 트레이너 한마디 모아 보기(2.3): 내가 쓴 것(트레이너) · 담당 트레이너가 쓴 것(회원). 오늘까지, 최근 것부터 */
export async function fetchTrainerMessages(today: string, limit?: number): Promise<TrainerMessage[]> {
  const query = () => supabase.from('trainer_messages').select('day, body, is_tip').lte('day', today).order('day', { ascending: false });
  if (!limit) return fetchAllPages<TrainerMessage>((from, to) => query().range(from, to).abortSignal(timeoutSignal(AUX_TIMEOUT_MS)));
  const { data, error } = await query().limit(limit).abortSignal(timeoutSignal(AUX_TIMEOUT_MS));
  if (error) throw error;
  return (data ?? []) as TrainerMessage[];
}

/** isTip이 null이면 저장된 표시를 그대로 둔다(표시를 읽지 못한 경우) */
export async function saveTrainerMessage(day: string, body: string, isTip: boolean | null = false) {
  const { error } = await supabase.rpc('set_trainer_message', { p_day: day, p_body: body, p_is_tip: isTip });
  if (error) throw error;
}

export interface Streak {
  current: number;
  best: number;
  today_logged: boolean;
}

/** 내 연속 기록(하루 1끼 이상). 오늘을 아직 안 남겼으면 어제까지 이어진 날 수. */
export async function fetchMyStreak(today: string): Promise<Streak> {
  const { data, error } = await supabase.rpc('meal_streak', { p_today: today });
  if (error) throw error;
  return data as Streak;
}

/**
 * 트레이너: 오늘 식단을 아직 안 남긴 담당 회원에게 기록 알림(2.1, 2026-11-03 사용자 확정 시안 — 서버 nudge_member).
 * 하루 한 번. 보내기 직전에도 그사이 기록했으면 보내지 않는다(서버 push_payload). 회원이 끼니 알림을 끄면 보내지 않는다
 */
export type NudgeResult = 'sent' | 'already' | 'logged' | 'no_device' | 'muted' | 'off';
const NUDGE_RESULTS: NudgeResult[] = ['sent', 'already', 'logged', 'no_device', 'muted', 'off'];
export async function nudgeMember(memberId: string): Promise<NudgeResult> {
  const { data, error } = await supabase.rpc('nudge_member', { p_member: memberId });
  if (error) throw error;
  if (!NUDGE_RESULTS.includes(data as NudgeResult)) throw new Error('failed');
  return data as NudgeResult;
}

/** 트레이너: 담당 회원별 연속 기록 */
export async function fetchMemberStreaks(today: string): Promise<Record<string, { current: number; today_logged: boolean }>> {
  const { data, error } = await supabase.rpc('member_streaks', { p_today: today });
  if (error) throw error;
  const out: Record<string, { current: number; today_logged: boolean }> = {};
  for (const r of (data ?? []) as { member_id: string; current_streak: number; today_logged: boolean }[])
    out[r.member_id] = { current: r.current_streak, today_logged: r.today_logged };
  return out;
}

const INBODY_SELECT = 'id, member_id, measured_on, weight_kg, smm_kg, pbf_pct, source';
const toInbody = (r: Record<string, unknown>): InbodyRecord => ({
  ...(r as unknown as InbodyRecord),
  weight_kg: Number(r.weight_kg),
  smm_kg: r.smm_kg === null ? null : Number(r.smm_kg),
  pbf_pct: r.pbf_pct === null ? null : Number(r.pbf_pct),
});

/** 인바디 기록(최근 측정이 앞). 회원 본인 것, 트레이너는 담당 회원 것만 읽힌다. */
export async function fetchInbody(memberId: string): Promise<InbodyRecord[]> {
  const { data, error } = await supabase.from('inbody_records').select(INBODY_SELECT).eq('member_id', memberId).order('measured_on', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(toInbody);
}

export class InbodyDuplicateError extends Error {}

/** 인바디 저장. id가 있으면 고치기. 같은 날짜 기록이 이미 있으면 InbodyDuplicateError. */
export async function saveInbody(memberId: string, input: InbodyInput, id?: string) {
  const { error } = id
    ? await supabase.from('inbody_records').update(input).eq('id', id)
    : await supabase.from('inbody_records').insert({ member_id: memberId, ...input });
  if (error && (error as { code?: string }).code === '23505') throw new InbodyDuplicateError('duplicate');
  if (error) throw error;
}

export async function deleteInbody(id: string) {
  const { error } = await supabase.from('inbody_records').delete().eq('id', id);
  if (error) throw error;
}

/** 결산: 기간 안의 식단 기록·평가 수와 식단 점수(서버에서 셈) */
export async function fetchDietReport(memberId: string, from: string, to: string): Promise<DietReport> {
  const { data, error } = await supabase.rpc('diet_report', { p_member: memberId, p_from: from, p_to: to });
  if (error) throw error;
  return data as DietReport;
}

export const errorText = (e: unknown) =>
  e instanceof Error && e.message ? e.message : '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.';

// ─── v1.8: 한마디 좋아요 · 이달의 식단왕 · 공유 식단 · 담당에서 내보내기 ───

/** 회원: 지금 담당 트레이너의 그날 한마디에 내가 좋아요를 눌렀나(저장과 같은 기준을 서버가 정한다) */
export async function fetchMyLike(day: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('my_message_like', { p_day: day });
  if (error) throw error;
  if (typeof data !== 'boolean') throw new Error('bad_like');
  return data;
}

export async function setMessageLike(day: string, on: boolean) {
  const { error } = await supabase.rpc('set_message_like', { p_day: day, p_on: on });
  if (error) throw error;
}

/** 트레이너: 그날 내 한마디에 좋아요를 누른 담당 회원 */
export async function fetchMessageLikers(day: string): Promise<string[]> {
  const { data, error } = await supabase.rpc('message_likers', { p_day: day });
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('bad_likers');
  return (data as { nickname: string }[]).map((r) => r.nickname);
}

// v2.0 이달의 식단왕·운동왕: 달이 끝난 뒤 확정한 결과 + 이번 달 현재 순위(2.3부터 한 달 내내 함께 보인다)
export type AwardKind = 'rating' | 'streak' | 'workout';
export interface Award {
  kind: AwardKind;
  nickname: string;
  score: number;
  is_me: boolean;
}
export interface MonthAwards {
  month: string;
  /** 그달을 확정했는가(아니면 '집계 중') */
  published: boolean;
  /** 수상을 시작한 달인가(아니면 '시작 전' — 10월은 수상하지 않음, 2026-10-30 사용자 결정) */
  started: boolean;
  /** 수상 시작 달(YYYY-MM-01) */
  starts: string;
  winners: Award[];
}

// 수상 응답 검사(Codex v2.0.0 정식 1차 리뷰 품질 의견): 상 종류·이름·숫자가 어긋난 응답은 빈 목록이나 NaN으로 그리지 않고 '불러오지 못함'으로
const AWARD_KINDS: readonly string[] = ['rating', 'streak', 'workout'];
const isKind = (v: unknown): v is AwardKind => typeof v === 'string' && AWARD_KINDS.includes(v);
/** 유한한 0 이상의 수(JSON 숫자 또는 숫자 글자) — 아니면 NaN */
const count = (v: unknown) => {
  const n = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

export async function fetchAwards(month: string): Promise<MonthAwards> {
  const { data, error } = await supabase.rpc('awards_for_me', { p_month: month });
  if (error) throw error;
  const d = data as MonthAwards | null;
  if (!d || typeof d.published !== 'boolean' || typeof d.started !== 'boolean' || !isDay(d.starts) || !Array.isArray(d.winners)) throw new Error('bad_awards');
  const winners = d.winners.map((w) => ({ ...w, score: count(w?.score) }));
  if (winners.some((w) => !isKind(w.kind) || typeof w.nickname !== 'string' || typeof w.is_me !== 'boolean' || Number.isNaN(w.score))) throw new Error('bad_awards');
  return { ...d, winners };
}

export async function fetchAwardMonths(): Promise<string[]> {
  const { data, error } = await supabase.rpc('award_months');
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('bad_months');
  return (data as { month: string }[]).map((r) => r.month);
}

export interface AwardProgress {
  meals: number;
  rated: number;
  days: number;
  best_streak: number;
  workout_days: number;
}
export async function fetchAwardProgress(today: string): Promise<AwardProgress> {
  const { data, error } = await supabase.rpc('my_award_progress', { p_today: today });
  if (error) throw error;
  const d = data as AwardProgress | null;
  const keys = ['meals', 'rated', 'days', 'best_streak', 'workout_days'] as const;
  if (!d || keys.some((k) => typeof d[k] !== 'number' || Number.isNaN(count(d[k])))) throw new Error('bad_progress');
  return d;
}

// 이번 달 현재 순위(2.3부터 한 달 내내 보인다, 사용자 결정 11-05). 상마다 3위까지(동점 함께) + 내 순위. 확정 전이라 바뀔 수 있다
export interface StandingRow {
  kind: AwardKind;
  rank: number;
  nickname: string;
  score: number;
  is_me: boolean;
  /** 후보 조건을 채웠는가. 후보가 앞에 오고, 왕은 후보만 된다 */
  qualified: boolean;
}
export interface AwardStandings {
  month: string;
  started: boolean;
  starts: string;
  workout_started: boolean;
  workout_starts: string;
  rows: StandingRow[];
}
export async function fetchAwardStandings(today: string): Promise<AwardStandings> {
  const { data, error } = await supabase.rpc('award_standings', { p_today: today });
  if (error) throw error;
  const d = data as AwardStandings | null;
  if (!d || typeof d.started !== 'boolean' || typeof d.workout_started !== 'boolean' || !isDay(d.starts) || !isDay(d.workout_starts) || !Array.isArray(d.rows)) throw new Error('bad_standings');
  const rows = d.rows.map((r) => ({ ...r, rank: count(r?.rank), score: count(r?.score), qualified: r?.qualified !== false }));
  if (rows.some((r) => !isKind(r.kind) || typeof r.nickname !== 'string' || typeof r.is_me !== 'boolean' || !Number.isInteger(r.rank) || r.rank < 1 || Number.isNaN(r.score))) throw new Error('bad_standings');
  return { ...d, rows };
}

/** 이달의 중량왕(2.3): 탭(성별)·동작·값(무게 또는 체중 대비)마다 한 칸. 같은 값이면 이름이 여럿이다 */
export interface StrengthKing {
  gender: Gender;
  lift: string;
  metric: 'kg' | 'pct';
  value: number;
  names: { nickname: string; is_me: boolean }[];
}
export interface StrengthMine {
  lift: string;
  kg: number;
  kg_rank: number;
  pct: number | null;
  pct_rank: number | null;
  body_kg: number | null;
}
export interface StrengthKings {
  month: string;
  /** 수상을 시작하기 전 달이면 false — 세지 않는다 */
  started: boolean;
  kings: StrengthKing[];
  mine: StrengthMine[];
  my_gender: Gender | null;
  my_state: 'ok' | 'no_gender' | 'hidden' | null;
}
export async function fetchStrengthKings(month: string, today: string): Promise<StrengthKings> {
  const { data, error } = await supabase.rpc('strength_kings', { p_month: month, p_today: today });
  if (error) throw error;
  const d = data as StrengthKings | null;
  if (!d || !Array.isArray(d.kings) || !Array.isArray(d.mine)) throw new Error('bad_strength');
  return d;
}

export async function fetchAwardPublic(userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('profiles').select('award_public').eq('id', userId).single();
  if (error) throw error;
  return !!(data as { award_public: boolean }).award_public;
}

export async function setAwardPublic(on: boolean) {
  const { error } = await supabase.rpc('set_award_public', { p_on: on });
  if (error) throw error;
}

/** 공복 체중(2.3): 회원 본인·담당 트레이너가 읽는다. 하루 한 값, 최근 날부터 */
export type FastingWeight = { day: string; kg: number };
export async function fetchFastingWeights(memberId: string): Promise<FastingWeight[]> {
  const rows = await fetchAllPages<{ day: string; kg: number | string }>((from, to) => supabase.from('fasting_weights').select('day, kg').eq('member_id', memberId).order('day', { ascending: false }).range(from, to).abortSignal(timeoutSignal(AUX_TIMEOUT_MS)));
  return rows.map((w) => ({ day: w.day, kg: Number(w.kg) }));
}

/** 변화 보고서: 그 기간의 공복 체중, 오래된 날부터 */
export async function fetchFastingBetween(memberId: string, from: string, to: string): Promise<FastingWeight[]> {
  const { data, error } = await supabase.from('fasting_weights').select('day, kg').eq('member_id', memberId).gte('day', from).lte('day', to).order('day').abortSignal(timeoutSignal(AUX_TIMEOUT_MS));
  if (error) throw error;
  return ((data ?? []) as { day: string; kg: number | string }[]).map((w) => ({ day: w.day, kg: Number(w.kg) }));
}

export async function saveFastingWeight(day: string, kg: number) {
  const { error } = await supabase.rpc('save_fasting_weight', { p_day: day, p_kg: kg });
  if (error) throw error;
}

export async function deleteFastingWeight(day: string) {
  const { error } = await supabase.rpc('delete_fasting_weight', { p_day: day });
  if (error) throw error;
}

/** 회원 성별(2.3): 본인만 읽는다. 아직 정하지 않았으면 gender null */
export type Gender = 'male' | 'female';
export async function fetchMyGender(): Promise<{ gender: Gender | null; hidden: boolean }> {
  const { data, error } = await supabase.rpc('my_gender');
  if (error) throw error;
  return data as { gender: Gender | null; hidden: boolean };
}

/** 한 번 정하면 바꿀 수 없다 — 다른 값을 보내면 gender_locked */
export async function setMyGender(gender: Gender, hidden = false) {
  const { error } = await supabase.rpc('set_my_gender', { p_gender: gender, p_hidden: hidden });
  if (error) throw new Error(/gender_locked/.test(error.message) ? 'gender_locked' : 'failed');
}

export async function setGenderHidden(on: boolean) {
  const { error } = await supabase.rpc('set_gender_hidden', { p_on: on });
  if (error) throw error;
}

export async function fetchShareConsent(userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('profiles').select('share_consent').eq('id', userId).single();
  if (error) throw error;
  return !!(data as { share_consent: boolean }).share_consent;
}

export async function setShareConsent(on: boolean) {
  const { error } = await supabase.rpc('set_share_consent', { p_on: on });
  if (error) throw error;
}

export async function shareMeal(mealId: string, on: boolean) {
  const { error } = await supabase.rpc('share_meal', { p_meal: mealId, p_on: on });
  if (error) throw error;
}

/** 트레이너: 담당 회원별 공유 동의(식사 상세의 공유 버튼에 쓴다) */
export async function fetchMembersConsent(): Promise<Record<string, boolean>> {
  const { data, error } = await supabase.from('profiles').select('id, share_consent').eq('role', 'member');
  if (error) throw error;
  return Object.fromEntries(((data ?? []) as { id: string; share_consent: boolean }[]).map((r) => [r.id, r.share_consent]));
}

export interface SharedMeal {
  id: string;
  eaten_on: string;
  meal_type: string;
  food: string;
  rating: number | null;
  photo_path: string | null;
  shared_at: string;
  mine: boolean;
  /** 닉네임 공개를 끈 회원은 다른 사람에게 '익명 회원' */
  nickname: string;
}

export async function fetchSharedMeals(limit = 20): Promise<SharedMeal[]> {
  const { data, error } = await supabase.rpc('shared_meals', { p_limit: limit });
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('bad_shared');
  return data as SharedMeal[];
}

/**
 * 남의 식사 사진 한 장(담당 트레이너의 회원 사진·추천 식단 사진). 서명 주소를 만들지 않고 서버 기능이 요청마다
 * 지금 권한(본인·지금 담당 트레이너·공유 범위)을 확인해 내려준다. 권한이 없으면 실패한다. 화면 쪽 캐시는 src/lib/mealPhoto.ts
 */
export async function fetchMealPhoto(mealId: string): Promise<Blob> {
  const { data, error } = await supabase.functions.invoke('meal-photo', { body: { meal: mealId } });
  if (error) throw error;
  if (!(data instanceof Blob)) throw new Error('bad_photo');
  return new Blob([data], { type: 'image/jpeg' });
}

export async function removeMember(memberId: string) {
  const { error } = await supabase.rpc('remove_member', { p_member: memberId });
  if (error) throw error;
}

export async function fetchTrainersForMe(): Promise<{ id: string; nickname: string }[]> {
  const { data, error } = await supabase.rpc('trainers_for_me');
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('bad_trainers');
  return data as { id: string; nickname: string }[];
}

export async function chooseTrainer(trainerId: string) {
  const { error } = await supabase.rpc('choose_trainer', { p_trainer: trainerId });
  if (error) throw error;
}

// ─── v2.0 운동: 루틴(트레이너가 정한 계획, 판으로 쌓임) · 운동 기록(회원이 실제로 한 것) ───

export interface RoutineItem {
  id: string;
  ord: number;
  /** 운동 날(시트의 1·2·3 블록) */
  day_no: number;
  name: string;
  /** 중량·횟수는 시트대로 글자('32+40', '10/10', '30 S') */
  weight: string;
  reps: string;
  sets: number | null;
  rest: string;
  note: string;
}
export interface Routine {
  id: string;
  member_id: string;
  version: number;
  title: string;
  goal: string;
  reason: string;
  /** 본 운동 전 필수 동작(시트 맨 위) */
  warmup: string;
  source: 'manual' | 'paste' | 'sheet';
  /** 가져온 시트 탭 이름(예: 2610) */
  source_ref: string;
  created_at: string;
  items: RoutineItem[];
}
export type RoutineItemInput = Omit<RoutineItem, 'id' | 'ord'>;

/** 회원의 최신 루틴(없으면 null)과 바로 앞 판(변경 비교용) */
/** 루틴 판 하나(기록이 가리키는 옛 판 — 시트에 붙여 넣을 값을 만들 때). 없으면 null */
export async function fetchRoutine(routineId: string): Promise<Routine | null> {
  const { data, error } = await supabase
    .from('routines')
    .select('id, member_id, version, title, goal, reason, warmup, source, source_ref, created_at, items:routine_items(id, ord, day_no, name, weight, reps, sets, rest, note)')
    .eq('id', routineId)
    .maybeSingle();
  if (error) throw error;
  return data ? { ...(data as unknown as Routine), items: [...(data as unknown as Routine).items].sort((a, b) => a.ord - b.ord) } : null;
}

export async function fetchRoutines(memberId: string): Promise<{ current: Routine | null; previous: Routine | null }> {
  const { data, error } = await supabase
    .from('routines')
    .select('id, member_id, version, title, goal, reason, warmup, source, source_ref, created_at, items:routine_items(id, ord, day_no, name, weight, reps, sets, rest, note)')
    .eq('member_id', memberId)
    .order('version', { ascending: false })
    .limit(2);
  if (error) throw error;
  const list = ((data ?? []) as unknown as Routine[]).map((r) => ({
    ...r,
    items: [...r.items].sort((a, b) => a.ord - b.ord),
  }));
  return { current: list[0] ?? null, previous: list[1] ?? null };
}

export async function saveRoutine(memberId: string, r: { title: string; goal: string; reason: string; warmup: string; items: RoutineItemInput[]; source: Routine['source']; sourceRef: string }) {
  const { data, error } = await supabase.rpc('save_routine', {
    p_member: memberId,
    p_title: r.title,
    p_goal: r.goal,
    p_reason: r.reason,
    p_items: r.items,
    p_source: r.source,
    p_warmup: r.warmup,
    p_source_ref: r.sourceRef,
  });
  if (error) throw error;
  return data as string;
}

export interface WorkoutSet {
  item_id: string | null;
  name: string;
  set_no: number;
  /** 중량·횟수는 글자(v2.1): '60'·'35+8'·'12+12'·'10/10'처럼 적은 그대로. 빈 칸은 null */
  kg: string | null;
  reps: string | null;
  done: boolean;
}
export interface WorkoutSession {
  id: string;
  member_id: string;
  routine_id: string | null;
  day_no: number | null;
  day: string;
  started_at: string;
  updated_at: string;
  finished: boolean;
  sets: WorkoutSet[];
  /** 유산소(v2.1). 근력 세트 없이 유산소만 한 기록도 있다 */
  cardio: CardioEntry[];
  /** v2.1: 'sheet' = 시트에서 가져온 기록(앱에서 고치지 않음). 앱 기록도 시트에 써 넣었으면 그 탭·열(0부터) */
  source: 'app' | 'sheet';
  sheet_tab: string;
  sheet_col: number | null;
}

/** 중량·횟수 칸: 옛 DB(2.0, 숫자 칸)가 돌려준 숫자도 글자로 맞춘다 */
const textOrNull = (v: string | number | null) => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: string | number | null) => (v === null || v === undefined ? null : Number(v));
type RawSession = Omit<WorkoutSession, 'sets' | 'cardio' | 'source' | 'sheet_tab' | 'sheet_col'> & {
  source?: string;
  sheet_tab?: string;
  sheet_col?: number | null;
  sets: (Omit<WorkoutSet, 'kg' | 'reps'> & { kg: string | number | null; reps: string | number | null; ord: number })[];
  cardio?: { kind: CardioEntry['kind']; minutes: string | number; km: string | number | null; speed: string | number | null; ord: number }[];
};
/** 조회 결과 하나 → 화면용 기록(세트·유산소는 저장한 순서대로, numeric 칸은 숫자로) */
const toSession = (s: RawSession): WorkoutSession => ({
  ...s,
  // 옛 DB(2.0)에는 출처 칸이 없다 → 앱 기록
  source: s.source === 'sheet' ? 'sheet' : 'app',
  sheet_tab: s.sheet_tab ?? '',
  sheet_col: s.sheet_col ?? null,
  sets: [...s.sets].sort((a, b) => a.ord - b.ord).map((x) => ({ item_id: x.item_id, name: x.name, set_no: x.set_no, kg: textOrNull(x.kg), reps: textOrNull(x.reps), done: x.done })),
  cardio: [...(s.cardio ?? [])].sort((a, b) => a.ord - b.ord).map((c) => ({ kind: c.kind, minutes: Number(c.minutes), km: numOrNull(c.km), speed: numOrNull(c.speed) })),
});

/** 최근 운동 기록(최근 것부터). 세트는 저장한 순서대로 */
/** 운동 탭이 받는 최근 기록 수. 요약·달력·최고 기록은 이 목록이 아니라 서버 집계(fetchWorkoutOverview·fetchWorkoutCompare)로 센다 */
export const WORKOUT_LIMIT = 30;
export async function fetchWorkouts(memberId: string, limit = WORKOUT_LIMIT): Promise<WorkoutSession[]> {
  const { data, error } = await supabase
    .from('workout_sessions')
    .select('id, member_id, routine_id, day_no, day, started_at, updated_at, finished, source, sheet_tab, sheet_col, sets:workout_sets(item_id, name, set_no, kg, reps, done, ord), cardio:workout_cardio(kind, minutes, km, speed, ord)')
    .eq('member_id', memberId)
    .order('day', { ascending: false })
    .order('started_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as unknown as RawSession[]).map(toSession);
}

/**
 * 담당 회원들의 기록(2.3 트레이너 화면): 그 날짜부터, 최근 것부터 끝까지. 권한은 표의 정책이 막는다(내 회원만).
 * 새 운동 기록은 수정 시각으로 판단하고 '모두 봤어요'는 보인 기록의 시각까지를 본 것으로 적는다. 그래서 한 시점의 기록 전부를 받는다 —
 * 상한을 두면 오늘 고친 며칠 전 기록이 빠지고(v2.3.0 2차 리뷰), 쪽을 나눠 받으면 쪽 사이의 삭제로 밀린 기록이 못 본 채 넘어간다(3차 리뷰)
 */
export async function fetchMembersWorkouts(memberIds: string[], fromDay: string): Promise<WorkoutSession[]> {
  const { data, error } = await supabase.rpc('members_workouts', { p_members: memberIds, p_from: fromDay }).abortSignal(timeoutSignal(AUX_TIMEOUT_MS));
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('bad_members_workouts');
  return (data as RawSession[]).map(toSession);
}

/** 운동 기록 요약(2.1, Codex 3차 리뷰 P2) — 서버 workout_overview. 달력의 기록은 기간 안 전부(최근 30개 제한 없음) */
export interface WorkoutOverview {
  this_week: number;
  this_month: number;
  streak_weeks: number;
  from: string;
  /** 서버가 센 날짜(기기 날짜가 서버 날짜와 이틀 넘게 다르면 서버 날짜) — 달력·이번 달을 이 날짜로 그린다 */
  today?: string;
  days: { day: string; day_no: number | null; started_at: string; strength: boolean; cardio: boolean }[];
  /** 지금 판의 진행 — 그 판을 받은 날 이후에 그 판으로 한 운동 기록만 */
  routine: { id: string; last: Record<string, string>; latest_day_no: number | null } | null;
}
/**
 * 보조 조회(요약·비교)의 제한 시간 — 응답이 끝나지 않으면 '확인 중'이 끝나지 않았다(적대 검토). 시간이 지나면 실패로 바꿔 다시 불러오기를 보인다.
 * AbortSignal.timeout이 없는 옛 브라우저(iOS 15 등)는 직접 만든다
 */
const AUX_TIMEOUT_MS = 15_000;
const timeoutSignal = (ms: number) => {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
};

export async function fetchWorkoutOverview(memberId: string, today: string): Promise<WorkoutOverview> {
  const { data, error } = await supabase.rpc('workout_overview', { p_member: memberId, p_today: today }).abortSignal(timeoutSignal(AUX_TIMEOUT_MS));
  if (error) throw error;
  const d = data as WorkoutOverview | null;
  if (!d || typeof d.this_week !== 'number' || !Array.isArray(d.days)) throw new Error('bad_overview');
  return d;
}

/** 기록 카드 비교: 기록 id → 운동 이름 → 그 앞의 모든 기록에서 가장 무거운 무게(숫자 묶음)·지난번 무게(서버 workout_compare) */
export type WorkoutCompare = Record<string, Record<string, { prior: number[] | null; prev: string | null }>>;
export async function fetchWorkoutCompare(memberId: string, sessionIds: string[]): Promise<WorkoutCompare> {
  if (!sessionIds.length) return {};
  const { data, error } = await supabase.rpc('workout_compare', { p_member: memberId, p_sessions: sessionIds }).abortSignal(timeoutSignal(AUX_TIMEOUT_MS));
  if (error) throw error;
  if (!data || typeof data !== 'object') throw new Error('bad_compare');
  return data as WorkoutCompare;
}

export const PERIOD_WORKOUTS_LIMIT = 300;
/** 변화 보고서(2.3): 그 기간의 기록. 많으면 최근 것부터 한도까지 */
export async function fetchWorkoutsBetween(memberId: string, from: string, to: string): Promise<WorkoutSession[]> {
  const { data, error } = await supabase
    .from('workout_sessions')
    .select('id, member_id, routine_id, day_no, day, started_at, updated_at, finished, source, sheet_tab, sheet_col, sets:workout_sets(item_id, name, set_no, kg, reps, done, ord), cardio:workout_cardio(kind, minutes, km, speed, ord)')
    .eq('member_id', memberId)
    .gte('day', from)
    .lte('day', to)
    .order('day', { ascending: false })
    .order('started_at', { ascending: false })
    .limit(PERIOD_WORKOUTS_LIMIT)
    .abortSignal(timeoutSignal(AUX_TIMEOUT_MS));
  if (error) throw error;
  return ((data ?? []) as unknown as RawSession[]).map(toSession);
}

/** 변화 보고서: 날마다·끼니마다의 평가. 점수 합은 서버 규칙(private.rating_score)으로 센다 */
export interface DietPeriod {
  days: { day: string; meals: number; rated: number; score_sum: number }[];
  types: { meal_type: string; great: number; good: number; care: number; none: number }[];
}
export async function fetchDietPeriod(memberId: string, from: string, to: string): Promise<DietPeriod> {
  const { data, error } = await supabase.rpc('diet_period', { p_member: memberId, p_from: from, p_to: to }).abortSignal(timeoutSignal(AUX_TIMEOUT_MS));
  if (error) throw error;
  const d = data as DietPeriod | null;
  if (!d || !Array.isArray(d.days) || !Array.isArray(d.types)) throw new Error('bad_period');
  return d;
}

/** 변화 보고서의 트레이너 총평(인바디 측정 하나에 하나). 없으면 null */
export interface ReportNote {
  body: string;
  trainer: string | null;
  updated_at: string;
}
export async function fetchReportNote(inbodyId: string): Promise<ReportNote | null> {
  const { data, error } = await supabase.rpc('report_note', { p_inbody: inbodyId }).abortSignal(timeoutSignal(AUX_TIMEOUT_MS));
  if (error) throw error;
  return (data as ReportNote | null) ?? null;
}
export async function saveReportNote(inbodyId: string, body: string) {
  const { error } = await supabase.rpc('save_report_note', { p_inbody: inbodyId, p_body: body });
  if (error) throw error;
}

/** 그날 운동 기록 저장. sessionId는 운동을 시작할 때 한 번 만든 값 — 다시 보내도 두 번 생기지 않는다 */
/**
 * base = 이 기기가 읽은 기록의 수정 시각(새 기록이면 null), saveId = 이 저장 요청의 id(다시 보내도 한 번만).
 * 돌려주는 값 = 새 수정 시각. 실패 코드: 'conflict'(다른 기기가 먼저 고침) · 'gone'(그사이 지워짐) · 'bad_day'(새 기록은 최근 7일만) · 'failed'
 */
export async function saveWorkout(w: { sessionId: string; day: string; routineId: string | null; dayNo: number | null; sets: WorkoutSet[]; cardio: CardioEntry[]; finished: boolean; base: string | null; saveId: string }): Promise<string> {
  const { data, error } = await supabase.rpc('save_workout', {
    p_session: w.sessionId,
    p_day: w.day,
    p_routine: w.routineId,
    p_sets: w.sets,
    p_finished: w.finished,
    p_day_no: w.dayNo,
    p_base: w.base,
    p_save_id: w.saveId,
    p_cardio: w.cardio,
  });
  if (error) throw new Error(/conflict|gone|bad_day|bad_cardio|sheet_record/.exec(error.message)?.[0] ?? 'failed');
  return data as string;
}

/** 운동 기록 하나(최신). 지워졌으면 null */
export async function fetchWorkout(sessionId: string): Promise<WorkoutSession | null> {
  const { data, error } = await supabase
    .from('workout_sessions')
    .select('id, member_id, routine_id, day_no, day, started_at, updated_at, finished, source, sheet_tab, sheet_col, sets:workout_sets(item_id, name, set_no, kg, reps, done, ord), cardio:workout_cardio(kind, minutes, km, speed, ord)')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return toSession(data as unknown as RawSession);
}

export async function deleteWorkout(sessionId: string) {
  const { error } = await supabase.rpc('delete_workout', { p_session: sessionId });
  if (error) throw error;
}

// ─── v2.4: 운동 찾기 · 운동별 기록 · 지난번 · 동작별 메모(supabase/migrations/20261109000001_exercise_history_memos.sql) ───
// 같은 운동은 비교용 이름(exerciseKey — 공백을 빼고 소문자)으로 가린다. 완료한 세트만, 앱 기록과 시트 기록을 함께 센다

/**
 * 빈 결과가 '정말 없음'인지 확인한다. 서버에서 로그인이 끊긴 기기는 표 정책 때문에 오류 없이 빈 결과를 받아
 * '기록 없음·메모 없음'처럼 보였다(넘기기 전 적대 검토 8). 로그인이 살아 있으면 자기 프로필은 늘 보인다
 */
async function emptyIsReal() {
  const { data, error } = await supabase.from('profiles').select('id').limit(1);
  if (error) throw error;
  if (!data?.length) throw new Error('session_gone');
}

export interface ExerciseEntry { key: string; name: string; count: number; last: string }
export interface CardioKindEntry { kind: CardioEntry['kind']; count: number; last: string }
/** 운동 찾기 목록: 운동마다 마지막으로 쓴 이름·한 기록 수·마지막 날(많이 한 순서). 유산소는 종류마다 */
export async function fetchExerciseList(memberId: string): Promise<{ strength: ExerciseEntry[]; cardio: CardioKindEntry[] }> {
  const { data, error } = await supabase.rpc('exercise_list', { p_member: memberId });
  if (error) throw error;
  const d = data as { strength?: unknown; cardio?: unknown } | null;
  if (!d || !Array.isArray(d.strength) || !Array.isArray(d.cardio)) throw new Error('bad_list');
  if (!d.strength.length && !d.cardio.length) await emptyIsReal();
  return {
    strength: (d.strength as ExerciseEntry[]).map((x) => ({ key: x.key, name: x.name, count: Number(x.count), last: x.last })),
    cardio: (d.cardio as CardioKindEntry[]).map((x) => ({ kind: x.kind, count: Number(x.count), last: x.last })),
  };
}

export interface ExerciseSet { name: string; set_no: number; kg: string | null; reps: string | null }
export interface ExerciseDay { id: string; day: string; day_no: number | null; source: 'app' | 'sheet'; sets: ExerciseSet[] }
export interface CardioDay { id: string; day: string; day_no: number | null; source: 'app' | 'sheet'; cardio: Omit<CardioEntry, 'kind'>[] }
type RawDay = { id: string; day: string; day_no: number | null; source?: string };
const sourceOf = (s?: string): 'app' | 'sheet' => (s === 'sheet' ? 'sheet' : 'app');

/** 운동별 기록: 그 운동을 한 기록마다 완료한 세트(처음 기록까지, 최근 것부터) */
export async function fetchExerciseHistory(memberId: string, key: string): Promise<ExerciseDay[]> {
  const { data, error } = await supabase.rpc('exercise_history', { p_member: memberId, p_key: key });
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('bad_history');
  if (!data.length) await emptyIsReal();
  return (data as (RawDay & { sets: { name: string; set_no: number; kg: string | number | null; reps: string | number | null }[] | null })[]).map((d) => ({
    id: d.id, day: d.day, day_no: d.day_no, source: sourceOf(d.source),
    sets: (d.sets ?? []).map((x) => ({ name: x.name, set_no: x.set_no, kg: textOrNull(x.kg), reps: textOrNull(x.reps) })),
  }));
}

/** 유산소 종류별 기록(시간·거리·속도) */
export async function fetchCardioHistory(memberId: string, kind: CardioEntry['kind']): Promise<CardioDay[]> {
  const { data, error } = await supabase.rpc('exercise_history', { p_member: memberId, p_key: '', p_kind: kind });
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('bad_history');
  if (!data.length) await emptyIsReal();
  return (data as (RawDay & { cardio: { minutes: string | number; km: string | number | null; speed: string | number | null }[] | null })[]).map((d) => ({
    id: d.id, day: d.day, day_no: d.day_no, source: sourceOf(d.source),
    cardio: (d.cardio ?? []).map((c) => ({ minutes: Number(c.minutes), km: numOrNull(c.km), speed: numOrNull(c.speed) })),
  }));
}

export type LastSets = Record<string, { id: string; day: string; sets: Omit<ExerciseSet, 'name'>[] }>;
/** 지난번: 이름마다 그 운동을 마지막으로 한 기록(day 이전 또는 같은 날, 지금 적는 기록 sessionId는 뺌). 한 적이 없는 이름은 없다 */
export async function fetchLastSets(memberId: string, names: string[], day: string, sessionId: string | null): Promise<LastSets> {
  if (!names.length) return {};
  const { data, error } = await supabase.rpc('last_exercise_sets', { p_member: memberId, p_names: names.slice(0, 80), p_day: day, p_session: sessionId });
  if (error) throw error;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('bad_last');
  const out: LastSets = {};
  for (const [name, v] of Object.entries(data as Record<string, { id: string; day: string; sets: { set_no: number; kg: string | number | null; reps: string | number | null }[] | null }>))
    out[name] = { id: v.id, day: v.day, sets: (v.sets ?? []).map((x) => ({ set_no: x.set_no, kg: textOrNull(x.kg), reps: textOrNull(x.reps) })) };
  return out;
}

export interface ExerciseMemo { key: string; author: 'member' | 'trainer'; name: string; body: string; updated_at: string }
/** 회원의 동작별 메모 전부(회원 칸·트레이너 칸) */
export async function fetchExerciseMemos(memberId: string): Promise<ExerciseMemo[]> {
  // 서버는 한 번에 1,000행까지만 준다 — 운동마다 두 칸이라 넘을 수 있다. 기본 키 순서로 쪽을 나눠 빠짐없이 받는다(Codex v2.4.0 1차 리뷰 P2-4)
  // 메모는 대부분 비어 있어 빈 결과를 확인하지 않는다. 로그인이 끊긴 기기는 앱을 다시 열 때 프로필 확인(App)에서 로그아웃된다
  return fetchAllPages<ExerciseMemo>((from, to) =>
    supabase.from('exercise_memos').select('key, author, name, body, updated_at').eq('member_id', memberId).order('key').order('author').range(from, to),
  );
}

/**
 * 메모 저장: 회원은 자기 칸, 담당 트레이너는 트레이너 칸(누가 부르는지로 서버가 정한다). 빈 글이면 그 칸을 지운다.
 * base = 이 기기가 읽은 그 칸의 수정 시각(없던 칸이면 null). 돌려주는 값 = 새 수정 시각(지웠으면 null).
 * 실패 코드: 'conflict'(다른 기기가 먼저 고침) · 'too_long' · 'not_allowed' · 'failed'
 */
export async function saveExerciseMemo(memberId: string, name: string, body: string, base: string | null): Promise<string | null> {
  const { data, error } = await supabase.rpc('save_exercise_memo', { p_member: memberId, p_name: name, p_body: body, p_base: base });
  if (error) throw new Error(/conflict|too_long|not_allowed/.exec(error.message)?.[0] ?? 'failed');
  return (data as string | null) ?? null;
}

/** 기간 운동 요약: 운동한 날(완료 세트나 유산소가 있는 날)·완료 세트 수·유산소 횟수/시간/거리(적은 거리만 더함, v2.1) */
export interface WorkoutSummary {
  days: number;
  done_sets: number;
  cardio_count: number;
  cardio_minutes: number;
  cardio_km: number;
}
export async function fetchWorkoutSummary(memberId: string, from: string, to: string): Promise<WorkoutSummary> {
  const { data, error } = await supabase.rpc('workout_summary', { p_member: memberId, p_from: from, p_to: to });
  if (error) throw error;
  const d = data as Partial<Record<keyof WorkoutSummary, number | string>> | null;
  if (!d || typeof d.days !== 'number') throw new Error('bad_summary');
  // 유산소 칸은 numeric이라 글자로 올 수 있다. 옛 서버(2.0)는 유산소 칸이 없다 → 0
  return { days: d.days, done_sets: Number(d.done_sets ?? 0), cardio_count: Number(d.cardio_count ?? 0), cardio_minutes: Number(d.cardio_minutes ?? 0), cardio_km: Number(d.cardio_km ?? 0) };
}

// ─── v2.0 루틴 시트 연결(서비스 계정에 '보기'로 공유한 시트) ───
/** 우리 서비스 계정 주소 — 시트를 이 주소에 '보기' 권한으로 공유해야 읽을 수 있다 */
export const SHEETS_ACCOUNT = 'fitory-sheets@example.com';

export interface RoutineSheetLink {
  sheet_id: string;
  last_read_at: string | null;
  last_error: string;
}
/**
 * 서버에서 이 기기의 로그인이 살아 있는가(2.4 — Codex v2.3.3 1차 요청 P3). 로그인이 끊긴 기기는 표 정책 때문에 빈 결과를 받아
 * '시트를 연결하지 않음' 같은 거짓 상태로 보인다. 자기 프로필이 보이면 살아 있다. 조회가 실패하면 오류
 */
export async function sessionAlive(userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('profiles').select('id').eq('id', userId).maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function fetchRoutineSheet(memberId: string): Promise<RoutineSheetLink | null> {
  const { data, error } = await supabase.from('routine_sources').select('sheet_id, last_read_at, last_error').eq('member_id', memberId).maybeSingle();
  if (error) throw error;
  return data as RoutineSheetLink | null;
}

/**
 * 시트 링크(또는 id) 연결 — 링크만 넣으면 바로 연결(확인 코드 없음, 2026-10-30 사용자 결정). 빈 값이면 해제.
 * 실패 코드: 'sheet_taken'(다른 회원에게 연결된 시트 — 운영자 보안 기록에 남음) · 'bad_sheet' · 'failed'
 */
export async function setRoutineSheet(memberId: string, link: string): Promise<void> {
  const { data, error } = await supabase.rpc('set_routine_sheet', { p_member: memberId, p_sheet: link });
  if (error) throw new Error(/bad_sheet/.test(error.message) ? 'bad_sheet' : 'failed');
  if ((data as { status?: string } | null)?.status === 'taken') throw new Error('sheet_taken');
}

/**
 * 시트 자동 반영 결과: updated(새 판 저장)·same(새 판은 없음 — v2.1부터 목표 중량을 고쳤거나 회차 기록을 가져왔을 수 있어 화면을 다시 받는다)·
 * fresh(1시간 안에 읽어 이번엔 안 읽음, 화면 그대로)
 */
export interface SheetSync {
  /** superseded = 이 읽기가 끝나기 전에 더 새 읽기가 시작돼 저장하지 않음(그 읽기가 저장한다) — 화면은 '같음'처럼 다시 받는다 */
  status: 'updated' | 'same' | 'fresh' | 'superseded';
  version: number | null;
  tab?: string;
  problems?: string[];
}
/** 서버 기능을 부르고 실패면 그 기능이 돌려준 오류 코드로 던진다 */
async function invokeFn<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    const b = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new Error(b?.error ?? 'failed');
  }
  return data as T;
}

/** v2.1 시트의 지난 기록: 미리보기(탭마다 가져올 회차 수·읽지 못한 칸) — 저장하지 않는다 */
export interface SheetRecordsPreview {
  status: 'preview';
  /** sessions = 가져올 회차(앱 기록과 겹쳐 건너뛸 회차는 skipped로 따로) */
  tabs: { tab: string; sessions: number; skipped?: number; problems: string[] }[];
  /** 이미 가져온 기록 가운데 시트에서 없어져 지울 수(가져올 것이 0개여도 이것이 있으면 맞추기를 한다) */
  removes?: number;
}
export async function previewSheetRecords(memberId: string): Promise<SheetRecordsPreview> {
  const d = await invokeFn<SheetRecordsPreview>('sheet-import', { member: memberId, mode: 'records_all', preview: true });
  if (d?.status !== 'preview' || !Array.isArray(d.tabs)) throw new Error('failed');
  return d;
}
/**
 * v2.1 시트의 지난 기록 가져오기: 연월 탭 전부. 같은 회차는 하나만(다시 가져와도), 앱 기록이 있는 회차는 건너뜀.
 * removed = 저장하면서 실제로 지운 가져온 기록 수(시트에서 없어진 회차·탭) — 미리보기의 removes는 미리보기 때의 수라 안내에 쓰지 않는다
 */
export async function importSheetRecords(memberId: string): Promise<{ saved: number; skipped: number; removed: number; problems: string[] }> {
  const d = await invokeFn<{ status: string; saved: number; skipped: number; removed?: number; problems?: string[] }>('sheet-import', { member: memberId, mode: 'records_all' });
  if (d?.status !== 'imported') throw new Error('failed');
  return { saved: d.saved ?? 0, skipped: d.skipped ?? 0, removed: d.removed ?? 0, problems: d.problems ?? [] };
}

/**
 * v2.1 앱 기록을 연결한 시트에 써 넣기(서버 기능 sheet-write, 서버가 DB의 기록을 다시 읽어 쓴다).
 * status: written·partial(시트에 없는 운동 skipped·이미 값이 있어 둔 칸 kept)·nothing(완료 세트 없음)·not_sheet/no_sheet(쓸 대상 아님)·
 * denied(편집 권한 없음)·no_column(빈 회차 칸 없음)·busy(같은 회원의 먼저 보낸 쓰기가 끝나지 않아 이번에는 쓰지 않음)·
 * unknown(시트에 보낸 쓰기의 결과를 모름 — 적혔을 수 있다). 연결·서버 실패는 'failed'로 던진다
 */
export interface SheetWrite {
  status: 'written' | 'partial' | 'nothing' | 'not_sheet' | 'no_sheet' | 'denied' | 'no_column' | 'busy' | 'unknown';
  tab?: string;
  col?: string;
  skipped?: string[];
  kept?: string[];
  /** 이 쓰기 뒤 앱이 쓴 운동 칸 수(0이면 모두 이미 적힌 칸이었음) */
  owned?: number;
}
export async function writeSheetRecord(sessionId: string): Promise<SheetWrite> {
  const d = await invokeFn<SheetWrite>('sheet-write', { session: sessionId });
  if (!d || !['written', 'partial', 'nothing', 'not_sheet', 'no_sheet', 'denied', 'no_column', 'busy', 'unknown'].includes(d.status)) throw new Error('failed');
  return d;
}

/**
 * 연결된 시트를 서버 기능이 읽어 해석하고, 바뀌었으면 루틴 새 판으로 저장한다(2026-10-30 자동 반영).
 * force가 아니면 마지막으로 읽은 지 1시간 안일 때 다시 읽지 않는다. 실패 코드: 'no_access'(공유 안 됨)·'no_items'·'no_tab'·'unlinked'·'failed'
 */
export async function syncRoutineSheet(memberId: string, force = false): Promise<SheetSync> {
  const { data, error } = await supabase.functions.invoke('sheet-import', { body: { member: memberId, force } });
  if (error) {
    const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new Error(body?.error ?? 'failed');
  }
  const d = data as SheetSync | null;
  if (!d || !['updated', 'same', 'fresh', 'superseded'].includes(d.status)) throw new Error('failed');
  return d;
}
