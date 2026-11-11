import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 다시 받는 조회. scope(무엇을 보는가)가 바뀌면 옛 값을 버리고, version(그 대상의 내용이 바뀌었다는 신호)이 바뀌거나
 * 앱으로 돌아오면 같은 대상을 다시 받는다. 다시 받는 동안·실패해도 마지막 정상 값은 그대로 두고, 실패는 따로 알린다.
 */
export function useLive<T>(scope: string, version: string, load: () => Promise<T>) {
  const [state, setState] = useState<{ scope: string; value?: T; failed: boolean; failedFor?: string }>({ scope, failed: false });
  const req = useRef(0);
  const loadRef = useRef(load);
  const versionRef = useRef(version);
  useEffect(() => {
    loadRef.current = load;
    versionRef.current = version;
  });
  const run = useCallback(() => {
    const n = ++req.current;
    const v = versionRef.current;
    loadRef
      .current()
      .then((value) => n === req.current && setState({ scope, value, failed: false }))
      .catch(() => n === req.current && setState((s) => (s.scope === scope ? { ...s, failed: true, failedFor: v } : { scope, failed: true, failedFor: v })));
  }, [scope]);
  useEffect(() => {
    run();
  }, [run, version]);
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && run();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [run]);
  const mine = state.scope === scope;
  // failedNow: 지금 version의 조회가 실패함 — version이 바뀌어 새로 받는 중이면 거짓(옛 실패로 '불러오지 못했어요'를 띄우지 않게, Codex v2.2.0 1차 리뷰 뒤 적대 검토)
  return { value: mine ? state.value : undefined, failed: mine && state.failed, failedNow: mine && state.failed && state.failedFor === version, reload: run };
}
