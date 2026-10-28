import { supabase } from './supabase';
import type { Comment, InbodyInput, InbodyRecord, Meal, MealInput } from './types';
import { uuid } from './uuid';
import { fetchAllPages } from './paging';
import type { DietReport } from './report';

/** 회원 목록·트레이너의 회원별 기록에 불러오는 기간. 그보다 오래된 날짜는 기록 화면에서 고를 때 따로 불러온다. */
export const WINDOW_DAYS = 60;
/** 트레이너 확인 목록은 최근 2주 + 처리할 식사만 받는다(1분마다 새로 고치므로 가볍게). */
export const TRAINER_RECENT_DAYS = 14;

const BUCKET = 'meal-photos';
const MEAL_SELECT =
  'id, member_id, eaten_on, eaten_at, meal_type, food, note, photo_path, created_at, reviewed_at, member_seen_at, note_updated_at, member_msg_at, trainer_msg_at, rating, rated_at, ' +
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

/** 비공개 사진의 1시간짜리 주소 */
export async function signPhotos(paths: string[]): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600);
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const item of data ?? []) if (item.path && item.signedUrl) out[item.path] = item.signedUrl;
  return out;
}

export async function fetchMyTrainerName(): Promise<string> {
  const { data, error } = await supabase
    .from('assignments')
    .select('trainer:profiles!assignments_trainer_id_fkey(nickname)')
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as { trainer: { nickname: string } | null } | null)?.trainer?.nickname ?? '';
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
export async function saveTrainerMessage(day: string, body: string) {
  const { error } = await supabase.rpc('set_trainer_message', { p_day: day, p_body: body });
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
