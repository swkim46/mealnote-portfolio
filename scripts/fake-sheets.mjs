// 로컬 검증용 가짜 구글 시트 서버(v2.0 시트 자동 반영 · v2.1 회차 기록 가져오기·앱 기록 쓰기). 서버 기능 sheet-import·sheet-write는
// SHEETS_FAKE_BASE가 있고 시트 id가 'zz'로 시작할 때만 구글 대신 이 서버를 부른다(로컬 supabase/functions/.env — scripts/sheets-key-setup.mjs가 적음). 운영에는 그 설정이 없다.
// 서버 기능은 Docker 안에서 host.docker.internal:8789로 닿는다. 구글 시트 API의 세 요청(파일 정보·탭 값·값 쓰기 values:batchUpdate)만 흉내 낸다.
import http from 'node:http';

export const FAKE_SHEETS_PORT = 8789;

/** 'A1'·'AA12' → [행, 열](0부터) */
const cellAt = (a1) => {
  const m = /^([A-Z]+)(\d+)$/.exec(a1);
  const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return [Number(m[2]) - 1, col];
};
/** "'탭'!A1:Z300" → 탭 이름 */
const tabOf = (range) => /^'((?:[^']|'')*)'!/.exec(range)?.[1].replace(/''/g, "'") ?? '';

/**
 * 시트 id → { tabs, rows } 또는 { tabs, rowsByTab: {탭: rows} } 또는 { noAccess: true }. readOnly면 쓰기는 403(뷰어 공유).
 * delayFirstWriteMs면 첫 쓰기 하나만 그만큼 늦게 반영한다(늦게 끝난 옛 쓰기 재현, 2026-11-02 적대 검토).
 * delayFirstReadMs면 첫 탭 읽기 하나가 그 순간의 칸을 담아 두었다가 그만큼 늦게 돌려준다(읽는 중에 연결이 바뀌는 경우, Codex v2.1 2차 리뷰).
 * display(값)이 있으면 숫자 칸을 보이는 값(FORMATTED_VALUE)으로 읽을 때 그 글자로 보인다(칸의 표시 형식 — 정수 형식 '13'·단위 '40kg' 등, Codex v2.1.0 3차 리뷰).
 *   형식 없는 값(UNFORMATTED_VALUE)으로 읽으면 숫자 칸은 숫자로 돌려준다.
 * dropWriteResponse('RAW'·'USER_ENTERED')면 그 방식의 다음 쓰기 하나를 반영한 뒤 응답 없이 연결을 끊는다(쓰기는 됐는데 응답을 잃음, 같은 리뷰).
 * rejectWrite {status, input?}면 (그 방식의) 다음 쓰기 하나를 반영하지 않고 그 상태로 거절한다.
 * lateWrite {ms, input?}면 (그 방식의) 다음 쓰기 하나는 바로 연결을 끊고, ms 뒤에 반영한다 — 서버 기능이 포기한 요청을 구글이 늦게 반영하는 경우(같은 날 적대 검토).
 * 이 값들은 한 번 쓰이면 비워진다(기다리는 쪽이 시작을 알 수 있게). strictTabs면 탭 목록에 없는 탭을 읽거나 쓸 때 구글처럼 400을 돌려준다.
 * set으로 바꾸면 다음 요청부터 그 내용. writes(id)는 지금까지 받은 쓰기 [{tab, cell, value}], rowsOf(id, tab)은 쓴 뒤의 칸
 */
export function startFakeSheets() {
  const sheets = new Map();
  const writes = new Map();
  const rowsOf = (sh, tab) => (sh.rowsByTab ? (sh.rowsByTab[tab] ??= []) : sh.rows);
  // 요청 기록(시트마다 최근 50개): 받은 시각·끝난 시각(또는 끊음)·종류 — 서버 기능이 15초를 기다리다 끝난 시험 흔들림을
  // '요청이 오지 않음 / 늦게 왔음 / 받았는데 답하지 않음'으로 가르게(Codex v2.1.0 4차 리뷰의 원인 미확정 실패)
  const logs = new Map();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const [id, kind] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const sh = sheets.get(id);
    const entry = { kind: kind ?? 'meta', method: req.method, call: req.headers['x-check-call'] ?? '', at: Date.now(), end: null, how: '' };
    const list = logs.get(id) ?? [];
    list.push(entry);
    if (list.length > 50) list.shift();
    logs.set(id, list);
    res.on('finish', () => ((entry.end = Date.now()), (entry.how ||= `${res.statusCode}`)));
    res.on('close', () => !entry.end && ((entry.end = Date.now()), (entry.how = 'closed')));
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!sh || sh.noAccess) return send(403, { error: { code: 403 } });
    if (!kind) return send(200, { properties: { title: '가짜 시트' }, sheets: sh.tabs.map((title, index) => ({ properties: { sheetId: index, title, index } })) });
    if (kind === 'values') {
      const tab = tabOf(decodeURIComponent(u.pathname.split('/values/')[1] ?? ''));
      if (sh.strictTabs && !sh.tabs.includes(tab)) return send(400, { error: { code: 400, message: 'Unable to parse range' } });
      // 숫자 칸: 형식 없는 값(UNFORMATTED_VALUE)이면 숫자로, 보이는 값이면 시험이 정한 표시 형식(display)을 거친 글자로 — 구글처럼
      const raw = u.searchParams.get('valueRenderOption') === 'UNFORMATTED_VALUE';
      const plain = /^\d+(\.\d+)?$/;
      // 없는 탭이면 칸이 없다(undefined) — 그대로 빈 값으로 돌려준다(변환하다 멈춰 응답을 못 보내면 서버 기능이 15초를 기다린다)
      const values = (structuredClone(rowsOf(sh, tab)) ?? []).map((row) => (row ?? []).map((c) => (typeof c === 'string' && plain.test(c) ? (raw ? Number(c) : sh.display ? sh.display(c) : c) : c)));
      if (sh.delayFirstReadMs) {
        const ms = sh.delayFirstReadMs;
        sh.delayFirstReadMs = 0;
        await new Promise((r) => setTimeout(r, ms));
      }
      return send(200, { values });
    }
    if (kind === 'values:batchUpdate' && req.method === 'POST') {
      if (sh.readOnly) return send(403, { error: { code: 403, message: 'The caller does not have permission' } });
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', async () => {
        const body = JSON.parse(raw || '{}');
        if (sh.rejectWrite && (!sh.rejectWrite.input || sh.rejectWrite.input === body.valueInputOption)) {
          const code = sh.rejectWrite.status;
          sh.rejectWrite = null;
          return send(code, { error: { code } });
        }
        if (sh.lateWrite && (!sh.lateWrite.input || sh.lateWrite.input === body.valueInputOption)) {
          const ms = sh.lateWrite.ms;
          sh.lateWrite = null;
          res.destroy();
          await new Promise((r) => setTimeout(r, ms));
        }
        if (sh.delayFirstWriteMs) {
          const ms = sh.delayFirstWriteMs;
          sh.delayFirstWriteMs = 0;
          await new Promise((r) => setTimeout(r, ms));
        }
        const list = writes.get(id) ?? [];
        for (const d of body.data ?? []) {
          const tab = tabOf(d.range);
          const [r, c] = cellAt(d.range.split('!')[1]);
          const rows = rowsOf(sh, tab);
          while (rows.length <= r) rows.push([]);
          while (rows[r].length <= c) rows[r].push('');
          rows[r][c] = String(d.values?.[0]?.[0] ?? '');
          list.push({ tab, cell: d.range.split('!')[1], value: rows[r][c], input: body.valueInputOption });
        }
        writes.set(id, list);
        if (res.destroyed) return;
        if (sh.dropWriteResponse && sh.dropWriteResponse === body.valueInputOption) {
          sh.dropWriteResponse = '';
          return res.destroy();
        }
        send(200, { totalUpdatedCells: (body.data ?? []).length });
      });
      return;
    }
    return send(404, {});
  });
  // 연결은 오래 두고 다시 쓴다. 컨테이너에서 맥으로 가는 새 연결은 이 구간에서 드물게 서버에 닿지 않고 멈춘다(v2.3.0 3차 리뷰 측정: 12,777번 중 15번, 앱 없이 재현).
  // 응답마다 닫으면 호출마다 그 위험을 지고, 서버 기능이 15초 뒤 시간 초과로 끝난다
  server.keepAliveTimeout = 600_000;
  const counts = { requests: 0, connections: 0 };
  server.on('request', () => counts.requests++);
  server.on('connection', () => counts.connections++);
  return new Promise((resolve) =>
    server.listen(FAKE_SHEETS_PORT, '0.0.0.0', () =>
      resolve({
        set: (id, v) => sheets.set(id, v),
        writes: (id) => writes.get(id) ?? [],
        /** 그 시트의 요청 기록(최근 50개, 받은 시각 기준 ms·걸린 ms·결과) */
        log: (id) => (logs.get(id) ?? []).map((e) => ({ kind: e.kind, m: e.method, at: e.at, ms: e.end ? e.end - e.at : null, how: e.how })),
        /** 시트마다의 요청 기록 전체(시험이 실패했을 때 남긴다) */
        all: () => Object.fromEntries([...logs].map(([id, list]) => [id, list.map((e) => ({ kind: e.kind, m: e.method, call: e.call, at: e.at, ms: e.end ? e.end - e.at : null, how: e.how }))])),
        rowsOf: (id, tab) => rowsOf(sheets.get(id), tab),
        /** 지금까지 받은 요청·연결 수 */
        counts: () => counts,
        close: () => new Promise((r) => {
          server.close(() => r());
          server.closeAllConnections();
        }),
      }),
    ),
  );
}

/**
 * 실제 시트 양식을 본뜬 칸(필수 동작 · 1·2일차 블록 · 컨디션 줄 · 운동한 날 줄). weight로 한 칸만 바꿔 '시트가 바뀜'을 만든다.
 * 운동한 날 줄은 비어 있다(첫 회차 칸에 무게만 있는 새 달 탭) — 앱 기록을 쓰면 빈 회차 열(F)에 무게와 날짜가 들어간다(v2.1)
 */
export const sheetRows = (weight = '12.5') => [
  [],
  ['', '본 운동 전 필수 동작'],
  ['', '1. 폼롤링', '2. 오픈 북 스트레칭 10씩 X 2SET'],
  ['', '1'],
  ['', '', 'SET', 'REPS', '중량', '', '', '', 'REST'],
  ['', '데드버그+풀오버', '3', '20', '9', '', '', '', '-'],
  ['', '크록 로우', '4', '10/10', weight, '', '', '', '1.5'],
  ['', '', '', '컨디션'],
  ['', '', '', '운동한 날'],
  ['', '2'],
  ['', '', 'SET', 'REPS', '', '', '', '', 'REST'],
  ['', '스미스 머신 스퀏', '3', '8', '70', '', '', '', '2'],
  ['', '', '', '운동한 날'],
];
