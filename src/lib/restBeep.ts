// 쉬는 시간 끝 소리(2.3 — 2026-11-03 사용자 요청: 알림 소리를 세 번만 울리고 자동으로 끈다).
// 소리 파일 없이 기기에서 만든다. 아이폰은 사용자가 화면을 누른 때에만 소리 장치를 켤 수 있어, 세트 완료를 누를 때 미리 깨워 둔다(primeRestBeep).
// 앱 화면이 켜져 있을 때만 울린다(웹앱 한계). 아이폰 무음 모드에서는 소리가 나지 않을 수 있다 — 무음을 뚫는 재생 방식은 듣던 음악을 멈춰 쓰지 않는다(2026-11-06 사용자 결정).
// 2.4.1(2026-11-10 사용자 의견 '소리가 너무 작다', 후보 다섯 개 중 2번 '빠른 삐삐삐'를 사용자가 고름 — design/rest-sound-20261110/):
// 금방 잦아드는 880Hz 사인파(최고 0.35) 대신, 손목시계 알람처럼 짧은 '삐' 네 번을 한 묶음으로 세 묶음 울린다.
// 귀가 잘 듣는 3.2kHz 사각파를 거의 최대 크기로 낸다. 날카로운 윗소리는 걸러 낸다
let ctx: AudioContext | null = null;

const BEEPS = 3;
const GAP_SEC = 0.62;
const PULSES = 4;
const PULSE_GAP_SEC = 0.1;
const BEEP_SEC = 0.06;
const FREQ = 3200;
const PEAK = 0.75;
const EDGE_SEC = 0.005;

/** 세트 완료를 누를 때(사용자 동작 안에서) 부른다 */
export function primeRestBeep() {
  try {
    const Ctor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    if (ctx.state !== 'running') void ctx.resume(); // 아이폰은 통화 뒤 'interrupted'로 남는다
  } catch {
    /* 소리를 못 내는 기기 — 화면 표시와 진동만 */
  }
}

/** 소리 세 묶음을 start초부터 예약한다(크기 측정 시험이 OfflineAudioContext로도 부른다) */
export function scheduleRestBeeps(ac: BaseAudioContext, start: number) {
  const soften = ac.createBiquadFilter();
  soften.type = 'lowpass';
  soften.frequency.value = 8000;
  soften.connect(ac.destination);
  for (let i = 0; i < BEEPS * PULSES; i++) {
    const at = start + Math.floor(i / PULSES) * GAP_SEC + (i % PULSES) * PULSE_GAP_SEC;
    const tone = ac.createOscillator();
    const gain = ac.createGain();
    tone.type = 'square';
    tone.frequency.value = FREQ;
    // 켜고 끌 때만 짧게 올리고 내린다(딸깍 소리 막기) — 그 사이는 같은 크기
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(PEAK, at + EDGE_SEC);
    gain.gain.setValueAtTime(PEAK, at + BEEP_SEC - EDGE_SEC);
    gain.gain.linearRampToValueAtTime(0, at + BEEP_SEC);
    tone.connect(gain);
    gain.connect(soften);
    tone.start(at);
    tone.stop(at + BEEP_SEC + 0.01);
  }
}

/** 세 묶음 울리고 끝난다(이어서 울리지 않음) */
export function playRestBeep() {
  if (!ctx) return;
  try {
    if (ctx.state !== 'running') void ctx.resume();
    scheduleRestBeeps(ctx, ctx.currentTime + 0.02);
  } catch {
    /* 소리를 못 내는 기기 */
  }
}
