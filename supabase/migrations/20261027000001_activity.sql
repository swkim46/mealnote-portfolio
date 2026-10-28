-- v1.7 알림 모아보기(2026-10-27 사용자 요청): 최근 1주일 동안 받은 소식을 시간순으로 모아 본다. 누르면 그 식사 상세로.
-- 회원: 트레이너의 평가·답글. 트레이너: 담당 회원의 식사 기록·질문(댓글·고친 한마디). 끼니 기록 알림은 넣지 않는다.
-- 따로 기록 표를 두지 않고 식사·댓글에서 바로 만든다. 식단·댓글 원문은 돌려주지 않는다(종류·식사·이름·시각만).

-- 마지막으로 알림 목록을 연 시각(서버 시계). 모든 기기에서 같은 기준으로 새 소식 점을 보인다.
create table public.activity_seen (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  seen_at  timestamptz not null default now()
);
alter table public.activity_seen enable row level security;
create policy activity_seen_own on public.activity_seen for select to authenticated using (user_id = (select auth.uid()));
create policy session_alive on public.activity_seen as restrictive for all to authenticated
  using ((select private.session_ok())) with check ((select private.session_ok()));
revoke all on public.activity_seen from public, anon;
grant select on public.activity_seen to authenticated;

-- p_through: 화면에 실제로 보여 준 가장 새 소식의 시각. 그 시각까지만 읽음으로 옮긴다(뒤로 돌리지 않고, 지금보다 앞으로 가지 않는다).
-- 목록을 못 불러왔거나 아직 보여 주지 않은 소식은 읽음이 되지 않게 앱이 성공한 목록 기준으로 부른다(Codex v1.7 품질 리뷰 3).
create function public.mark_activity_seen(p_through timestamptz)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_through is null then return; end if;
  insert into public.activity_seen (user_id, seen_at) values (v_uid, least(p_through, now()))
  on conflict (user_id) do update set seen_at = greatest(public.activity_seen.seen_at, excluded.seen_at);
end;
$$;

-- kind: rated(평가)·replied(답글) — 회원 / recorded(기록)·recorded_note(한마디와 함께 기록)·question(댓글)·note_edited(한마디 고침) — 트레이너
-- 쪽 나누기(Codex v1.7 리뷰 3): (at, key) 내림차순으로 고정하고, 앞 쪽 마지막 항목의 (at, key)를 넘기면 그다음부터 준다.
-- key는 소식 하나를 가리킨다(식사 사건은 종류:식사 ID, 댓글은 종류:댓글 ID) — 같은 시각의 소식도 빠지거나 겹치지 않는다.
create function public.my_activity(p_limit int default 50, p_before_at timestamptz default null, p_before_key text default null)
returns table (key text, kind text, at timestamptz, meal_id uuid, eaten_on date, meal_type text, actor text)
language sql stable security definer set search_path = ''
as $$
  with me as (
    select p.id, p.role from public.profiles p where p.id = (select auth.uid()) and private.session_ok()
  ), ev as (
    select 'rated:' || m.id as key, 'rated'::text as kind, m.rated_at as at, m.id as meal_id, m.eaten_on, m.meal_type, coalesce(t.nickname, '트레이너') as actor
      from me join public.meals m on m.member_id = me.id left join public.profiles t on t.id = m.rated_by
     where me.role = 'member' and m.rated_at is not null
    union all
    select 'replied:' || c.id, 'replied', c.created_at, m.id, m.eaten_on, m.meal_type, coalesce(t.nickname, '트레이너')
      from me join public.meals m on m.member_id = me.id
      join public.comments c on c.meal_id = m.id and c.author_role = 'trainer'
      left join public.profiles t on t.id = c.author_id
     where me.role = 'member'
    union all
    select 'recorded:' || m.id, case when btrim(coalesce(m.note, '')) <> '' then 'recorded_note' else 'recorded' end, m.created_at, m.id, m.eaten_on, m.meal_type, mp.nickname
      from me join public.assignments a on a.trainer_id = me.id
      join public.meals m on m.member_id = a.member_id join public.profiles mp on mp.id = m.member_id
     where me.role = 'trainer'
    union all
    select 'question:' || c.id, 'question', c.created_at, m.id, m.eaten_on, m.meal_type, mp.nickname
      from me join public.assignments a on a.trainer_id = me.id
      join public.meals m on m.member_id = a.member_id join public.profiles mp on mp.id = m.member_id
      join public.comments c on c.meal_id = m.id and c.author_role = 'member'
     where me.role = 'trainer'
    union all
    -- 등록 뒤 1분 넘게 지나 고친 한마디(앱의 noteEdited와 같은 기준)
    select 'note_edited:' || m.id, 'note_edited', m.note_updated_at, m.id, m.eaten_on, m.meal_type, mp.nickname
      from me join public.assignments a on a.trainer_id = me.id
      join public.meals m on m.member_id = a.member_id join public.profiles mp on mp.id = m.member_id
     where me.role = 'trainer' and btrim(coalesce(m.note, '')) <> '' and m.note_updated_at > m.created_at + interval '1 minute'
  )
  select ev.key, ev.kind, ev.at, ev.meal_id, ev.eaten_on, ev.meal_type, ev.actor from ev
   where ev.at > now() - interval '7 days' -- 최근 1주일(2026-10-27 사용자 결정)
     and (p_before_at is null or (ev.at, ev.key) < (p_before_at, coalesce(p_before_key, '')))
   order by ev.at desc, ev.key desc
   limit least(greatest(p_limit, 1), 100);
$$;

revoke execute on function public.mark_activity_seen(timestamptz), public.my_activity(int, timestamptz, text) from public, anon;
grant execute on function public.mark_activity_seen(timestamptz), public.my_activity(int, timestamptz, text) to authenticated;
