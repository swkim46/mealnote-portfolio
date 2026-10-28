import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchInbody } from '../lib/api';
import type { InbodyRecord } from '../lib/types';

export const INBODY_PRIVACY =
  '사진에서 측정일·체중·골격근량·체지방률만 읽고 바로 버려요. 서버로 보내거나 앱에 저장하지 않아요(앨범의 사진은 그대로예요). 결과지의 전화번호·이름 같은 정보는 가져오지 않아요.';

export type InbodyState = ReturnType<typeof useInbody>;

/**
 * 회원 한 명의 인바디 기록.
 * - active일 때(인바디 화면을 보고 있을 때) 들어올 때마다, 앱으로 돌아올 때마다 다시 불러온다(다른 기기에서 바꾼 값 반영).
 * - 회원을 빨리 바꾸면 이전 회원의 늦은 응답이 올 수 있다 → 가장 최근 요청의 응답만 반영한다(Codex 리뷰 v1.4 P2).
 * - 다시 불러오다 실패하면 이미 보이던 기록은 그대로 둔다.
 */
export function useInbody(memberId: string | null, active = true) {
  const [records, setRecords] = useState<InbodyRecord[]>([]);
  const [state, setState] = useState<{ for: string | null; failed: boolean }>({ for: null, failed: false });
  const latest = useRef(0);
  const load = useCallback(() => {
    if (!memberId) return Promise.resolve();
    const ticket = ++latest.current;
    return fetchInbody(memberId).then(
      (r) => {
        if (ticket !== latest.current) return;
        setRecords(r);
        setState({ for: memberId, failed: false });
      },
      () => {
        if (ticket !== latest.current) return;
        setState((s) => (s.for === memberId && !s.failed ? s : { for: memberId, failed: true }));
      },
    );
  }, [memberId]);
  useEffect(() => {
    if (!active) return;
    void load();
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load, active]);
  const loaded = state.for === memberId;
  return { records: loaded ? records : [], loaded, failed: loaded && state.failed, reload: load };
}
