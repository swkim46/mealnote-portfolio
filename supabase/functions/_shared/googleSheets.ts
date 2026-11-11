// 구글 시트 API 접근(서버 기능 sheet-import·sheet-write가 같이 쓴다). 서비스 계정 키로 JWT(RS256)를 서명해 접근 토큰을 받는다.
// 비밀 GOOGLE_SA_KEY_B64 = 서비스 계정 키 JSON을 base64로(scripts/sheets-key-setup.mjs가 등록). 키·토큰은 로그에 남기지 않는다.
// 범위: 읽기는 spreadsheets.readonly, 쓰기(v2.1 앱 기록을 시트에)만 spreadsheets — 범위마다 토큰을 따로 둔다.
// 로컬 검증 전용 SHEETS_FAKE_BASE: 이 값이 있고 시트 id가 'zz'로 시작할 때만(시험 시트) 구글 대신 가짜 시트 서버(scripts/fake-sheets.mjs)를 부른다. 운영에는 두지 않는다.

export const SCOPE_READ = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const SCOPE_WRITE = 'https://www.googleapis.com/auth/spreadsheets';

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = new TextEncoder();
const cached = new Map<string, { token: string; exp: number }>();

export async function accessToken(scope: string): Promise<string> {
  const hit = cached.get(scope);
  if (hit && hit.exp > Date.now() / 1000 + 60) return hit.token;
  const raw = Deno.env.get('GOOGLE_SA_KEY_B64') ?? '';
  const key = (raw ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)))) : {}) as { client_email?: string; private_key?: string };
  if (!key.client_email || !key.private_key) throw new Error('no_key');
  const der = Uint8Array.from(atob(key.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const pk = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))}.${b64u(enc.encode(JSON.stringify({ iss: key.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })))}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pk, enc.encode(unsigned)));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64u(sig)}` }),
    signal: AbortSignal.timeout(15_000),
  });
  const t = await r.json();
  if (!t.access_token) throw new Error('token_failed');
  cached.set(scope, { token: t.access_token, exp: now + (t.expires_in ?? 3600) });
  return t.access_token;
}

const FAKE = Deno.env.get('SHEETS_FAKE_BASE') ?? '';
/** 시험 시트(가짜 서버)면 토큰 없이 */
export const isFakeSheet = (sheetId: string) => !!FAKE && sheetId.startsWith('zz');
// 로컬 시험의 호출 번호: 가짜 시트 서버 기록까지 이어 실패를 맞춰 본다. 겹친 요청이 서로의 번호를 쓰지 않게 요청마다 가짜 토큰에 싣는다(v2.3.0 3차 리뷰). 운영에는 FAKE가 없어 쓰지 않는다
const FAKE_TOKEN = 'fake ';
export const sheetToken = (sheetId: string, scope: string, req: Request) => (isFakeSheet(sheetId) ? Promise.resolve(`${FAKE_TOKEN}${req.headers.get('x-check-call') ?? ''}`) : accessToken(scope));

/**
 * 시트 API 호출: path는 '?fields=…'·'/values/…'·'/values:batchUpdate' 꼴. 요청 하나는 15초 안에 끝나거나 끊긴다 —
 * 시트 쓰기의 차례(60초, sheet_write_begin)가 끝나기 전에 쓰기 결과가 정해지게(토큰 받기도 같다)
 */
export async function sheetsFetch(token: string, sheetId: string, path: string, init: RequestInit = {}) {
  const fake = isFakeSheet(sheetId);
  const call = fake ? token.slice(FAKE_TOKEN.length) : '';
  const started = Date.now();
  try {
    return await fetch(`${fake ? FAKE : 'https://sheets.googleapis.com/v4/spreadsheets'}/${encodeURIComponent(sheetId)}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(call ? { 'x-check-call': call } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // 어느 단계가 끊겼는지 남긴다. 연결 오류 문구에는 시트 주소가 들어 있어 운영에서는 오류 종류만 적는다
    const step = path.includes(':batchUpdate') ? 'batchUpdate' : path.startsWith('/values') ? 'values' : 'meta';
    console.error(`sheets ${init.method ?? 'GET'} ${step} failed after ${Date.now() - started}ms${call ? ` call ${call}` : ''}: ${fake ? (e as Error).message : (e as Error).name}`);
    throw e;
  }
}

/** 탭 이름 목록(시트 순서) */
export async function sheetTabs(token: string, sheetId: string): Promise<{ status: number; tabs: string[] }> {
  const r = await sheetsFetch(token, sheetId, '?fields=properties.title,sheets.properties(sheetId,title,index)');
  if (!r.ok) return { status: r.status, tabs: [] };
  const meta = await r.json();
  return { status: 200, tabs: (meta.sheets ?? []).map((s: { properties: { title: string } }) => s.properties.title) };
}

/** 탭 이름을 시트 범위 글자로('2512/back/up'·'2606의 사본'처럼 기호·공백이 있어도) */
export const tabRange = (tab: string, cells = 'A1:Z300') => `'${tab.replace(/'/g, "''")}'!${cells}`;

/**
 * 탭 하나의 칸 글자. 기본은 보이는 그대로(가져오기 — 시트에 보이는 기록).
 * raw면 숫자는 표시 형식을 거치지 않은 값(12.5가 정수 형식으로 '13'·단위 형식으로 '12.5kg'·천 단위로 '1,000'처럼 보여도 그 값),
 * 날짜·시간은 보이는 글자로 받는다 — 시트 쓰기가 앱이 쓴 칸을 견줄 때(Codex v2.1.0 3차 리뷰 P2, 적대 검토 11-03)
 */
export async function sheetValues(token: string, sheetId: string, tab: string, raw = false): Promise<string[][]> {
  const render = raw ? 'valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING' : 'valueRenderOption=FORMATTED_VALUE';
  const r = await sheetsFetch(token, sheetId, `/values/${encodeURIComponent(tabRange(tab))}?majorDimension=ROWS&${render}`);
  if (!r.ok) throw new Error(`values_${r.status}`);
  const vals = await r.json();
  return (vals.values ?? []).map((row: unknown[]) => row.map((c) => String(c ?? '').slice(0, 200)));
}
