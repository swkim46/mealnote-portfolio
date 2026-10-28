-- v1.4 단계 3: 인바디 기록. 결과지 사진은 기기 안에서 숫자만 읽고 버린다 → 사진·원문을 담는 칸이 없다.
-- 회원 본인이 쓰고 고치고 지운다. 담당 트레이너는 읽기만 한다.
create table public.inbody_records (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.profiles(id) on delete cascade,
  measured_on date not null check (measured_on >= date '2000-01-01'),
  weight_kg   numeric(5,1) not null check (weight_kg between 20 and 300),
  smm_kg      numeric(5,1) check (smm_kg between 5 and 150),
  pbf_pct     numeric(4,1) check (pbf_pct between 1 and 75),
  source      text not null default 'manual' check (source in ('ocr', 'manual')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (member_id, measured_on)
);
create index inbody_records_member_day on public.inbody_records (member_id, measured_on desc);
alter table public.inbody_records enable row level security;

-- 앞날짜는 막는다(기기 날짜와 서버 날짜 차이로 하루 여유)
create function private.inbody_guard()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.measured_on > current_date + 1 then raise exception 'future_date'; end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger inbody_guard before insert or update on public.inbody_records for each row execute function private.inbody_guard();

create policy inbody_select on public.inbody_records for select to authenticated
using (member_id = (select auth.uid()) or (select private.is_my_member(member_id)));
create policy inbody_insert on public.inbody_records for insert to authenticated
with check (
  member_id = (select auth.uid())
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'member')
);
create policy inbody_update on public.inbody_records for update to authenticated
using (member_id = (select auth.uid())) with check (member_id = (select auth.uid()));
create policy inbody_delete on public.inbody_records for delete to authenticated
using (member_id = (select auth.uid()));
create policy session_alive on public.inbody_records as restrictive for all to authenticated
using ((select private.session_ok())) with check ((select private.session_ok()));

revoke all on public.inbody_records from anon, authenticated;
grant select, delete on public.inbody_records to authenticated;
grant insert (member_id, measured_on, weight_kg, smm_kg, pbf_pct, source) on public.inbody_records to authenticated;
grant update (measured_on, weight_kg, smm_kg, pbf_pct, source) on public.inbody_records to authenticated;
