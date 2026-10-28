-- Codex 리뷰 P2 두 건:
-- (3) 60일 넘은 식사에 회원이 새로 말을 남기면 트레이너 조회에서 빠졌다 → 회원이 마지막으로 말한 시각(member_msg_at)을 두고 조회 조건에 넣는다.
-- (5) 확인 뒤 '한마디'를 고쳐 쓴 질문이 대기로 안 올라왔다 → 한마디를 고친 시각(note_updated_at)을 대화 시각으로 쓴다.
alter table public.meals add column note_updated_at timestamptz not null default now();
alter table public.meals add column member_msg_at timestamptz;
update public.meals set note_updated_at = created_at;
update public.meals m set member_msg_at = (
  select max(t) from (
    select case when btrim(m.note) <> '' then m.created_at end as t
    union all
    select c.created_at from public.comments c where c.meal_id = m.id and c.author_role = 'member'
  ) x);
create index meals_member_msg_idx on public.meals (member_msg_at);

create function private.meals_touch_note()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.note is distinct from old.note then
    new.note_updated_at := now();
    if btrim(new.note) <> '' then new.member_msg_at := now(); end if;
  end if;
  return new;
end;
$$;
create trigger meals_touch_note before insert or update on public.meals
  for each row execute function private.meals_touch_note();

create function private.comments_touch_meal()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.author_role = 'member' then
    update public.meals set member_msg_at = new.created_at where id = new.meal_id;
  end if;
  return new;
end;
$$;
create trigger comments_touch_meal after insert on public.comments
  for each row execute function private.comments_touch_meal();
revoke execute on function private.meals_touch_note(), private.comments_touch_meal() from public, anon, authenticated;
