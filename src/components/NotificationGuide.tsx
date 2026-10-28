// 알림 설정 그림 안내(2026-10-27): 알림 설정 창 안에서 열린다(창 위에 창을 띄우지 않음). 기종은 사용자가 고르고,
// 기본 선택만 휴대폰 종류로 추정한다. 안내를 연다고 권한을 묻거나 설치를 판정하지 않는다 — 알림 받기는 사용자가 직접 누른다.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { GUIDE_HELP, GUIDE_INTRO, GUIDE_STEPS, guideImage, SERVICE_URL, type GuidePlatform } from '../lib/notificationGuide';

const guessPlatform = (): GuidePlatform => (/Android/i.test(navigator.userAgent) ? 'android' : 'ios');

/** 문구의 <b>…</b>만 굵은 글씨로 바꾼다(HTML로 넣지 않음) */
function rich(text: string): ReactNode[] {
  return text.split(/(<b>.*?<\/b>)/g).map((part, i) => (part.startsWith('<b>') ? <strong key={i}>{part.slice(3, -4)}</strong> : part));
}

const plain = (text: string) => text.replace(/<\/?b>/g, '');

export function NotificationGuide({ onBack }: { onBack: () => void }) {
  const [platform, setPlatform] = useState<GuidePlatform>(guessPlatform);
  const [copied, setCopied] = useState<'' | 'ok' | 'fail'>('');
  const top = useRef<HTMLDivElement>(null);
  // 창 본문을 맨 위로(scrollIntoView는 창의 고정 제목줄 아래로 첫 줄을 가린다)
  useEffect(() => {
    top.current?.closest('.sheet-body')?.scrollTo({ top: 0 });
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(SERVICE_URL);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  }

  const steps = GUIDE_STEPS[platform];
  return (
    <div className="notification-guide" ref={top}>
      <button type="button" className="text-button guide-back" onClick={onBack}>
        ← 알림 설정으로 돌아가기
      </button>
      <h3>휴대폰에서 새 소식 받기</h3>
      <div className="role-switch" role="group" aria-label="사용하는 휴대폰">
        {(['ios', 'android'] as const).map((p) => (
          <button key={p} type="button" aria-pressed={platform === p} onClick={() => setPlatform(p)}>
            {p === 'ios' ? '아이폰' : '안드로이드'}
          </button>
        ))}
      </div>
      <p className="hint">{GUIDE_INTRO[platform]}</p>
      <div className="guide-copy">
        <button type="button" className="secondary" onClick={() => void copy()}>
          식단노트 주소 복사
        </button>
        <span className="tiny" aria-live="polite">
          {copied === 'ok' ? '주소를 복사했어요.' : copied === 'fail' ? `복사하지 못했어요. ${SERVICE_URL} 을 직접 입력해 주세요.` : SERVICE_URL}
        </span>
      </div>
      <ol className="guide-steps">
        {steps.map((s, i) => (
          <li key={`${platform}-${i}`} className="guide-step">
            <div className="guide-step-text">
              <strong className="guide-step-title">
                {i + 1}. {s.title}
              </strong>
              <p>{rich(s.text)}</p>
              <p className="hint">{s.sub}</p>
            </div>
            <img
              className="guide-step-image"
              src={guideImage(platform, i + 1)}
              alt={`${platform === 'ios' ? '아이폰' : '안드로이드'} ${i + 1}단계 화면 예시: ${plain(s.text)}`}
              width={720}
              height={1400}
              loading="lazy"
              decoding="async"
            />
          </li>
        ))}
      </ol>
      <p className="guide-done">‘이 기기에서 알림을 받고 있어요’가 보이면 설정 완료!</p>
      <p className="hint">휴대폰 메뉴 그림은 설명을 위한 예시예요. 휴대폰·버전에 따라 메뉴 이름과 위치가 조금 다를 수 있어요.</p>
      <h3>막힐 때</h3>
      <div className="guide-help">
        {GUIDE_HELP.map((h) => (
          <details key={h.q}>
            <summary>{h.q}</summary>
            {h.a.map((a, i) => (
              <p key={i}>
                {a.label && <strong>{a.label}: </strong>}
                {a.text}
              </p>
            ))}
          </details>
        ))}
      </div>
      <button type="button" className="primary full" onClick={onBack}>
        알림 설정으로 돌아가기
      </button>
    </div>
  );
}
