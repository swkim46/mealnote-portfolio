// crypto.randomUUID는 https·localhost에서만 열린다.
// 휴대폰으로 개발 서버(http://192.168…)에 붙으면 없어서 식단 저장이 멈췄다(2026-10-21).
// getRandomValues는 어디서나 되므로 그것으로 UUID v4를 만든다.
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
