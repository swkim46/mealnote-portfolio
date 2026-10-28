import { useEffect, useState, type FormEvent } from 'react';
import { isValidPin, nicknameProblem, signIn } from '../lib/auth';
import { answerProblem, RECOVERY_QUESTIONS, RECOVERY_WARNING } from '../lib/recovery';
import {
  changeMyNickname,
  changeMyPin,
  getRecoveryQuestion,
  markFreshLogin,
  mySecurityStatus,
  reclaimAccount,
  resetPinWithAnswer,
  resultText,
  setAck,
  setRecovery,
} from '../lib/pin';
import type { Profile, Role } from '../lib/types';
import { getRemembered, rememberedIsMine, setRemembered } from '../lib/remember';

const pinField = (label: string, value: string, set: (v: string) => void, auto: string) => (
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

/** 복구 질문 고르기 + 답 (가입·정하기·되찾기에서 같이 쓴다) */
export function RecoveryFields({
  question,
  setQuestion,
  answer,
  setAnswer,
}: {
  question: number;
  setQuestion: (q: number) => void;
  answer: string;
  setAnswer: (a: string) => void;
}) {
  return (
    <>
      <label className="field">
        PIN을 잊었을 때 쓸 질문
        <select value={question} onChange={(e) => setQuestion(Number(e.target.value))}>
          {Object.entries(RECOVERY_QUESTIONS).map(([id, text]) => (
            <option key={id} value={id}>
              {text}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        답
        <input value={answer} maxLength={50} autoComplete="off" required placeholder="띄어쓰기·대소문자는 상관없어요" onChange={(e) => setAnswer(e.target.value)} />
      </label>
      <p className="field-hint recovery-warning">{RECOVERY_WARNING}</p>
    </>
  );
}

/** 로그인 화면: PIN을 잊었을 때 — 복구 질문에 답하면 바로 새 PIN */
export function ForgotPin({ initialNickname, onBack }: { role: Role; initialNickname: string; onBack: () => void }) {
  const [nickname, setNickname] = useState(initialNickname);
  const [question, setQuestion] = useState<number | null | undefined>(undefined); // undefined: 아직 안 물어봄, null: 질문 없음
  const [answer, setAnswer] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function findQuestion(e: FormEvent) {
    e.preventDefault();
    const problem = nicknameProblem(nickname);
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      setQuestion(await getRecoveryQuestion(nickname));
    } catch {
      setError('연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  async function reset(e: FormEvent) {
    e.preventDefault();
    const ap = answerProblem(answer);
    if (ap) return setError(ap);
    if (!isValidPin(pin)) return setError('새 PIN은 숫자 6자리로 입력해 주세요.');
    if (pin !== pin2) return setError('새 PIN 확인이 일치하지 않아요.');
    setBusy(true);
    setError('');
    try {
      const r = await resetPinWithAnswer(nickname, answer, pin);
      if (r.status !== 'ok') {
        setError(resultText(r));
        return;
      }
      markFreshLogin();
      const msg = await signIn(nickname, pin);
      if (msg) setError(`PIN은 바꿨어요. 로그인 화면에서 새 PIN으로 로그인해 주세요. (${msg})`);
    } catch {
      setError('처리하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="forgot">
      <h2 className="forgot-title">PIN을 잊으셨나요?</h2>
      {question === undefined ? (
        <form onSubmit={findQuestion}>
          <p className="forgot-text">가입할 때 정한 질문에 답하면 새 PIN을 바로 정할 수 있어요.</p>
          <label className="field">
            닉네임
            <input value={nickname} maxLength={20} autoComplete="username" autoCapitalize="off" required onChange={(e) => setNickname(e.target.value)} />
          </label>
          <div className="field-error" role="alert">
            {error}
          </div>
          <button className="primary full" type="submit" disabled={busy}>
            {busy ? '확인하는 중…' : '다음'}
          </button>
        </form>
      ) : question === null ? (
        <>
          <p className="forgot-text">이 닉네임은 PIN을 되찾을 수 있는 질문이 없어요.</p>
          <p className="forgot-text small">
            로그인해 둔 휴대폰이 있다면 그 휴대폰의 내 정보에서 PIN을 바꿀 수 있어요. 없다면 새 닉네임으로 다시 가입해 주세요.
          </p>
        </>
      ) : (
        <form onSubmit={reset}>
          <p className="forgot-question">{RECOVERY_QUESTIONS[question]}</p>
          <label className="field">
            답
            <input value={answer} maxLength={50} autoComplete="off" required onChange={(e) => setAnswer(e.target.value)} />
          </label>
          {pinField('새 PIN', pin, setPin, 'new-password')}
          {pinField('새 PIN 확인', pin2, setPin2, 'new-password')}
          <div className="field-error" role="alert">
            {error}
          </div>
          <button className="primary full" type="submit" disabled={busy}>
            {busy ? '확인하는 중…' : '새 PIN으로 바꾸기'}
          </button>
        </form>
      )}
      <button type="button" className="text-button forgot-back" onClick={onBack}>
        로그인으로 돌아가기
      </button>
    </div>
  );
}

/** 내 정보: PIN 바꾸기 — 지금 PIN 또는 복구 답 */
export function PinChangeForm({ uid, onDone }: { uid: string; onDone: () => void }) {
  const [useAnswer, setUseAnswer] = useState(false);
  const [question, setQuestion] = useState<number | null>(null);
  const [current, setCurrent] = useState('');
  const [answer, setAnswer] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);

  useEffect(() => {
    mySecurityStatus()
      .then((s) => setQuestion(s.has_recovery ? s.question : null))
      .catch(() => {});
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!isValidPin(next)) return setError('새 PIN은 숫자 6자리로 입력해 주세요.');
    if (next !== next2) return setError('새 PIN 확인이 일치하지 않아요.');
    setBusy(true);
    setError('');
    try {
      const r = await changeMyPin(next, useAnswer ? { answer } : { currentPin: current });
      if (r.status !== 'ok') return setError(r.status === 'wrong' && !useAnswer ? '지금 PIN이 맞지 않아요.' : resultText(r));
      setAck(uid, { pin: r.pin_changed_at });
      setOk(true);
    } catch {
      setError('PIN을 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  if (ok)
    return (
      <div className="forgot">
        <h3 className="forgot-title">PIN을 바꿨어요</h3>
        <p className="forgot-text">다음 로그인부터 새 PIN을 입력해 주세요.</p>
        <button className="primary full" onClick={onDone}>
          닫기
        </button>
      </div>
    );

  return (
    <form onSubmit={submit}>
      {useAnswer && question ? (
        <>
          <p className="forgot-question">{RECOVERY_QUESTIONS[question]}</p>
          <label className="field">
            답
            <input value={answer} maxLength={50} autoComplete="off" required onChange={(e) => setAnswer(e.target.value)} />
          </label>
        </>
      ) : (
        pinField('지금 PIN', current, setCurrent, 'current-password')
      )}
      {question && (
        <button type="button" className="text-button switch-proof" onClick={() => setUseAnswer((v) => !v)}>
          {useAnswer ? '지금 PIN으로 바꾸기' : '지금 PIN이 기억나지 않아요'}
        </button>
      )}
      {pinField('새 PIN', next, setNext, 'new-password')}
      {pinField('새 PIN 확인', next2, setNext2, 'new-password')}
      <div className="field-error" role="alert">
        {error}
      </div>
      <button className="primary full" type="submit" disabled={busy}>
        {busy ? '바꾸는 중…' : 'PIN 바꾸기'}
      </button>
    </form>
  );
}

/** 내 정보: 복구 질문 정하기·바꾸기 (지금 PIN 확인) */
export function RecoverySetupForm({ onDone }: { onDone: () => void }) {
  const [question, setQuestion] = useState(1);
  const [answer, setAnswer] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ap = answerProblem(answer);
    if (ap) return setError(ap);
    setBusy(true);
    setError('');
    try {
      const r = await setRecovery(question, answer, pin);
      if (r.status !== 'ok') return setError(r.status === 'wrong' ? '지금 PIN이 맞지 않아요.' : resultText(r));
      setOk(true);
    } catch {
      setError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  if (ok)
    return (
      <div className="forgot">
        <h3 className="forgot-title">복구 질문을 정했어요</h3>
        <p className="forgot-text">PIN을 잊으면 로그인 화면의 'PIN을 잊으셨나요?'에서 이 질문에 답해 주세요.</p>
        <button className="primary full" onClick={onDone}>
          닫기
        </button>
      </div>
    );

  return (
    <form onSubmit={submit}>
      <p className="forgot-text">PIN을 잊었을 때 혼자 되찾는 데 쓰는 질문이에요. 한 번만 정하면 되고, 답은 운영자도 볼 수 없게 저장돼요.</p>
      <RecoveryFields question={question} setQuestion={setQuestion} answer={answer} setAnswer={setAnswer} />
      {pinField('지금 PIN', pin, setPin, 'current-password')}
      <div className="field-error" role="alert">
        {error}
      </div>
      <button className="primary full" type="submit" disabled={busy}>
        {busy ? '저장하는 중…' : '저장하기'}
      </button>
    </form>
  );
}

/** '제가 바꾼 게 아니에요' 뒤: 새 PIN과 새 복구 질문으로 되찾기 (PIN이 바뀌기 전부터 로그인돼 있던 기기만) */
export function ReclaimForm({ uid, onDone }: { uid: string; onDone: () => void }) {
  const [question, setQuestion] = useState(1);
  const [answer, setAnswer] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ap = answerProblem(answer);
    if (ap) return setError(ap);
    if (!isValidPin(pin)) return setError('새 PIN은 숫자 6자리로 입력해 주세요.');
    if (pin !== pin2) return setError('새 PIN 확인이 일치하지 않아요.');
    setBusy(true);
    setError('');
    try {
      const r = await reclaimAccount(pin, question, answer);
      if (r.status !== 'ok') return setError(resultText(r));
      setAck(uid, { pin: r.pin_changed_at });
      onDone();
    } catch {
      setError('이 기기에서는 되찾을 수 없어요. PIN이 바뀐 뒤에 로그인한 기기예요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="forgot-text">
        새 PIN과 새 복구 질문을 정하면 계정을 되찾아요. 다른 기기는 모두 로그아웃되고, 운영자에게도 기록이 남아요.
      </p>
      {pinField('새 PIN', pin, setPin, 'new-password')}
      {pinField('새 PIN 확인', pin2, setPin2, 'new-password')}
      <RecoveryFields question={question} setQuestion={setQuestion} answer={answer} setAnswer={setAnswer} />
      <div className="field-error" role="alert">
        {error}
      </div>
      <button className="primary full" type="submit" disabled={busy}>
        {busy ? '처리하는 중…' : '계정 되찾기'}
      </button>
    </form>
  );
}

/** 앱 맨 위(App)가 프로필을 다시 불러오게 알린다(닉네임을 바꾼 뒤). 열려 있는 화면은 그대로 둔다. */
export const PROFILE_CHANGED = 'mealnote:profile-changed';

/** 내 정보: 닉네임 바꾸기. 닉네임은 로그인 아이디라 지금 PIN을 확인한다. 이 기기에 기억한 로그인 닉네임도 새 이름으로 바꾼다. */
export function NicknameChangeForm({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const [nickname, setNickname] = useState('');
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = nicknameProblem(nickname);
    if (problem) return setError(problem);
    if (!isValidPin(current)) return setError('지금 PIN을 숫자 6자리로 입력해 주세요.');
    setBusy(true);
    setError('');
    try {
      const r = await changeMyNickname(nickname, current);
      if (r.status !== 'ok') {
        const why: Record<string, string> = {
          wrong: '지금 PIN이 맞지 않아요.',
          taken: '이미 다른 분이 쓰는 닉네임이에요. 다른 이름으로 정해 주세요.',
          invalid: '닉네임은 2~20자로 입력해 주세요.',
          same: '지금 닉네임과 같아요.',
        };
        return setError(why[r.status] ?? '닉네임을 바꾸지 못했어요.');
      }
      const next = (r as unknown as { nickname: string }).nickname;
      const remembered = getRemembered();
      if (remembered && rememberedIsMine(remembered, profile)) setRemembered({ ...remembered, nickname: next, userId: profile.id });
      window.dispatchEvent(new Event(PROFILE_CHANGED));
      setDone(next);
    } catch {
      setError('닉네임을 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div className="forgot">
        <h3 className="forgot-title">닉네임을 바꿨어요</h3>
        <p className="forgot-text">
          다음 로그인부터 새 닉네임 <b>{done}</b>(으)로 로그인해 주세요. PIN은 그대로예요.
        </p>
        <button className="primary full" onClick={onDone}>
          닫기
        </button>
      </div>
    );

  return (
    <form onSubmit={submit}>
      <p className="forgot-text small">
        지금 닉네임은 <b>{profile.nickname}</b>이에요. 닉네임은 로그인할 때도 쓰여서, 바꾸면 다음 로그인부터 새 닉네임을 입력해야 해요.
      </p>
      <label className="field">
        새 닉네임
        <input value={nickname} maxLength={20} autoComplete="off" required onChange={(e) => setNickname(e.target.value)} />
      </label>
      {pinField('지금 PIN', current, setCurrent, 'current-password')}
      {error && <p className="field-error">{error}</p>}
      <button type="submit" className="primary full" disabled={busy}>
        {busy ? '바꾸는 중…' : '닉네임 바꾸기'}
      </button>
    </form>
  );
}
