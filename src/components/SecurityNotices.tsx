import { useCallback, useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import { useToast } from './Toast';
import { ReclaimForm, RecoverySetupForm } from './PinForms';
import { ackPinChange, getAck, mySecurityStatus, reportNotMe, setAck, takeFreshLogin, type SecurityStatus } from '../lib/pin';
import { dateKey, prettyDay } from '../lib/dates';
import type { Profile } from '../lib/types';

type Notice = 'pin_changed' | 'reclaim' | 'cannot_reclaim' | 'failed' | 'setup' | null;
const LATER_KEY = 'mealnote:recovery-later';

const when = (iso: string) => {
  const d = new Date(iso);
  return `${prettyDay(dateKey(d))} ${d.toTimeString().slice(0, 5)}`;
};

/**
 * 로그인해 둔 기기에 띄우는 보안 알림(v1.3).
 * - PIN이 바뀜(이 기기에서 바꾼 게 아니면): '직접 바꾸신 게 맞나요?' → 아니면 되찾기
 * - 누가 PIN 찾기에서 답을 틀림
 * - 복구 질문이 없는 기존 계정: 하루 한 번 정하라고 안내
 * 비교는 모두 서버 시각끼리 한다.
 */
export function SecurityNotices({ profile }: { profile: Profile }) {
  const toast = useToast();
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const uid = profile.id;

  const check = useCallback(async () => {
    let st: SecurityStatus;
    try {
      st = await mySecurityStatus();
    } catch {
      return;
    }
    setStatus(st);
    const ack = getAck(uid);
    if (takeFreshLogin() || !ack) {
      // 이 기기에서 방금 로그인했거나 처음 확인하는 기기: 지금 상태를 이미 아는 것으로 본다
      setAck(uid, { pin: st.pin_changed_at, fail: st.last_failed_at });
    } else if (st.pin_changed_at && (!ack.pin || Date.parse(st.pin_changed_at) > Date.parse(ack.pin))) {
      setNotice((n) => n ?? 'pin_changed');
      return;
    } else if (st.last_failed_at && st.failed_count > 0 && (!ack.fail || Date.parse(st.last_failed_at) > Date.parse(ack.fail))) {
      setNotice((n) => n ?? 'failed');
      return;
    }
    if (!st.has_recovery) {
      let later = '';
      try {
        later = localStorage.getItem(LATER_KEY) ?? '';
      } catch {
        /* 무시 */
      }
      if (later !== dateKey(new Date())) setNotice((n) => n ?? 'setup');
    }
  }, [uid]);

  useEffect(() => {
    void check();
    const onVisible = () => document.visibilityState === 'visible' && void check();
    document.addEventListener('visibilitychange', onVisible);
    const t = window.setInterval(onVisible, 60000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(t);
    };
  }, [check]);

  const close = () => setNotice(null);
  let title = '';
  let body = null;
  if (notice === 'pin_changed' && status?.pin_changed_at) {
    title = 'PIN이 바뀌었어요';
    body = (
      <div className="security-notice">
        <p className="forgot-text">
          <strong>{when(status.pin_changed_at)}</strong>에 이 계정의 PIN이 바뀌었어요. 직접 바꾸신 게 맞나요?
        </p>
        <button
          className="primary full"
          onClick={() => {
            setAck(uid, { pin: status.pin_changed_at });
            void ackPinChange().catch(() => {});
            close();
          }}
        >
          네, 제가 바꿨어요
        </button>
        <button
          className="secondary full danger-outline"
          onClick={async () => {
            try {
              await reportNotMe();
            } catch {
              /* 기록이 안 돼도 되찾기는 진행한다 */
            }
            setNotice(status.can_reclaim ? 'reclaim' : 'cannot_reclaim');
          }}
        >
          제가 바꾼 게 아니에요
        </button>
      </div>
    );
  } else if (notice === 'reclaim') {
    title = '계정 되찾기';
    body = (
      <ReclaimForm
        uid={uid}
        onDone={() => {
          close();
          toast('계정을 되찾았어요. 다른 기기는 모두 로그아웃됐어요.');
          void check();
        }}
      />
    );
  } else if (notice === 'cannot_reclaim') {
    title = 'PIN을 다시 정해 주세요';
    body = (
      <div className="security-notice">
        <p className="forgot-text">
          이 기기는 PIN이 바뀐 뒤에 로그인해서, 여기서 바로 되찾을 수는 없어요. 운영자에게는 기록을 남겼어요.
        </p>
        <p className="forgot-text small">로그아웃한 뒤 로그인 화면의 'PIN을 잊으셨나요?'에서 복구 질문에 답해 새 PIN을 정해 주세요.</p>
        <button className="primary full" onClick={close}>
          확인했어요
        </button>
      </div>
    );
  } else if (notice === 'failed' && status?.last_failed_at) {
    title = 'PIN 찾기 시도가 있었어요';
    body = (
      <div className="security-notice">
        <p className="forgot-text">
          <strong>{when(status.last_failed_at)}</strong>에 누군가 PIN 찾기에서 복구 질문의 답을 틀렸어요
          {status.locked_until ? '. 여러 번 틀려서 PIN 찾기가 하루 동안 막혔어요.' : ` (${status.failed_count}번).`}
        </p>
        <p className="forgot-text small">직접 시도하신 거라면 괜찮아요. 아니라면 복구 질문을 다른 것으로 바꿔 두면 더 안전해요.</p>
        <button
          className="primary full"
          onClick={() => {
            setAck(uid, { fail: status.last_failed_at });
            close();
          }}
        >
          확인했어요
        </button>
        <button
          className="secondary full"
          onClick={() => {
            setAck(uid, { fail: status.last_failed_at });
            setNotice('setup');
          }}
        >
          복구 질문 바꾸기
        </button>
      </div>
    );
  } else if (notice === 'setup') {
    title = status?.has_recovery ? '복구 질문 바꾸기' : '복구 질문을 정해 주세요';
    body = (
      <>
        <RecoverySetupForm
          onDone={() => {
            close();
            void check();
          }}
        />
        {!status?.has_recovery && (
          <button
            className="text-button forgot-back"
            onClick={() => {
              try {
                localStorage.setItem(LATER_KEY, dateKey(new Date()));
              } catch {
                /* 무시 */
              }
              close();
            }}
          >
            나중에 할게요
          </button>
        )}
      </>
    );
  }

  return (
    <Sheet open={!!body} title={title} onClose={close}>
      {body}
    </Sheet>
  );
}
