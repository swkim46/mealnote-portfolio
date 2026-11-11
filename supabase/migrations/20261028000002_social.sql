-- v1.8 (2026-10-28 트레이너 의견 + 사용자 요청): 한마디 좋아요 · 이달의 식단왕 · 트레이너가 고른 식단 공유 · 담당에서 내보내기
-- 공통: 쓰기는 함수로만. 함수는 행 잠금 뒤 세션 확인, 담당 관계는 지금의 assignments로만 판단한다(내보낸 뒤 바로 끊긴다).

-- ─── 1. 트레이너 한마디 좋아요 ───
-- 회원 1명이 그날 한마디에 한 번(다시 누르면 취소). 한마디를 지우면 좋아요도 함께 지워진다. 트레이너에게 푸시는 없다.
create table public.trainer_message_likes (
  trainer_id  uuid not null,
  day         date not null,
  member_id   uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (trainer_id, day, member_id),
  foreign key (trainer_id, day) references public.trainer_messages (trainer_id, day) on delete cascade
);
alter table public.trainer_message_likes enable row level security;
-- 회원은 자기 좋아요만 읽는다(다른 회원 이름은 트레이너만 함수로 본다)
create policy trainer_message_likes_select on public.trainer_message_likes for select to authenticated
using (member_id = (select auth.uid()));
create policy session_alive on public.trainer_message_likes as restrictive for all to authenticated
using ((select private.session_ok())) with check ((select private.session_ok()));
revoke all on public.trainer_message_likes from anon, authenticated;
grant select on public.trainer_message_likes to authenticated;

create function public.set_message_like(p_day date, p_on boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_trainer uuid;
begin
  if v_uid is null then raise exception 'not_allowed'; end if;
  select a.trainer_id into v_trainer from public.assignments a where a.member_id = v_uid for update;
  if not private.session_ok() or v_trainer is null then raise exception 'not_allowed'; end if;
  if p_day is null or p_day not between current_date - 2 and current_date + 2 then raise exception 'bad_day'; end if;
  if p_on then
    if not exists (select 1 from public.trainer_messages tm where tm.trainer_id = v_trainer and tm.day = p_day) then
      raise exception 'no_message';
    end if;
    insert into public.trainer_message_likes (trainer_id, day, member_id) values (v_trainer, p_day, v_uid)
    on conflict do nothing;
  else
    delete from public.trainer_message_likes l where l.trainer_id = v_trainer and l.day = p_day and l.member_id = v_uid;
  end if;
end;
$$;

-- 트레이너: 그날 내 한마디에 좋아요를 누른 지금 담당 회원
create function public.message_likers(p_day date)
returns table (nickname text, liked_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  return query
    select p.nickname, l.created_at
      from public.trainer_message_likes l
      join public.assignments a on a.member_id = l.member_id and a.trainer_id = l.trainer_id
      join public.profiles p on p.id = l.member_id
     where l.trainer_id = (select auth.uid()) and l.day = p_day
     order by l.created_at;
end;
$$;

-- 알림 목록: 종 버튼 점 판단용 handled(20261028000001 설명)와 트레이너 소식 'liked'
drop function public.my_activity(int, timestamptz, text);
create function public.my_activity(p_limit int default 50, p_before_at timestamptz default null, p_before_key text default null)
returns table (key text, kind text, at timestamptz, meal_id uuid, eaten_on date, meal_type text, actor text, handled boolean)
language sql stable security definer set search_path = ''
as $$
  with me as (
    select p.id, p.role from public.profiles p where p.id = (select auth.uid()) and private.session_ok()
  ), ev as (
    select 'rated:' || m.id as key, 'rated'::text as kind, m.rated_at as at, m.id as meal_id, m.eaten_on, m.meal_type, coalesce(t.nickname, '트레이너') as actor,
           m.member_seen_at >= m.rated_at as handled
      from me join public.meals m on m.member_id = me.id left join public.profiles t on t.id = m.rated_by
     where me.role = 'member' and m.rated_at is not null
    union all
    select 'replied:' || c.id, 'replied', c.created_at, m.id, m.eaten_on, m.meal_type, coalesce(t.nickname, '트레이너'),
           m.member_seen_at >= c.created_at
      from me join public.meals m on m.member_id = me.id
      join public.comments c on c.meal_id = m.id and c.author_role = 'trainer'
      left join public.profiles t on t.id = c.author_id
     where me.role = 'member'
    union all
    select 'recorded:' || m.id, case when btrim(coalesce(m.note, '')) <> '' then 'recorded_note' else 'recorded' end, m.created_at, m.id, m.eaten_on, m.meal_type, mp.nickname,
           coalesce(m.reviewed_at >= m.created_at, false)
      from me join public.assignments a on a.trainer_id = me.id
      join public.meals m on m.member_id = a.member_id join public.profiles mp on mp.id = m.member_id
     where me.role = 'trainer'
    union all
    select 'question:' || c.id, 'question', c.created_at, m.id, m.eaten_on, m.meal_type, mp.nickname,
           coalesce(m.reviewed_at >= c.created_at, false) or private.meal_last_trainer_comment_at(m) > c.created_at
      from me join public.assignments a on a.trainer_id = me.id
      join public.meals m on m.member_id = a.member_id join public.profiles mp on mp.id = m.member_id
      join public.comments c on c.meal_id = m.id and c.author_role = 'member'
     where me.role = 'trainer'
    union all
    -- 등록 뒤 1분 넘게 지나 고친 한마디(앱의 noteEdited와 같은 기준)
    select 'note_edited:' || m.id, 'note_edited', m.note_updated_at, m.id, m.eaten_on, m.meal_type, mp.nickname,
           coalesce(m.reviewed_at >= m.note_updated_at, false) or private.meal_last_trainer_comment_at(m) > m.note_updated_at
      from me join public.assignments a on a.trainer_id = me.id
      join public.meals m on m.member_id = a.member_id join public.profiles mp on mp.id = m.member_id
     where me.role = 'trainer' and btrim(coalesce(m.note, '')) <> '' and m.note_updated_at > m.created_at + interval '1 minute'
    union all
    -- 트레이너 한마디에 지금 담당 회원이 누른 좋아요(식사와 무관한 소식이라 meal_id 없음)
    select 'liked:' || l.day || ':' || l.member_id, 'liked', l.created_at, null::uuid, l.day, null::text, mp.nickname, false
      from me join public.trainer_message_likes l on l.trainer_id = me.id
      join public.assignments a on a.member_id = l.member_id and a.trainer_id = me.id
      join public.profiles mp on mp.id = l.member_id
     where me.role = 'trainer'
  )
  select ev.key, ev.kind, ev.at, ev.meal_id, ev.eaten_on, ev.meal_type, ev.actor, coalesce(ev.handled, false) from ev
   where ev.at > now() - interval '7 days' -- 최근 1주일(2026-10-27 사용자 결정)
     and (p_before_at is null or (ev.at, ev.key) < (p_before_at, coalesce(p_before_key, '')))
   order by ev.at desc, ev.key desc
   limit least(greatest(p_limit, 1), 100);
$$;

revoke execute on function public.my_activity(int, timestamptz, text) from public, anon;
grant execute on function public.my_activity(int, timestamptz, text) to authenticated;

-- ─── 2. 이달의 식단왕 ───
-- 이번 달(기기의 한국 날짜 기준) 식사 10끼 이상 회원 중 평가왕(평가 평균, 동점이면 기록한 날 수)과
-- 꾸준왕(이번 달 안에서 가장 길게 이어간 연속 기록, 동점이면 끼니 수). 범위는 호출자의 담당 트레이너(트레이너면 본인).
-- 닉네임과 지표만 돌려준다. 다른 회원의 닉네임이 회원에게 보이는 곳은 여기와 같은 트레이너 범위뿐이다.
create function public.monthly_kings(p_today date)
returns table (kind text, nickname text, score numeric, is_me boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_trainer uuid; v_from date;
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if p_today is null or p_today not between current_date - 2 and current_date + 2 then raise exception 'bad_day'; end if;
  select case when p.role = 'trainer' then p.id else (select a.trainer_id from public.assignments a where a.member_id = v_uid) end
    into v_trainer from public.profiles p where p.id = v_uid;
  if v_trainer is null then return; end if;
  v_from := date_trunc('month', p_today)::date;
  return query
    with ms as (
      select m.member_id, m.eaten_on, m.rating
        from public.assignments a join public.meals m on m.member_id = a.member_id
       where a.trainer_id = v_trainer and m.eaten_on between v_from and p_today
    ), cand as (
      select ms.member_id, count(*)::int as meals, count(distinct ms.eaten_on)::int as days,
             avg(private.rating_score(ms.rating)) filter (where ms.rating is not null) as avg_score
        from ms group by ms.member_id having count(*) >= 10
    ), runs as (
      select x.member_id, max(x.n)::int as best
        from (select y.member_id, count(*) as n
                from (select d.member_id, d.eaten_on - (row_number() over (partition by d.member_id order by d.eaten_on))::int as grp
                        from (select distinct ms.member_id, ms.eaten_on from ms) d) y
               group by y.member_id, y.grp) x
       group by x.member_id
    ), rating_king as (
      select 'rating'::text as kind, c.member_id, round(c.avg_score, 1) as score
        from cand c join public.profiles p on p.id = c.member_id
       where c.avg_score is not null
       order by c.avg_score desc, c.days desc, p.nickname limit 1
    ), streak_king as (
      select 'streak'::text, c.member_id, r.best::numeric
        from cand c join runs r on r.member_id = c.member_id join public.profiles p on p.id = c.member_id
       order by r.best desc, c.meals desc, p.nickname limit 1
    )
    select k.kind, p.nickname, k.score, k.member_id = v_uid
      from (select * from rating_king union all select * from streak_king) k
      join public.profiles p on p.id = k.member_id;
end;
$$;

-- ─── 3. 트레이너가 고른 식단 공유 ───
-- 회원 동의(기본 꺼짐) → 담당 트레이너가 고른 식사만 → 같은 트레이너의 회원들에게 익명(사진·음식·평가·날짜)으로.
-- 동의를 끄면 그 회원의 공유가 모두 풀린다. 담당이 끊기면(내보내기) 목록·사진 권한에서 바로 빠진다.
alter table public.profiles add column share_consent boolean not null default false;
alter table public.meals add column shared_at timestamptz,
                         add column shared_by uuid references public.profiles(id) on delete set null;

create function public.set_share_consent(p_on boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'not_allowed'; end if;
  perform 1 from public.profiles p where p.id = v_uid and p.role = 'member' for update;
  if not found or not private.session_ok() then raise exception 'not_allowed'; end if;
  update public.profiles set share_consent = coalesce(p_on, false) where id = v_uid;
  if not coalesce(p_on, false) then
    update public.meals set shared_at = null, shared_by = null where member_id = v_uid and shared_at is not null;
  end if;
end;
$$;

create function public.share_meal(p_meal uuid, p_on boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_member uuid;
begin
  if v_uid is null then raise exception 'not_allowed'; end if;
  select m.member_id into v_member from public.meals m where m.id = p_meal for update;
  if not private.session_ok() or v_member is null or not private.is_my_member(v_member) then raise exception 'not_allowed'; end if;
  if p_on then
    if not exists (select 1 from public.profiles p where p.id = v_member and p.share_consent) then raise exception 'no_consent'; end if;
    update public.meals set shared_at = now(), shared_by = v_uid where id = p_meal;
  else
    update public.meals set shared_at = null, shared_by = null where id = p_meal;
  end if;
end;
$$;

-- 호출자가 볼 수 있는 공유 식사인가: 공유한 트레이너 = 그 회원의 지금 담당 = 호출자의 담당(트레이너면 본인), 회원 동의 켜짐
create function private.shared_scope_trainer()
returns uuid language sql stable security definer set search_path = ''
as $$
  select case when p.role = 'trainer' then p.id else (select a.trainer_id from public.assignments a where a.member_id = p.id) end
    from public.profiles p where p.id = (select auth.uid()) and private.session_ok();
$$;

create function public.shared_meals(p_limit int default 20)
returns table (id uuid, eaten_on date, meal_type text, food text, rating smallint, photo_path text, shared_at timestamptz, mine boolean)
language sql stable security definer set search_path = ''
as $$
  select m.id, m.eaten_on, m.meal_type, m.food, m.rating, m.photo_path, m.shared_at, m.member_id = (select auth.uid())
    from public.meals m
    join public.assignments a on a.member_id = m.member_id
    join public.profiles o on o.id = m.member_id
   where m.shared_at is not null and o.share_consent
     and a.trainer_id = m.shared_by and m.shared_by = private.shared_scope_trainer()
   order by m.shared_at desc, m.id
   limit least(greatest(coalesce(p_limit, 20), 1), 30);
$$;

-- 공유 식사의 사진만 같은 범위에서 읽힌다(기존 규칙: 본인·담당 트레이너). 세션 확인 규칙(restrictive)은 그대로 걸린다.
create function private.can_read_shared_photo(p_name text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.meals m
      join public.assignments a on a.member_id = m.member_id
      join public.profiles o on o.id = m.member_id
     where m.photo_path = p_name and m.shared_at is not null and o.share_consent
       and a.trainer_id = m.shared_by and m.shared_by = private.shared_scope_trainer()
  );
$$;
create policy meal_photos_shared_select on storage.objects for select to authenticated
using (bucket_id = 'meal-photos' and private.can_read_shared_photo(name));

-- ─── 4. 담당에서 내보내기 ───
-- 연결(assignments)만 지우고 기록은 둔다. 내보낸 트레이너는 그 회원이 다시 고를 수 없다.
-- 운영자 보안 기록에 '누가 누구를' 남긴다(필요하면 운영자가 README의 SQL로 계정을 지운다).
create table private.member_removals (
  member_id   uuid not null references public.profiles(id) on delete cascade,
  trainer_id  uuid not null references public.profiles(id) on delete cascade,
  removed_at  timestamptz not null default now(),
  primary key (member_id, trainer_id)
);
revoke all on private.member_removals from public, anon, authenticated;

alter table private.security_events add column actor_id uuid references public.profiles(id) on delete set null;
alter table private.security_events drop constraint security_events_kind_check;
alter table private.security_events add constraint security_events_kind_check
  check (kind = any (array['pin_reset_by_answer', 'pin_changed', 'recovery_set', 'recovery_locked', 'reported_not_me', 'reclaimed', 'nickname_changed', 'member_removed']));

create function public.remove_member(p_member uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_trainer uuid;
begin
  if v_uid is null then raise exception 'not_allowed'; end if;
  select a.trainer_id into v_trainer from public.assignments a where a.member_id = p_member for update;
  if not private.session_ok() or v_trainer is distinct from v_uid then raise exception 'not_allowed'; end if;
  delete from public.assignments where member_id = p_member;
  insert into private.member_removals (member_id, trainer_id) values (p_member, v_uid)
  on conflict (member_id, trainer_id) do update set removed_at = now();
  insert into private.security_events (user_id, kind, actor_id) values (p_member, 'member_removed', v_uid);
end;
$$;

-- 담당 트레이너가 없는 회원이 고를 수 있는 트레이너(내보낸 트레이너 제외, 시험 트레이너는 시험 회원에게만)
create function public.trainers_for_me()
returns table (id uuid, nickname text)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.nickname
    from public.profiles me join public.profiles t on t.role = 'trainer' and (not t.is_test or me.is_test)
   where me.id = (select auth.uid()) and me.role = 'member' and private.session_ok()
     and not exists (select 1 from private.member_removals r where r.member_id = me.id and r.trainer_id = t.id)
   order by t.nickname;
$$;

create function public.choose_trainer(p_trainer uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'not_allowed'; end if;
  perform 1 from public.profiles p where p.id = v_uid and p.role = 'member' for update;
  if not found or not private.session_ok() then raise exception 'not_allowed'; end if;
  if exists (select 1 from public.assignments a where a.member_id = v_uid) then raise exception 'already_assigned'; end if;
  if not exists (select 1 from public.trainers_for_me() t where t.id = p_trainer) then raise exception 'not_allowed'; end if;
  insert into public.assignments (member_id, trainer_id) values (v_uid, p_trainer);
end;
$$;

-- 운영자 보안 기록: 내보내기는 '트레이너 → 회원'으로 보이게 누가 했는지(actor)를 더한다
drop function public.admin_security_events();
create function public.admin_security_events()
returns table (nickname text, kind text, created_at timestamptz, actor text)
language sql stable security definer set search_path = ''
as $$
  select p.nickname, e.kind, e.created_at, ap.nickname
    from private.security_events e join public.profiles p on p.id = e.user_id
    left join public.profiles ap on ap.id = e.actor_id
   where private.is_admin() and private.session_ok()
     and e.kind in ('reported_not_me', 'reclaimed', 'recovery_locked', 'nickname_changed', 'member_removed')
   order by e.created_at desc limit 100;
$$;

revoke execute on function public.set_message_like(date, boolean), public.message_likers(date), public.monthly_kings(date),
  public.set_share_consent(boolean), public.share_meal(uuid, boolean), public.shared_meals(int),
  public.remove_member(uuid), public.trainers_for_me(), public.choose_trainer(uuid), public.admin_security_events() from public, anon;
grant execute on function public.set_message_like(date, boolean), public.message_likers(date), public.monthly_kings(date),
  public.set_share_consent(boolean), public.share_meal(uuid, boolean), public.shared_meals(int),
  public.remove_member(uuid), public.trainers_for_me(), public.choose_trainer(uuid), public.admin_security_events() to authenticated;
revoke execute on function private.shared_scope_trainer(), private.can_read_shared_photo(text) from public, anon;
grant execute on function private.shared_scope_trainer(), private.can_read_shared_photo(text) to authenticated;
