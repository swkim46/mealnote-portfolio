-- 0004를 처음 적용했을 때는 NO ACTION(즉시 아님, 문장 끝)이었다. 원격 DB를 DEFERRED로 맞춘다.
alter table public.assignments drop constraint assignments_trainer_id_fkey;
alter table public.assignments
  add constraint assignments_trainer_id_fkey
  foreign key (trainer_id) references public.profiles(id)
  on delete no action deferrable initially deferred;
