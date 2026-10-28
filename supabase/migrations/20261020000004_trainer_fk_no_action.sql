-- RESTRICT는 즉시 검사해서, 트레이너와 담당 회원을 한 문장으로 함께 지워도 실패했다.
-- NO ACTION(문장 끝 검사)으로 바꿨으나 연쇄 삭제 순서 때문에 여전히 실패해서 0005에서 DEFERRED로 다시 바꾼다.
alter table public.assignments drop constraint assignments_trainer_id_fkey;
alter table public.assignments
  add constraint assignments_trainer_id_fkey
  foreign key (trainer_id) references public.profiles(id) on delete no action;
