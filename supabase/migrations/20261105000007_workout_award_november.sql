-- 운동왕도 11월 기록부터 센다(사용자 결정 2026-11-05 — 전에는 12월부터). 식단왕과 시작 달이 같아진다.
update public.app_settings set value = '2026-11-01' where key = 'workout_award_from';
