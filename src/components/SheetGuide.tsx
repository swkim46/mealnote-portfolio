// 운동 시트 연결 그림 안내(2026-11-01 사용자 요청): 시작 안내의 '운동 시트 연결' 쪽과 운동 탭의 시트 연결 창 안에서 열린다(창 위에 창을 띄우지 않음).
// 단계 문구·그림 경로는 src/lib/sheetGuide.ts, 공유할 이메일은 서비스 계정(SHEETS_ACCOUNT). 그림은 설치 때 미리 받지 않는다(guides/**)
import { BACK_LEVEL, useBackLayer } from '../lib/backNav';
import { useEffect, useRef, useState } from 'react';
import { SHEETS_ACCOUNT } from '../lib/api';
import { SheetsAccountCode } from './Bits';
import { copyText } from '../lib/clipboard';
import { sheetGuideImage, sheetGuideSteps, type SheetGuideRole } from '../lib/sheetGuide';
import { plain, rich } from './guideText';

/** onConnect: 그림을 다 본 뒤 바로 연결 화면으로(시작 안내에서 열 때 — 2026-11-03 사용자 요청: 설명과 연결 화면을 잇는다) */
export function SheetGuide({ role, onBack, backLabel, onConnect, connectLabel }: { role: SheetGuideRole; onBack: () => void; backLabel: string; onConnect?: () => void; connectLabel?: string }) {
  const [copied, setCopied] = useState<'' | 'ok' | 'fail'>('');
  const top = useRef<HTMLDivElement>(null);
  // 창 본문을 맨 위로(알림 설정 그림 안내와 같은 이유)
  useEffect(() => {
    top.current?.closest('.sheet-body')?.scrollTo({ top: 0 });
  }, []);
  useBackLayer(true, onBack, { level: BACK_LEVEL.inner, surface: () => [top.current?.closest<HTMLElement>('.sheet-body')] });
  const steps = sheetGuideSteps(role);
  return (
    <div className="notification-guide sheet-guide" ref={top} data-testid="sheet-guide">
      <button type="button" className="text-button guide-back" onClick={onBack}>
        ← {backLabel}
      </button>
      <h3>운동 시트 연결 방법</h3>
      <p className="hint">구글 운동 시트를 연결하면 그 달 루틴이 앱에 들어오고, 앱에서 저장한 운동 기록이 시트에 적혀요.</p>
      <ol className="guide-steps">
        {/* 먼저 복사해야 다음 단계가 된다: 복사 버튼을 단계 밖에 두면 안 보인다(사용자 11-06) */}
        <li className="guide-step guide-step-copy">
          <div className="guide-step-text">
            <strong className="guide-step-title">1. FITORY 이메일 복사</strong>
            <p>이 이메일을 시트에 추가해야 앱이 시트를 읽고 적을 수 있어요.</p>
          </div>
          <div className="guide-copy">
            <SheetsAccountCode />
            <button type="button" className="primary full" onClick={() => void copyText(SHEETS_ACCOUNT).then((ok) => setCopied(ok ? 'ok' : 'fail'))}>
              이메일 복사
            </button>
            <span className="tiny" aria-live="polite">
              {copied === 'ok' ? '이메일을 복사했어요. 이제 구글 시트를 여세요.' : copied === 'fail' ? '복사하지 못했어요. 이메일을 길게 눌러 복사해 주세요.' : ''}
            </span>
          </div>
        </li>
        {steps.map((s, i) => (
          <li key={i} className="guide-step">
            <div className="guide-step-text">
              <strong className="guide-step-title">
                {i + 2}. {s.title}
              </strong>
              <p>{rich(s.text)}</p>
              <p className="hint">{s.sub}</p>
            </div>
            <img className="guide-step-image" src={sheetGuideImage(role, i + 1)} alt={`${i + 2}단계 화면 예시: ${plain(s.text)}`} width={720} height={1400} loading="lazy" decoding="async" />
          </li>
        ))}
      </ol>
      <p className="hint">구글 시트 그림은 설명을 위한 예시예요. 기기·버전에 따라 메뉴 이름과 위치가 조금 다를 수 있어요.</p>
      {onConnect && (
        <button type="button" className="primary full" onClick={onConnect}>
          {connectLabel ?? '지금 연결하기'}
        </button>
      )}
      <button type="button" className={onConnect ? 'secondary full' : 'primary full'} onClick={onBack}>
        {backLabel}
      </button>
    </div>
  );
}
