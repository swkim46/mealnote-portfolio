import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { InstallHint } from '../components/AccountPanel';
import { isValidPin, listTrainers, nicknameProblem, signIn, signUp, type Trainer } from '../lib/auth';
import { getRemembered, onRememberedChange, setRemembered } from '../lib/remember';
import { supabase } from '../lib/supabase';
import { VersionLine } from '../components/ReleaseNotes';
import { TextSizeToggle } from '../components/TextSizeControls';
import { ThemeToggle } from '../components/ThemeControls';
import { ForgotPin, RecoveryFields } from '../components/PinForms';
import { answerProblem } from '../lib/recovery';
import { markFreshLogin } from '../lib/pin';
import { setUnsaved } from '../lib/appUpdate';
import type { Role } from '../lib/types';

type Mode = 'login' | 'signup';

export function AuthScreen() {
  // 이 기기에서 기억한 계정이 있으면 역할 선택을 건너뛰고 바로 로그인 화면으로
  const [remembered, setRememberedNow] = useState(getRemembered);
  const [role, setRole] = useState<Role | null>(remembered?.role ?? null);
  // 로그아웃 직후 다른 기기에서 바꾼 닉네임 확인(syncRemembered)이 늦게 끝나도 자동 입력에 반영한다
  useEffect(() => onRememberedChange(() => setRememberedNow(getRemembered())), []);
  // 로그인·가입 칸에 무언가 입력했으면, 이 화면이 사라질 때(로그인 성공)까지 새 버전 적용이 화면을 새로 고치지 않게 한다
  useEffect(() => () => setUnsaved('auth', false), []);
  return (
    <div className="workspace">
      <section className="prototype" aria-label="식단노트 시작">
        <div className="auth" onInput={() => setUnsaved('auth', true)}>
          <div className="auth-brand">
            <span className="brand-icon" aria-hidden="true">
              ▤
            </span>
            식단노트
            <div className="header-controls">
              <ThemeToggle />
              <TextSizeToggle />
            </div>
          </div>
          {role ? (
            <AuthForm role={role} initialNickname={remembered?.role === role ? remembered.nickname : ''} onBack={() => setRole(null)} />
          ) : (
            <RolePicker onPick={setRole} />
          )}
          <VersionLine />
        </div>
      </section>
    </div>
  );
}

function RolePicker({ onPick }: { onPick: (r: Role) => void }) {
  return (
    <>
      <h1>
        트레이너와 함께 쓰는
        <br />
        식단 노트
      </h1>
      <p className="lead">어떤 분으로 시작하시나요?</p>
      <div className="role-cards">
        <button className="role-card" onClick={() => onPick('member')}>
          <span className="avatar">회</span>
          <span>
            <strong>회원으로 시작</strong>
            <p>식사를 기록하고 트레이너의 피드백을 받아요.</p>
          </span>
          <Icon name="right" />
        </button>
        <button className="role-card" onClick={() => onPick('trainer')}>
          <span className="avatar">트</span>
          <span>
            <strong>트레이너로 시작</strong>
            <p>담당 회원의 식단을 확인하고 피드백해요.</p>
          </span>
          <Icon name="right" />
        </button>
      </div>
      <InstallHint />
    </>
  );
}

function AuthForm({ role, initialNickname, onBack }: { role: Role; initialNickname: string; onBack: () => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [nickname, setNickname] = useState(initialNickname);
  // 자동 입력이 늦게 바뀌면 따라 바꾼다. 사람이 이미 고쳐 쓴 이름이나 가입 화면의 입력은 그대로 둔다
  const prefilled = useRef(initialNickname);
  useEffect(() => {
    if (!initialNickname || initialNickname === prefilled.current) return;
    if (mode === 'login' && nickname === prefilled.current) setNickname(initialNickname);
    prefilled.current = initialNickname;
  }, [initialNickname]); // eslint-disable-line react-hooks/exhaustive-deps
  const [remember, setRemember] = useState(true);
  const [forgot, setForgot] = useState(false);
  const [recQuestion, setRecQuestion] = useState(1);
  const [recAnswer, setRecAnswer] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [code, setCode] = useState('');
  const [trainerId, setTrainerId] = useState('');
  const [trainers, setTrainers] = useState<Trainer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isTrainer = role === 'trainer';

  const loadTrainers = () => {
    setTrainers(null);
    listTrainers()
      .then(setTrainers)
      .catch(() => {
        setTrainers([]);
        setError('트레이너 목록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
      });
  };

  useEffect(() => {
    if (mode === 'signup' && !isTrainer) loadTrainers();
  }, [mode, isTrainer]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const nickErr = nicknameProblem(nickname);
    if (nickErr) return setError(nickErr);
    if (!isValidPin(pin)) return setError('PIN은 숫자 6자리로 입력해 주세요.');
    if (mode === 'signup') {
      if (pin !== pin2) return setError('PIN 확인이 일치하지 않아요.');
      if (isTrainer && !code.trim()) return setError('트레이너 등록 코드를 입력해 주세요.');
      if (!isTrainer && !trainerId) return setError('담당 트레이너를 선택해 주세요.');
      const ap = answerProblem(recAnswer);
      if (ap) return setError(`복구 질문: ${ap}`);
    }
    setError('');
    setBusy(true);
    markFreshLogin();
    const message =
      mode === 'login'
        ? await signIn(nickname, pin)
        : isTrainer
          ? await signUp({ role, nickname, pin, trainerCode: code, recoveryQuestion: recQuestion, recoveryAnswer: recAnswer })
          : await signUp({ role, nickname, pin, trainerId, recoveryQuestion: recQuestion, recoveryAnswer: recAnswer });
    setBusy(false);
    if (!message) {
      const userId = remember ? (await supabase.auth.getSession()).data.session?.user.id : undefined;
      setRemembered(remember ? { nickname: nickname.normalize('NFC').trim(), role, userId } : null);
    }
    if (message) {
      setError(message);
      if (mode === 'signup' && !isTrainer && message.includes('트레이너')) loadTrainers();
    }
  }

  const pinInput = (value: string, set: (v: string) => void, label: string, auto: string) => (
    <label className="field">
      {label}
      <input
        type="password"
        inputMode="numeric"
        pattern="\d{6}"
        maxLength={6}
        autoComplete={auto}
        value={value}
        placeholder="숫자 6자리"
        required
        onChange={(e) => set(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
    </label>
  );

  if (forgot) return <ForgotPin role={role} initialNickname={nickname} onBack={() => setForgot(false)} />;

  return (
    <>
      <button className="back-button" onClick={onBack}>
        <Icon name="left" /> 처음으로
      </button>
      <h1 className="auth-title">{isTrainer ? '트레이너' : '회원'}</h1>
      <div className="role-switch auth-tabs" role="group" aria-label="로그인 또는 가입">
        <button aria-pressed={mode === 'login'} onClick={() => { setMode('login'); setError(''); }}>
          로그인
        </button>
        <button aria-pressed={mode === 'signup'} onClick={() => { setMode('signup'); setError(''); }}>
          처음이에요
        </button>
      </div>
      <form onSubmit={submit} className="auth-form">
        <label className="field">
          닉네임
          <input
            value={nickname}
            maxLength={20}
            name="username"
            autoComplete="username"
            autoCapitalize="off"
            placeholder="2~20자"
            required
            onChange={(e) => setNickname(e.target.value)}
            aria-describedby={mode === 'signup' ? 'nickname-hint' : undefined}
          />
        </label>
        {mode === 'signup' && (
          <p id="nickname-hint" className="field-hint">
            {isTrainer
              ? '회원이 가입할 때 이 닉네임을 보고 담당 트레이너를 골라요. 회원이 알아볼 수 있게 지어 주세요. 예: 김코치'
              : '트레이너가 이 닉네임으로 회원님을 알아봐요. 트레이너가 알아볼 수 있게 지어 주세요.'}
          </p>
        )}
        {pinInput(pin, setPin, 'PIN', mode === 'login' ? 'current-password' : 'new-password')}
        {mode === 'signup' && pinInput(pin2, setPin2, 'PIN 확인', 'new-password')}

        {mode === 'signup' && isTrainer && (
          <label className="field">
            트레이너 등록 코드
            <input
              value={code}
              autoCapitalize="characters"
              autoComplete="off"
              placeholder="운영자에게 받은 코드"
              required
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
        )}

        {mode === 'signup' && !isTrainer && (
          <div className="field">
            담당 트레이너
            {trainers === null ? (
              <p className="hint">트레이너 목록을 불러오는 중…</p>
            ) : trainers.length === 0 ? (
              <p className="hint">아직 등록된 트레이너가 없어요. 트레이너가 먼저 가입해야 해요.</p>
            ) : (
              <div className="filters choice-list" role="radiogroup" aria-label="담당 트레이너 선택">
                {trainers.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    role="radio"
                    aria-checked={trainerId === t.id}
                    className={`filter ${trainerId === t.id ? 'active' : ''}`}
                    onClick={() => setTrainerId(t.id)}
                  >
                    {t.nickname}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {mode === 'signup' && <RecoveryFields question={recQuestion} setQuestion={setRecQuestion} answer={recAnswer} setAnswer={setRecAnswer} />}
        <label className="remember-row">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          닉네임 기억하기
        </label>
        <div className="field-error" role="alert">
          {error}
        </div>
        <button className="primary full" type="submit" disabled={busy}>
          {busy ? '확인하는 중…' : mode === 'login' ? '로그인' : '가입하고 시작하기'}
        </button>
        {mode === 'login' && (
          <button type="button" className="forgot-link" onClick={() => setForgot(true)}>
            PIN을 잊으셨나요?
          </button>
        )}
        <p className="form-footnote">
          {mode === 'login'
            ? '가입할 때 정한 닉네임과 PIN을 입력해 주세요. 로그인하면 로그아웃 전까지 유지돼요.'
            : '이름·연락처 같은 개인정보는 받지 않아요. 닉네임과 PIN을 꼭 기억해 주세요.'}
        </p>
      </form>
    </>
  );
}
