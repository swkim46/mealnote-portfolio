import { useState } from 'react';
import { RELEASE_VERSION, RELEASES, releaseDate, VERSION_LABEL } from '../lib/releases';

function ReleaseItem({ r }: { r: (typeof RELEASES)[number] }) {
  return (
    <section className="release">
      <div className="release-head">
        <strong>v{r.version}</strong>
        <span className="tiny">{releaseDate(r.date)}</span>
        {r.version === RELEASE_VERSION && <span className="status">지금 버전 {VERSION_LABEL}</span>}
      </div>
      <ul>
        {r.items.map((it) => (
          <li key={it}>{it}</li>
        ))}
      </ul>
    </section>
  );
}

/** 가장 최근 업데이트만 펼치고, 이전 내역은 눌렀을 때만 보인다(쌓일수록 길어지지 않게) */
export function ReleaseNotes() {
  const [showOlder, setShowOlder] = useState(false);
  const [latest, ...older] = RELEASES;
  return (
    <div className="release-notes">
      <ReleaseItem r={latest} />
      {older.length > 0 && (
        <>
          <button className="older-toggle" aria-expanded={showOlder} onClick={() => setShowOlder((v) => !v)}>
            {showOlder ? '이전 업데이트 접기' : `이전 업데이트 보기 (${older.length})`}
          </button>
          {showOlder && older.map((r) => <ReleaseItem key={r.version} r={r} />)}
        </>
      )}
    </div>
  );
}

/** 화면 맨 아래 한 줄: 버전 · 업데이트 소식 */
export function VersionLine({ onClick }: { onClick?: () => void }) {
  const text = (
    <>
      식단노트 {VERSION_LABEL} · 업데이트 소식
    </>
  );
  return onClick ? (
    <button className="version-line" onClick={onClick}>
      {text}
    </button>
  ) : (
    <p className="version-line">식단노트 {VERSION_LABEL}</p>
  );
}
