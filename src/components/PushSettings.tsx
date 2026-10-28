import { useEffect, useRef, useState } from 'react';
import { InstallHint } from './AccountPanel';
import { NotificationGuide } from './NotificationGuide';
import { deviceState, disablePush, enablePush, fetchPrefs, pushSupport, savePrefs, type DeviceState, type EnableResult, type PushPrefs } from '../lib/push';
import type { Profile } from '../lib/types';

const ENABLE_TEXT: Record<Exclude<EnableResult, 'ok'>, string> = {
  denied: '알림이 허용되지 않았어요. 휴대폰 설정에서 식단노트 알림을 허용한 뒤 다시 눌러 주세요.',
  subscribe_failed: '이 기기에서 알림을 등록하지 못했어요. 잠시 후 다시 시도해 주세요.',
  save_failed: '알림 설정을 저장하지 못했어요. 연결을 확인하고 다시 시도해 주세요.',
  bad_endpoint: '이 브라우저의 알림 서비스는 지원하지 않아요.',
  unsupported: '이 화면에서는 알림을 켤 수 없어요.',
};

// 서버 값을 모르는 상태(불러오는 중·실패)에서는 바꿀 수 없게 한다. 실패를 기본값으로 바꾸면 하나만 바꿔도
// 다른 항목까지 기본값으로 저장돼 다른 기기의 설정을 덮는다(Codex v1.7 품질 리뷰 1).
type Loaded<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T };

/** 내 정보 → 알림 설정: 이 기기 켜기·끄기(기기마다)와 알림 종류(계정 전체) */
export function PushSettings({ profile }: { profile: Profile }) {
  const support = pushSupport();
  const [device, setDevice] = useState<Loaded<DeviceState>>({ status: 'loading' });
  const [prefs, setPrefs] = useState<Loaded<PushPrefs>>({ status: 'loading' });
  // 저장 중인 변경: 누른 값을 먼저 보여 주되 다른 항목은 잠근다. 서버 값으로 확정하거나, 실패하면 지운다(원래 값으로 돌아감)
  const [pending, setPending] = useState<Partial<PushPrefs> | null>(null);
  const saving = pending !== null;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [prefsError, setPrefsError] = useState('');
  // 그림 안내: 같은 창 안에서 바꿔 보여 준다(돌아오면 이 화면의 상태는 그대로)
  const [guide, setGuide] = useState(false);

  // 이 기기 상태(권한·구독·서버 등록). 앱 밖(휴대폰 설정)에서 권한을 바꾸고 돌아오거나 그림 안내에서 돌아오면 다시 확인한다
  // (Codex v1.7 운영 배포 후 리뷰 1). 늦게 온 옛 확인 결과는 버린다. 권한이 바뀌었다고 저절로 등록하지는 않는다.
  const deviceReq = useRef(0);
  const setDeviceNow = (value: DeviceState) => {
    deviceReq.current++;
    setDevice({ status: 'ready', value });
  };
  const loadDevice = (quiet = false) => {
    const id = ++deviceReq.current;
    if (!quiet) setDevice({ status: 'loading' });
    deviceState()
      .then((value) => id === deviceReq.current && setDevice({ status: 'ready', value }))
      .catch(() => id === deviceReq.current && setDevice({ status: 'error' }));
  };
  const loadPrefs = () => {
    setPrefs({ status: 'loading' });
    fetchPrefs(profile.id)
      .then((value) => setPrefs({ status: 'ready', value }))
      .catch(() => setPrefs({ status: 'error' }));
  };
  useEffect(() => {
    // 창을 열 때 서버·브라우저 상태를 맞추고, 앱으로 돌아올 때마다 이 기기 상태를 다시 확인한다
    loadDevice();
    loadPrefs();
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadDevice(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);

  async function turnOn() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const { result, tested } = await enablePush();
      if (result === 'ok') {
        setDeviceNow('on');
        setMessage(tested ? '알림을 켰어요. 시험 알림을 보냈어요.' : '알림을 켰어요.');
      } else {
        setError(ENABLE_TEXT[result]);
        if (result === 'denied') setDeviceNow(Notification.permission === 'denied' ? 'denied' : 'off');
      }
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await disablePush();
      setDeviceNow('off');
      setMessage('이 기기의 알림을 껐어요.');
    } catch {
      setError('알림을 끄지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  // 한 번에 하나씩 저장한다: 저장하는 동안 다른 항목은 잠그고, 서버가 돌려준 값으로 화면을 확정한다.
  // 바꾼 항목만 보내므로 다른 기기에서 바꾼 항목을 덮지 않는다(Codex v1.7 품질 리뷰 2).
  async function change(patch: Partial<PushPrefs>) {
    if (prefs.status !== 'ready' || saving) return;
    setPending(patch);
    setPrefsError('');
    try {
      setPrefs({ status: 'ready', value: await savePrefs(profile.id, patch) });
    } catch {
      setPrefsError('알림 종류를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setPending(null);
    }
  }

  const isTrainer = profile.role === 'trainer';
  const shown = prefs.status === 'ready' ? { ...prefs.value, ...pending } : null;
  if (guide)
    return (
      <NotificationGuide
        onBack={() => {
          setGuide(false);
          loadDevice(true); // 안내를 따라 휴대폰 설정을 바꾸고 돌아왔을 수 있다
        }}
      />
    );
  return (
    <div className="push-settings">
      <section className="push-guide-entry">
        <h3>휴대폰에서 새 소식 받기</h3>
        <p className="hint">사용하는 휴대폰을 고르고 순서대로 따라 해 보세요. 홈 화면 추가부터 알림 허용까지 안내해 드려요.</p>
        <button type="button" className="secondary full" onClick={() => setGuide(true)}>
          알림 설정 방법 보기
        </button>
      </section>
      <section>
        <h3>이 기기</h3>
        {support === 'install' ? (
          <>
            <p className="hint">홈 화면에 추가한 앱에서 알림을 켤 수 있어요. 추가한 앱으로 열어 다시 들어와 주세요.</p>
            <InstallHint />
          </>
        ) : support === 'unsupported' ? (
          <p className="hint">이 브라우저에서는 알림을 받을 수 없어요.</p>
        ) : support === 'unconfigured' ? (
          <p className="hint">알림을 준비하고 있어요. 다음 업데이트에서 켤 수 있어요.</p>
        ) : device.status === 'loading' ? (
          <p className="hint">확인하고 있어요…</p>
        ) : device.status === 'error' ? (
          <>
            <p className="hint">이 기기의 알림 상태를 확인하지 못했어요.</p>
            <button type="button" className="secondary full" onClick={() => loadDevice()}>
              다시 확인
            </button>
          </>
        ) : device.value === 'on' ? (
          <>
            <p className="push-state on">이 기기에서 알림을 받고 있어요.</p>
            <button type="button" className="secondary full" disabled={busy} onClick={() => void turnOff()}>
              이 기기 알림 끄기
            </button>
          </>
        ) : device.value === 'denied' ? (
          <p className="hint">알림이 꺼져 있어요. 휴대폰 설정 → 알림에서 식단노트를 허용해 주세요.</p>
        ) : (
          <>
            <p className="push-state">이 기기는 알림을 받지 않아요.</p>
            <button type="button" className="primary full" disabled={busy} onClick={() => void turnOn()}>
              {busy ? '켜는 중…' : '이 기기에서 알림 받기'}
            </button>
          </>
        )}
        {message && <p className="push-message">{message}</p>}
        {error && <p className="field-error">{error}</p>}
      </section>

      <section aria-busy={saving}>
        <h3>받을 알림</h3>
        <p className="hint">모든 기기에 함께 적용돼요.</p>
        {prefs.status === 'loading' ? (
          <p className="hint">불러오는 중…</p>
        ) : prefs.status === 'error' ? (
          <>
            <p className="field-error">알림 종류를 불러오지 못했어요. 지금 설정을 확인한 뒤에 바꿀 수 있어요.</p>
            <button type="button" className="secondary full" onClick={loadPrefs}>
              다시 불러오기
            </button>
          </>
        ) : isTrainer ? (
          <>
            <label className="remember-row">
              <input type="checkbox" checked={shown!.digest} disabled={saving} onChange={(e) => void change({ digest: e.target.checked })} />
              <span>확인할 식사 기록·답할 질문 요약</span>
            </label>
            <div className="role-switch" role="group" aria-label="요약 받는 횟수">
              <button type="button" aria-pressed={shown!.digest_times === '3'} disabled={saving || !shown!.digest} onClick={() => void change({ digest_times: '3' })}>
                하루 3회 <small>9·15·21시</small>
              </button>
              <button type="button" aria-pressed={shown!.digest_times === '5'} disabled={saving || !shown!.digest} onClick={() => void change({ digest_times: '5' })}>
                하루 5회 <small>9·12·15·18·21시</small>
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="remember-row">
              <input type="checkbox" checked={shown!.morning} disabled={saving} onChange={(e) => void change({ morning: e.target.checked })} />
              <span>아침 응원(오전 9시, 오늘의 한마디)</span>
            </label>
            <label className="remember-row">
              <input type="checkbox" checked={shown!.feedback} disabled={saving} onChange={(e) => void change({ feedback: e.target.checked })} />
              <span>트레이너가 남긴 피드백</span>
            </label>
            <label className="remember-row">
              <input type="checkbox" checked={shown!.reminder} disabled={saving} onChange={(e) => void change({ reminder: e.target.checked })} />
              <span>식단 기록 알림(낮 1시 점심 · 저녁 8시 저녁, 기록이 없을 때만)</span>
            </label>
          </>
        )}
        {prefsError && <p className="field-error">{prefsError}</p>}
      </section>
      <p className="hint push-note">알림은 휴대폰 설정이나 집중 모드에 따라 늦거나 보이지 않을 수 있어요. 앱 안의 표시는 그대로 남아요.</p>
    </div>
  );
}
