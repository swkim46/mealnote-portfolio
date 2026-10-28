import { useState, type FormEvent } from 'react';
import { Icon } from './Icon';
import { CATEGORY_LABEL, deviceSummary, sendFeedback, type FeedbackCategory } from '../lib/feedback';

const PLACEHOLDER: Record<FeedbackCategory, string> = {
  bug: '어떤 화면에서 무엇을 했을 때 어떻게 됐는지 적어 주시면 빨리 고칠 수 있어요.',
  idea: '있으면 좋을 기능이나 바뀌었으면 하는 점을 자유롭게 적어 주세요.',
  other: '무엇이든 편하게 남겨 주세요.',
};

/** 개발자에게 보내는 익명 의견. screen은 의견을 연 화면 이름. */
export function FeedbackForm({ screen, onDone }: { screen: string; onDone: () => void }) {
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text) return setError('내용을 한 줄이라도 적어 주세요.');
    setBusy(true);
    setError('');
    try {
      await sendFeedback(category, text, screen);
      setSent(true);
    } catch (err) {
      console.error(err);
      setError('보내지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  if (sent)
    return (
      <div className="feedback-thanks">
        <span className="thanks-icon" aria-hidden="true">
          ♡
        </span>
        <h3>보내 주셔서 고맙습니다</h3>
        <p>
          작은 의견 하나도 식단노트를 고치는 데 정말 큰 힘이 돼요.
          <br />
          남겨 주신 내용은 개발자가 직접 읽고 반영을 검토할게요.
        </p>
        <button className="primary full" onClick={onDone}>
          닫기
        </button>
      </div>
    );

  return (
    <form onSubmit={submit} className="app-feedback-form">
      <p className="feedback-lead">
        불편한 점, 오류, 바라는 기능을 알려 주세요.
        <br />
        <strong>작은 의견 하나도 서비스를 만드는 데 큰 힘이 됩니다.</strong> 시간 내어 주셔서 감사합니다.
      </p>
      <div className="field">
        어떤 내용인가요?
        <div className="filters choice-list" role="radiogroup" aria-label="의견 종류">
          {(Object.keys(CATEGORY_LABEL) as FeedbackCategory[]).map((c) => (
            <button
              type="button"
              key={c}
              role="radio"
              aria-checked={category === c}
              className={`filter ${category === c ? 'active' : ''}`}
              onClick={() => setCategory(c)}
            >
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        내용
        <textarea value={body} maxLength={2000} rows={5} placeholder={PLACEHOLDER[category]} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="anon-note">
        <Icon name="user" />
        <div>
          <strong>익명으로 전달돼요.</strong>
          <p>
            누가 보냈는지 남지 않으니 편하게 적어 주세요. 닉네임과 계정 정보는 함께 보내지 않아요.
            <br />
            오류를 찾는 데 필요한 정보만 함께 보내요: {screen} 화면 · {deviceSummary()}
          </p>
        </div>
      </div>
      <div className="field-error" role="alert">
        {error}
      </div>
      <button className="primary full" type="submit" disabled={busy}>
        {busy ? '보내는 중…' : '의견 보내기'}
      </button>
    </form>
  );
}
