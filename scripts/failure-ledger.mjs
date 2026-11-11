// 화면 흐름 검증(e2e-flow)의 '브라우저 오류 없음'에서 뺄 오류를 정한다(Codex v2.0.2 1차 리뷰 P3 — API 주소만 맞으면 시험 밖의 같은 실패도 뺐다).
// 시험이 일부러 만든 실패 응답을 하나씩 기록해 두고(방식·주소·상태·본문·이유), 그 응답과 주소·상태가 같은 오류를 기록 하나에 한 번만 뺀다.
// 같은 API라도 기록에 없는 실패, 기록보다 많은 실패는 브라우저 오류로 센다. 콘솔 문구에는 요청 방식이 없어 방식은 기록에만 남긴다.
// 오류 문구는 e2e-flow가 모으는 꼴이다: 'console: <문구> @ <주소>' · 'pageerror: <문구>'
export function failureLedger() {
  const entries = [];
  /** 실패 응답 하나를 기록한다. message가 있으면 앱이 콘솔에 찍는 그 응답 본문({message: …})도 한 번 뺀다 */
  const allow = ({ method, url, status, why, message = null }) => {
    entries.push({ method, url, status, why, message, res: false, log: message === null });
  };
  const take = (error) => {
    const res = /^console: Failed to load resource: the server responded with a status of (\d{3}) .* @ (\S+)$/.exec(error);
    if (res) {
      const e = entries.find((x) => !x.res && x.status === Number(res[1]) && x.url === res[2]);
      if (e) e.res = true;
      return e;
    }
    const body = /^console: \{message: ([^,}]*)[,}]/.exec(error);
    if (body) {
      const e = entries.find((x) => !x.log && x.message === body[1]);
      if (e) e.log = true;
      return e;
    }
    return undefined;
  };
  /** 모은 오류를 뺄 것(그 실패를 만든 기록과 함께)과 브라우저 오류로 셀 것으로 나눈다. 한 번만 부른다 */
  const split = (errors) => {
    const excluded = [], real = [];
    for (const error of errors) {
      const e = take(error);
      if (e) excluded.push({ error, method: e.method, why: e.why });
      else real.push(error);
    }
    return { excluded, real, unused: entries.filter((x) => !x.res).map(({ method, url, status, why }) => ({ method, url, status, why })) };
  };
  return { allow, split };
}
