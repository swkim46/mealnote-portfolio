// 설정 → 계정의 성별(2.3 — 사용자 결정 2026-11-05, 회원만). 남자·여자를 한 번 고르면 앱에서 바꿀 수 없고, 고를 때 확인 창을 띄운다.
// '성별 공개하지 않기'는 언제든 끄고 켠다. 안내 문구는 '성별을 쓰는 기능(중량왕 등)'으로 쓴다 — 성별은 앞으로 다른 기능에도 쓸 수 있어 중량왕에만 쓴다고 단정하지 않는다.
import { useEffect, useRef, useState } from 'react';
import { fetchMyGender, setGenderHidden, setMyGender, type Gender } from '../lib/api';
import { BACK_LEVEL, useBackLayer } from '../lib/backNav';
import { useLive } from '../lib/useLive';
import { Segmented, SettingsRow } from '../ui/kit';
import { ProfileSwitch } from './Community';
import { useToast } from './Toast';

export const GENDER_LABEL: Record<Gender, string> = { male: '남자', female: '여자' };

function GenderConfirm({ pick, busy, onCancel, onConfirm }: { pick: Gender; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  // 브라우저가 닫기를 막지 못하게 한 경우(Esc를 거듭 누름 등) 저장 중이면 다시 연다
  const reopen = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  // 뒤로 가기는 이 창만 닫는다. 저장하는 중에는 닫지 않는다
  useBackLayer(
    true,
    () => {
      if (busy) return false;
      onCancel();
    },
    { level: BACK_LEVEL.inner, surface: () => [ref.current] },
  );
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="gender-confirm-title"
      onClose={() => {
        if (!reopen.current) return onCancel();
        reopen.current = false;
        ref.current?.showModal();
      }}
      onCancel={(e) => {
        if (e.target !== e.currentTarget || !busy) return;
        e.preventDefault();
        reopen.current = !e.cancelable;
      }}
      data-testid="gender-confirm"
    >
      <strong id="gender-confirm-title">성별을 ‘{GENDER_LABEL[pick]}’로 정할까요?</strong>
      <p className="confirm-lead">저장한 뒤에는 앱에서 바꿀 수 없어요.</p>
      <p>수정이 필요하면 ‘의견 보내기’로 알려 주세요.</p>
      <p>성별에 따라 나누는 기능에 참여하지 않으려면 ‘성별 공개하지 않기’를 켜 주세요.</p>
      <div className="confirm-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          취소
        </button>
        <button type="button" className="primary" disabled={busy} onClick={onConfirm}>
          {busy ? '저장하는 중…' : `${GENDER_LABEL[pick]}로 정하기`}
        </button>
      </div>
    </dialog>
  );
}

export function GenderSetting({ userId }: { userId: string }) {
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const live = useLive(`gender-${userId}`, String(version), fetchMyGender);
  const [pick, setPick] = useState<Gender | null>(null);
  const [busy, setBusy] = useState(false);
  const gender = live.value?.gender ?? null;
  const save = async () => {
    if (!pick || busy) return;
    setBusy(true);
    try {
      await setMyGender(pick);
      toast(`성별을 ‘${GENDER_LABEL[pick]}’로 정했어요.`);
    } catch (e) {
      toast((e as Error).message === 'gender_locked' ? '이미 성별을 정했어요.' : '저장하지 못했어요. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
      setPick(null);
      setVersion((v) => v + 1);
    }
  };
  return (
    <>
      {!live.value ? (
        <SettingsRow label="성별" value={live.failed ? '불러오지 못했어요' : '확인 중'} />
      ) : gender ? (
        <SettingsRow label="성별" value={GENDER_LABEL[gender]} />
      ) : (
        <SettingsRow
          label="성별"
          control={
            <Segmented<Gender | ''>
              label="성별"
              value=""
              onChange={(v) => v && setPick(v)}
              options={[
                ['male', '남자'],
                ['female', '여자'],
              ]}
            />
          }
        />
      )}
      <ProfileSwitch
        userId={userId}
        label="성별 공개하지 않기"
        description="중량왕처럼 성별에 따라 나누는 기능에 참여하지 않아요."
        testId="gender-hidden"
        load={() => fetchMyGender().then((g) => g.hidden)}
        save={setGenderHidden}
        messages={{ on: '성별을 비공개로 바꿨어요.', off: '성별을 공개로 바꿨어요.' }}
      />
      {pick && <GenderConfirm pick={pick} busy={busy} onCancel={() => !busy && setPick(null)} onConfirm={() => void save()} />}
    </>
  );
}
