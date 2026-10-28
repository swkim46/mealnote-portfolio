-- v1.7 푸시 알림(2026-10-26 계획: docs/reference/푸시알림_계획_261026.md).
-- 식사·댓글 저장 경로에는 트리거를 달지 않는다. 10분마다 상태를 훑어 알림을 만들고(push_claim),
-- 보낼 때마다(재시도 포함) 근거가 아직 유효한지 다시 확인한다. 알림 문구에는 건수·종류만 쓰고 원문·이름은 쓰지 않는다.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ─── 판정: 앱의 src/lib/status.ts와 같은 의미 ───────────────────────────────
-- 회원 쪽 마지막 말 시각: 한마디(비어 있지 않으면 note_updated_at)와 회원 댓글 중 늦은 것 (thread()와 같음)
create function private.meal_last_member_at(m public.meals)
returns timestamptz language sql stable security definer set search_path = ''
as $$
  select greatest(
    case when btrim(coalesce(m.note, '')) <> '' then coalesce(m.note_updated_at, m.created_at) end,
    (select max(c.created_at) from public.comments c where c.meal_id = m.id and c.author_role = 'member'));
$$;

create function private.meal_last_trainer_comment_at(m public.meals)
returns timestamptz language sql stable security definer set search_path = ''
as $$ select max(c.created_at) from public.comments c where c.meal_id = m.id and c.author_role = 'trainer' $$;

-- pendingQuestion: 대화의 마지막이 회원 말이고, 트레이너가 그 뒤에 확인(reviewed_at)하지 않았음
create function private.meal_pending_question(m public.meals)
returns boolean language sql stable security definer set search_path = ''
as $$
  select x.lm is not null and (x.lt is null or x.lm > x.lt) and (m.reviewed_at is null or m.reviewed_at < x.lm)
    from (select private.meal_last_member_at(m) as lm, private.meal_last_trainer_comment_at(m) as lt) x;
$$;

-- hasNewFeedback: 마지막 트레이너 댓글이나 평가가 회원이 읽은 시각보다 늦음
create function private.meal_feedback_at(m public.meals)
returns timestamptz language sql stable security definer set search_path = ''
as $$ select greatest(private.meal_last_trainer_comment_at(m), m.rated_at) $$;

create function private.meal_new_feedback(m public.meals)
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce(private.meal_feedback_at(m) > m.member_seen_at, false) $$;

-- 트레이너 확인 목록과 같은 범위(api.ts fetchMeals trainer: 최근 2주 · 확인 안 함 · 최근 60일 안 회원 말)의 처리할 식사.
-- kind: 'question'(답할 질문) | 'review'(확인할 기록), arrived: 트레이너에게 새로 들어온 시각
create function private.trainer_attention(p_trainer uuid)
returns table (meal_id uuid, kind text, arrived timestamptz)
language sql stable security definer set search_path = ''
as $$
  select m.id,
         case when q.pending then 'question' else 'review' end,
         case when q.pending then private.meal_last_member_at(m) else m.created_at end
    from public.meals m
    join public.assignments a on a.member_id = m.member_id and a.trainer_id = p_trainer
    cross join lateral (select private.meal_pending_question(m) as pending) q
   where (m.reviewed_at is null or q.pending)
     and (m.eaten_on >= ((now() at time zone 'Asia/Seoul')::date - 14) or m.reviewed_at is null or m.member_msg_at >= now() - interval '60 days');
$$;

-- ─── 표 ───────────────────────────────────────────────────────────────
-- 기기 등록. 행은 register_push로만 만든다(직접 읽기·쓰기 권한 없음).
create table public.push_subscriptions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  session_id        uuid not null,
  endpoint          text not null unique check (char_length(endpoint) <= 1000),
  p256dh            text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth              text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  created_at        timestamptz not null default now(),
  last_accepted_at  timestamptz -- 알림 서버가 마지막으로 접수한 시각(휴대폰 도착 시각이 아님)
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;

-- 종류별 설정: 계정 전체에 적용(2026-10-26 사용자 결정). 행이 없으면 기본값(모두 켬·하루 3회).
create table public.push_prefs (
  user_id       uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  digest        boolean not null default true,
  digest_times  text not null default '3' check (digest_times in ('3', '5')),
  feedback      boolean not null default true,
  reminder      boolean not null default true,
  morning       boolean not null default true, -- 회원: 오전 9시 아침 응원(오늘의 한마디, 2026-10-27 사용자 요청)
  updated_at    timestamptz not null default now()
);
alter table public.push_prefs enable row level security;
create policy push_prefs_own on public.push_prefs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy session_alive on public.push_prefs as restrictive for all to authenticated
  using ((select private.session_ok())) with check ((select private.session_ok()));
revoke all on public.push_prefs from public, anon;
grant select, insert, update on public.push_prefs to authenticated;

-- 알림을 만든 기준(외부 서버 접수 기준이 아님). 켠 기기가 없거나 종류를 꺼서 만들지 않았으면 옮기지 않는다.
create table private.push_state (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  digest_basis_at    timestamptz not null default now(),
  digest_slot        text,
  feedback_basis_at  timestamptz not null default now(), -- 알림을 켠 시각: 그 전 피드백으로는 알리지 않는다(식사별 기록은 push_feedback_sent)
  lunch_on           date,
  dinner_on          date,
  morning_on         date
);

create table private.push_notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('digest', 'feedback', 'lunch', 'dinner', 'morning', 'test')),
  slot_key     text not null,
  basis_from   timestamptz,
  basis_until  timestamptz,
  -- 새 피드백 알림이 알리는 '그 피드백': 식사와 그때의 피드백 시각을 같은 순서로 둔다.
  -- 보낼 때 이 피드백을 읽었는지로 판단한다(같은 식사에 나중에 생긴 피드백을 근거로 쓰지 않는다 · Codex v1.7 리뷰 1)
  meal_ids     uuid[],
  feedback_ats timestamptz[],
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  unique (user_id, kind, slot_key)
);

create table private.push_deliveries (
  notification_id  uuid not null references private.push_notifications(id) on delete cascade,
  subscription_id  uuid not null references public.push_subscriptions(id) on delete cascade,
  status           text not null default 'pending' check (status in ('pending', 'sending', 'retry', 'sent', 'failed', 'canceled')),
  attempts         int not null default 0,
  next_try_at      timestamptz not null default now(),
  locked_until     timestamptz,
  last_error_code  int,
  primary key (notification_id, subscription_id)
);
-- 새 피드백을 식사마다 어디까지 알렸는지. 시각 하나로 자르면 저장과 알림 만들기가 겹칠 때
-- 저장 시각이 기준보다 앞에 찍힌 피드백을 영영 놓칠 수 있어서(2026-10-27) 식사 단위로 기록한다.
create table private.push_feedback_sent (
  meal_id      uuid primary key references public.meals(id) on delete cascade,
  feedback_at  timestamptz not null
);

create index push_deliveries_due_idx on private.push_deliveries (next_try_at) where status in ('pending', 'retry', 'sending');
revoke all on private.push_state, private.push_notifications, private.push_deliveries, private.push_feedback_sent from public, anon, authenticated;

-- 송신 스위치: off(아무도) · testers(push_testers의 사용자 ID만) · all. 운영은 testers로 배포해 두 휴대폰 확인 뒤 all.
insert into public.app_settings (key, value) values ('push_mode', 'off'), ('push_testers', '') on conflict (key) do nothing;

create function private.push_allowed(p_uid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select case (select value from public.app_settings where key = 'push_mode')
           when 'all' then true
           when 'testers' then p_uid::text = any (string_to_array(coalesce((select value from public.app_settings where key = 'push_testers'), ''), ','))
           else false end;
$$;

create function private.push_pref(p_uid uuid, p_kind text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select case p_kind
           when 'digest' then coalesce((select digest from public.push_prefs where user_id = p_uid), true)
           when 'feedback' then coalesce((select feedback from public.push_prefs where user_id = p_uid), true)
           when 'lunch' then coalesce((select reminder from public.push_prefs where user_id = p_uid), true)
           when 'dinner' then coalesce((select reminder from public.push_prefs where user_id = p_uid), true)
           when 'morning' then coalesce((select morning from public.push_prefs where user_id = p_uid), true)
           else true end;
$$;

-- ─── 기기 등록(앱) ─────────────────────────────────────────────────────
-- 알려진 푸시 서비스 주소만 받는다. 로컬 검증은 app_settings.push_test_endpoint_prefix(로컬에서만 넣음)로 시험 수신 서버를 허용한다.
create function private.push_endpoint_ok(p_endpoint text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select p_endpoint ~ '^https://(fcm\.googleapis\.com|[a-z0-9.-]+\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com)/'
      or coalesce((select starts_with(p_endpoint, s.value) and s.value <> '' from public.app_settings s where s.key = 'push_test_endpoint_prefix'), false);
$$;

create function public.register_push(p_endpoint text, p_p256dh text, p_auth text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_sid uuid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  v_old public.push_subscriptions%rowtype;
begin
  if v_uid is null or v_sid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('member', 'trainer')) then
    return jsonb_build_object('status', 'not_supported');
  end if;
  if p_endpoint is null or char_length(p_endpoint) > 1000 or not private.push_endpoint_ok(p_endpoint) then
    return jsonb_build_object('status', 'bad_endpoint');
  end if;
  select * into v_old from public.push_subscriptions where endpoint = p_endpoint for update;
  if found and v_old.user_id <> v_uid then
    -- 같은 브라우저에서 계정을 바꿈: 이전 계정의 대기 알림이 새 계정에 가지 않게 행을 지우고(전송 대기도 함께) 새 ID로 만든다
    delete from public.push_subscriptions where id = v_old.id;
  elsif found then
    update public.push_subscriptions set p256dh = p_p256dh, auth = p_auth, session_id = v_sid where id = v_old.id;
    insert into private.push_state (user_id) values (v_uid) on conflict (user_id) do nothing;
    return jsonb_build_object('status', 'ok');
  end if;
  -- 한 계정 기기 10대까지: 넘으면 가장 오래된 것부터 지운다
  delete from public.push_subscriptions where id in (
    select id from public.push_subscriptions where user_id = v_uid order by created_at desc offset 9);
  insert into public.push_subscriptions (user_id, session_id, endpoint, p256dh, auth) values (v_uid, v_sid, p_endpoint, p_p256dh, p_auth);
  -- 기준 시각은 켠 순간부터: 켜기 전에 쌓인 소식으로 바로 알림이 가지 않게
  insert into private.push_state (user_id) values (v_uid) on conflict (user_id) do nothing;
  return jsonb_build_object('status', 'ok');
end;
$$;

create function public.unregister_push(p_endpoint text)
returns void language sql security definer set search_path = ''
as $$ delete from public.push_subscriptions where endpoint = p_endpoint and user_id = (select auth.uid()) $$;

-- 이 기기(endpoint)가 지금 로그인한 계정·세션으로 등록돼 있나
create function public.push_registered(p_endpoint text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select private.session_ok() and exists (
    select 1 from public.push_subscriptions s
     where s.endpoint = p_endpoint and s.user_id = (select auth.uid())
       and s.session_id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid);
$$;

-- ─── 서버 기능 호출 ──────────────────────────────────────────────────────
-- 함수 주소와 호출 비밀은 Vault에 둔다(push_function_url · push_cron_secret). 없으면 아무것도 하지 않는다.
create function private.push_kick()
returns void language plpgsql security definer set search_path = ''
as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'push_function_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_cron_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret),
    timeout_milliseconds := 10000);
end;
$$;
revoke execute on function private.push_kick() from public, anon, authenticated;

-- 알림 켜기 직후 이 기기로 시험 알림 한 번(30초에 한 번까지)
create function public.push_test()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_sid uuid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  v_id uuid;
begin
  if v_uid is null or not private.session_ok() then raise exception 'not_allowed'; end if;
  if exists (select 1 from private.push_notifications where user_id = v_uid and kind = 'test' and created_at > now() - interval '30 seconds') then
    return jsonb_build_object('status', 'too_soon');
  end if;
  insert into private.push_notifications (user_id, kind, slot_key, expires_at)
  values (v_uid, 'test', clock_timestamp()::text, now() + interval '10 minutes') returning id into v_id;
  insert into private.push_deliveries (notification_id, subscription_id)
  select v_id, s.id from public.push_subscriptions s where s.user_id = v_uid and s.session_id = v_sid;
  if not found then return jsonb_build_object('status', 'not_registered'); end if;
  perform private.push_kick();
  return jsonb_build_object('status', 'ok');
end;
$$;

-- 트레이너가 평가·답글을 저장한 직후 앱이 부른다: 10분 정기 호출을 기다리지 않고 바로 보내기.
-- 저장과 따로 부르므로 실패해도 저장에는 영향이 없다. 서버 기능 호출은 10초에 한 번(전체)으로 묶고,
-- 그 사이에 온 요청은 '대기'로 남겨 10초마다 도는 작업(push_kick_pending)이 처리한다 — 연달아 저장해도 뒤의 피드백이 빠지지 않는다(Codex v1.7 리뷰 2).
create table private.push_kick_state (
  id            int primary key default 1 check (id = 1),
  last_kick_at  timestamptz not null default '-infinity',
  pending       boolean not null default false
);
insert into private.push_kick_state (id) values (1);
revoke all on private.push_kick_state from public, anon, authenticated;

-- 지금 부를 수 있으면 부르고(true), 10초가 안 지났으면 대기로 남긴다(false)
create function private.push_kick_soon()
returns boolean language plpgsql security definer set search_path = ''
as $$
declare st private.push_kick_state%rowtype;
begin
  select * into st from private.push_kick_state where id = 1 for update;
  if st.last_kick_at <= now() - interval '10 seconds' then
    update private.push_kick_state set last_kick_at = now(), pending = false where id = 1;
    perform private.push_kick();
    return true;
  end if;
  update private.push_kick_state set pending = true where id = 1;
  return false;
end;
$$;

create function private.push_kick_pending()
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from private.push_kick_state where id = 1 and pending) then
    perform private.push_kick_soon();
  end if;
end;
$$;

create function public.push_nudge()
returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not private.session_ok()
     or not exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'trainer') then
    return;
  end if;
  perform private.push_kick_soon();
end;
$$;

-- ─── 알림 만들기(10분마다) ────────────────────────────────────────────────
create function private.push_add(p_uid uuid, p_kind text, p_slot text, p_from timestamptz, p_until timestamptz, p_expires timestamptz,
                                  p_meals uuid[] default null, p_feedback_ats timestamptz[] default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  insert into private.push_notifications (user_id, kind, slot_key, basis_from, basis_until, expires_at, meal_ids, feedback_ats)
  values (p_uid, p_kind, p_slot, p_from, p_until, p_expires, p_meals, p_feedback_ats)
  on conflict (user_id, kind, slot_key) do nothing returning id into v_id;
  if v_id is not null then
    insert into private.push_deliveries (notification_id, subscription_id)
    select v_id, s.id from public.push_subscriptions s where s.user_id = p_uid
    on conflict do nothing;
  end if;
end;
$$;

create function private.push_generate(p_now timestamptz)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_now timestamptz := p_now;
  v_kst timestamp := p_now at time zone 'Asia/Seoul';
  v_today date := (p_now at time zone 'Asia/Seoul')::date;
  v_uid uuid;
  v_role text;
  st private.push_state%rowtype;
  v_hours int[];
  v_h int;
  v_slot text;
  v_ids uuid[];
  v_ats timestamptz[];
  v_meal text;
  v_mh int;
begin
  -- 일주일 지난 알림은 정리(전송 기록도 함께)
  delete from private.push_notifications where created_at < v_now - interval '7 days';
  -- 로그아웃·계정 되찾기로 세션이 끝난 기기 등록은 보낼 알림이 없어도 지운다
  delete from public.push_subscriptions s
   where not exists (select 1 from auth.sessions x where x.id = s.session_id and x.user_id = s.user_id);

  for v_uid in select distinct s.user_id from public.push_subscriptions s order by 1 loop
    continue when not private.push_allowed(v_uid);
    select p.role into v_role from public.profiles p where p.id = v_uid;
    insert into private.push_state (user_id) values (v_uid) on conflict (user_id) do nothing;
    -- 사용자별로 잠그고 판정·생성·기준 갱신을 한 번에: 두 호출이 겹쳐도 알림이 두 번 생기지 않는다(+ slot 고유 제약)
    select * into st from private.push_state where user_id = v_uid for update;

    if v_role = 'trainer' and private.push_pref(v_uid, 'digest') then
      v_hours := case when coalesce((select digest_times from public.push_prefs where user_id = v_uid), '3') = '5'
                      then array[9, 12, 15, 18, 21] else array[9, 15, 21] end;
      select max(h) into v_h from unnest(v_hours) h where h <= extract(hour from v_kst);
      if v_h is not null then
        v_slot := to_char(v_today, 'YYYY-MM-DD') || ' ' || lpad(v_h::text, 2, '0');
        if st.digest_slot is distinct from v_slot then
          update private.push_state set digest_slot = v_slot where user_id = v_uid;
          -- 회차 시각에서 3시간이 지났으면(서버 기능이 멈췄던 경우) 지난 회차는 보내지 않는다
          if v_kst < v_today + make_interval(hours => v_h + 3)
             and exists (select 1 from private.trainer_attention(v_uid) t where t.arrived > st.digest_basis_at) then
            perform private.push_add(v_uid, 'digest', v_slot, st.digest_basis_at, v_now,
              ((v_today + make_interval(hours => v_h + 3)) at time zone 'Asia/Seoul'));
            -- 30초 겹쳐 본다: 이 순간 저장 중이던 기록이 기준보다 앞 시각으로 들어와도 다음 회차에 '새 것'으로 잡히게
            update private.push_state set digest_basis_at = v_now - interval '30 seconds' where user_id = v_uid;
          end if;
        end if;
      end if;

    elsif v_role = 'member' then
      if private.push_pref(v_uid, 'feedback') then
        -- 아직 안 읽은 새 피드백 중 이 식사에서 아직 알리지 않은 것(알림을 켠 뒤의 것만). 묶지 않고 바로 보낸다(2026-10-27 사용자 결정)
        select array_agg(m.id order by m.id), array_agg(private.meal_feedback_at(m) order by m.id) into v_ids, v_ats
          from public.meals m left join private.push_feedback_sent fs on fs.meal_id = m.id
         where m.member_id = v_uid and private.meal_new_feedback(m)
           and private.meal_feedback_at(m) > st.feedback_basis_at
           and private.meal_feedback_at(m) > coalesce(fs.feedback_at, '-infinity'::timestamptz);
        if v_ids is not null then
          perform private.push_add(v_uid, 'feedback', clock_timestamp()::text, null, v_now, v_now + interval '12 hours', v_ids, v_ats);
          insert into private.push_feedback_sent (meal_id, feedback_at)
          select f.meal_id, f.fat from unnest(v_ids, v_ats) as f(meal_id, fat)
          on conflict (meal_id) do update set feedback_at = excluded.feedback_at;
        end if;
      end if;
      -- 오전 9시 아침 응원: 하루 한 번, 9～11시 사이에 만든다(서버 기능이 멈췄다 늦게 돌면 지난 아침 응원은 보내지 않음)
      if private.push_pref(v_uid, 'morning')
         and v_kst >= v_today + interval '9 hours' and v_kst < v_today + interval '11 hours'
         and st.morning_on is distinct from v_today then
        update private.push_state set morning_on = v_today where user_id = v_uid;
        perform private.push_add(v_uid, 'morning', to_char(v_today, 'YYYY-MM-DD'), null, v_now,
          ((v_today + interval '11 hours') at time zone 'Asia/Seoul'));
      end if;
      if private.push_pref(v_uid, 'lunch') then
        foreach v_meal in array array['점심', '저녁'] loop
          v_mh := case v_meal when '점심' then 13 else 20 end;
          if v_kst >= v_today + make_interval(hours => v_mh) and v_kst < v_today + make_interval(hours => v_mh + 2)
             and (case v_meal when '점심' then st.lunch_on else st.dinner_on end) is distinct from v_today then
            if v_meal = '점심' then update private.push_state set lunch_on = v_today where user_id = v_uid;
            else update private.push_state set dinner_on = v_today where user_id = v_uid; end if;
            if not exists (select 1 from public.meals m where m.member_id = v_uid and m.eaten_on = v_today and m.meal_type = v_meal) then
              perform private.push_add(v_uid, case v_meal when '점심' then 'lunch' else 'dinner' end,
                to_char(v_today, 'YYYY-MM-DD'), null, v_now,
                ((v_today + make_interval(hours => v_mh + 2)) at time zone 'Asia/Seoul'));
            end if;
          end if;
        end loop;
      end if;
    end if;
  end loop;
end;
$$;

-- ─── 보낼 때마다 다시 확인 ─────────────────────────────────────────────────
-- 아직 보낼 근거가 있으면 알림 내용(jsonb), 없으면 null. 원문·이름은 읽지 않는다.
create function private.push_payload(n private.push_notifications, p_now timestamptz)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_q int; v_r int; v_body text; v_day date;
begin
  if n.expires_at <= p_now or not private.push_allowed(n.user_id) or not private.push_pref(n.user_id, n.kind) then return null; end if;
  if n.kind = 'digest' then
    if not exists (select 1 from public.profiles p where p.id = n.user_id and p.role = 'trainer') then return null; end if;
    select count(*) filter (where kind = 'question'), count(*) filter (where kind = 'review') into v_q, v_r
      from private.trainer_attention(n.user_id);
    if v_q + v_r = 0 then return null; end if;
    v_body := concat_ws(', ',
      case when v_r > 0 then '확인할 식사 기록 ' || v_r || '건' end,
      case when v_q > 0 then '답할 질문 ' || v_q || '건' end) || '이 있어요';
    return jsonb_build_object('body', v_body, 'open', 'queue', 'tag', 'digest', 'ttl', 10800);
  elsif n.kind = 'feedback' then
    -- 이 알림이 알리는 그 피드백을 아직 안 읽었고, 같은 식사를 더 새 피드백 알림이 맡지 않았을 때만 보낸다.
    -- (재시도 대기 중 읽었다면 취소 · 같은 식사에 새 피드백이 생기면 새 알림 하나만 간다)
    if not exists (
      select 1 from unnest(n.meal_ids, n.feedback_ats) as f(meal_id, fat)
        join public.meals m on m.id = f.meal_id and m.member_id = n.user_id
       where m.member_seen_at < f.fat
         and not exists (select 1 from private.push_notifications n2
                          where n2.user_id = n.user_id and n2.kind = 'feedback' and n2.created_at > n.created_at
                            and f.meal_id = any (n2.meal_ids))) then
      return null;
    end if;
    -- 피드백마다 따로 쌓이게 알림마다 다른 tag
    return jsonb_build_object('body', '트레이너가 피드백을 남겼어요', 'open', 'feedback', 'tag', 'feedback-' || left(n.id::text, 8), 'ttl', 43200);
  elsif n.kind in ('lunch', 'dinner') then
    v_day := n.slot_key::date;
    if (p_now at time zone 'Asia/Seoul')::date <> v_day
       or exists (select 1 from public.meals m where m.member_id = n.user_id and m.eaten_on = v_day
                    and m.meal_type = case n.kind when 'lunch' then '점심' else '저녁' end) then
      return null;
    end if;
    return jsonb_build_object('body', case n.kind when 'lunch' then '점심 식단을 남겨 주세요' else '저녁 식단을 남겨 주세요' end,
      'open', 'today', 'tag', 'reminder', 'ttl', 7200);
  elsif n.kind = 'morning' then
    -- 앱의 '오늘의 한마디'와 같은 규칙: 담당 트레이너가 그날 한마디를 썼으면 그 글, 아니면 그날의 기본 문구.
    -- 기본 문구 목록은 서버 기능(_shared/quotes.ts)에 있으므로 날짜만 넘기고 서버 기능이 채운다.
    v_day := n.slot_key::date;
    if (p_now at time zone 'Asia/Seoul')::date <> v_day then return null; end if;
    select btrim(tm.body) into v_body
      from public.assignments a join public.trainer_messages tm on tm.trainer_id = a.trainer_id and tm.day = v_day
     where a.member_id = n.user_id;
    return jsonb_build_object('title', '오늘 하루도 화이팅!', 'open', 'today', 'tag', 'morning', 'ttl', 7200)
           || case when v_body is not null and v_body <> '' then jsonb_build_object('body', v_body)
                   else jsonb_build_object('quote_day', to_char(v_day, 'YYYY-MM-DD')) end;
  elsif n.kind = 'test' then
    return jsonb_build_object('body', '알림이 켜졌어요. 새 소식이 있으면 이렇게 알려 드려요.', 'open', '', 'tag', 'test', 'ttl', 600);
  end if;
  return null;
end;
$$;

-- ─── 서버 기능 전용: 선점과 결과 기록 ─────────────────────────────────────────
-- p_now: 시험에서 시각을 정해 부르려고 둔다(service_role만 실행 가능). 서버 기능은 넘기지 않는다.
create function public.push_claim(p_limit int default 50, p_now timestamptz default now())
returns table (nid uuid, sid uuid, endpoint_url text, key_p256dh text, key_auth text, payload jsonb)
language plpgsql security definer set search_path = ''
as $$
declare
  d private.push_deliveries%rowtype;
  n private.push_notifications%rowtype;
  s public.push_subscriptions%rowtype;
  v_payload jsonb;
begin
  perform private.push_generate(p_now);
  for d in
    select * from private.push_deliveries x
     where (x.status in ('pending', 'retry') and x.next_try_at <= p_now)
        or (x.status = 'sending' and x.locked_until < p_now) -- 처리 중 함수가 멈춘 작업
     order by x.next_try_at
     limit least(greatest(p_limit, 1), 200)
     for update skip locked
  loop
    select * into n from private.push_notifications where id = d.notification_id;
    select * into s from public.push_subscriptions where id = d.subscription_id;
    -- 알림·기기·세션의 계정이 모두 같고 그 세션이 살아 있어야 한다(세션이 하나 있다는 것만으로는 안 됨)
    if n.user_id is distinct from s.user_id
       or not exists (select 1 from auth.sessions x where x.id = s.session_id and x.user_id = s.user_id) then
      delete from public.push_subscriptions where id = s.id and not exists (
        select 1 from auth.sessions x where x.id = s.session_id and x.user_id = s.user_id);
      update private.push_deliveries set status = 'canceled', locked_until = null
       where notification_id = d.notification_id and subscription_id = d.subscription_id;
      continue;
    end if;
    v_payload := private.push_payload(n, p_now);
    if v_payload is null then
      update private.push_deliveries set status = 'canceled', locked_until = null
       where notification_id = d.notification_id and subscription_id = d.subscription_id;
      continue;
    end if;
    update private.push_deliveries set status = 'sending', attempts = attempts + 1, locked_until = p_now + interval '2 minutes'
     where notification_id = d.notification_id and subscription_id = d.subscription_id;
    nid := d.notification_id; sid := d.subscription_id;
    endpoint_url := s.endpoint; key_p256dh := s.p256dh; key_auth := s.auth;
    payload := jsonb_build_object('title', '식단노트') || v_payload || jsonb_build_object('nid', n.id, 'uid', n.user_id); -- 알림이 제목을 정하면 그 제목
    return next;
  end loop;
end;
$$;

-- p_results: [{notification_id, subscription_id, outcome: accepted|gone|retry|fail, code, retry_after}]
create function public.push_report(p_results jsonb)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r jsonb;
  v_nid uuid; v_sid uuid; v_attempts int; v_wait int;
begin
  for r in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    v_nid := (r ->> 'notification_id')::uuid; v_sid := (r ->> 'subscription_id')::uuid;
    select attempts into v_attempts from private.push_deliveries
     where notification_id = v_nid and subscription_id = v_sid and status = 'sending' for update;
    continue when not found;
    case r ->> 'outcome'
      when 'accepted' then
        update private.push_deliveries set status = 'sent', locked_until = null, last_error_code = null
         where notification_id = v_nid and subscription_id = v_sid;
        update public.push_subscriptions set last_accepted_at = now() where id = v_sid;
      when 'gone' then
        delete from public.push_subscriptions where id = v_sid; -- 404·410: 알림 서버가 이 기기를 더는 모른다
      when 'retry' then
        v_wait := greatest(coalesce((r ->> 'retry_after')::int, 0), 60 * power(4, v_attempts - 1)::int);
        update private.push_deliveries
           set status = case when v_attempts >= 3 then 'failed' else 'retry' end,
               next_try_at = now() + make_interval(secs => least(v_wait, 3600)), locked_until = null,
               last_error_code = nullif(r ->> 'code', '')::int
         where notification_id = v_nid and subscription_id = v_sid;
      else
        update private.push_deliveries set status = 'failed', locked_until = null, last_error_code = nullif(r ->> 'code', '')::int
         where notification_id = v_nid and subscription_id = v_sid;
    end case;
  end loop;
end;
$$;

revoke execute on function
  private.push_kick_soon(), private.push_kick_pending(),
  private.meal_last_member_at(public.meals), private.meal_last_trainer_comment_at(public.meals), private.meal_pending_question(public.meals),
  private.meal_feedback_at(public.meals), private.meal_new_feedback(public.meals), private.trainer_attention(uuid),
  private.push_allowed(uuid), private.push_pref(uuid, text), private.push_endpoint_ok(text),
  private.push_add(uuid, text, text, timestamptz, timestamptz, timestamptz, uuid[], timestamptz[]), private.push_generate(timestamptz), private.push_payload(private.push_notifications, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.register_push(text, text, text), public.unregister_push(text), public.push_registered(text), public.push_test(), public.push_nudge()
  from public, anon;
grant execute on function public.register_push(text, text, text), public.unregister_push(text), public.push_registered(text), public.push_test(), public.push_nudge()
  to authenticated;
revoke execute on function public.push_claim(int, timestamptz), public.push_report(jsonb) from public, anon, authenticated;
grant execute on function public.push_claim(int, timestamptz), public.push_report(jsonb) to service_role;

-- 10분마다 서버 기능을 부른다(Vault에 주소·비밀이 있을 때만 실제로 호출)
select cron.schedule('mealnote-push', '*/10 * * * *', 'select private.push_kick()');
-- 바로 보내기 대기분 처리(10초마다, 대기 표시가 있을 때만 서버 기능을 부른다)
select cron.schedule('mealnote-push-pending', '10 seconds', 'select private.push_kick_pending()');
