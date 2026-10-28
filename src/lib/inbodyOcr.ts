// 인바디 결과지 사진에서 측정일·체중·골격근량·체지방률만 읽는다(2026-10-23 사용자 결정).
// - 인식은 이 기기 안에서만(Tesseract.js, 파일은 우리 주소 /ocr/에서). 사진을 서버나 외부로 보내지 않는다.
// - 사진은 메모리(캔버스)에서만 다루고, 끝나면 캔버스를 비우고 인식기를 끈다. 인식한 글 전체는 버리고 숫자 4개만 돌려준다.
// - 이름·전화번호(회원번호)·나이 같은 칸은 읽어도 쓰지 않는다.
// 읽는 방법: 1차로 전체 글자를 읽어 항목 이름(체중·골격근량·체지방률 등)의 위치를 찾고,
// 2차로 그 줄 오른쪽만 숫자 전용으로 다시 읽는다. 체성분 합계(체수분+단백질+무기질+체지방량=체중)와
// 체지방률=체지방량/체중으로 서로 맞춰 보고, 맞지 않는 값은 비워 둔다(회원이 직접 입력).
import { parseInbody, type OcrLine, type Region, type RegionRead } from './inbodyParse';

export type { InbodyValues } from './inbodyParse';

const MAX_SIDE = 2400;

/** 캔버스와, 앱이 실제로 받은 사진 크기(못 읽었을 때 원인을 알리려고 돌려준다) */
async function toCanvas(file: Blob): Promise<{ canvas: HTMLCanvasElement; source: [number, number] }> {
  const bitmap = await createImageBitmap(file);
  const source: [number, number] = [bitmap.width, bitmap.height];
  try {
    const scale = Math.min(2, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // 회색조 + 밝기 늘이기(종이 사진의 그림자·회색 표 배경을 옅게)
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      d[i] = g;
      hist[g | 0]++;
    }
    const total = d.length / 4;
    let lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += hist[lo]) < total * 0.01) lo++;
    acc = 0;
    while (hi > 0 && (acc += hist[hi]) < total * 0.05) hi--;
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return { canvas, source };
  } finally {
    bitmap.close();
  }
}

/** 영역 하나를 따로 떼어 키우고 흑백으로 만든다(작은 숫자 인식률을 높인다). 테두리에 흰 여백. */
const CROP_SCALE = 2.5;
/** 인식기가 알려 준 기울기를 캔버스 회전 방향으로 바꿀 때의 부호 */
const SKEW_SIGN = 1;

function cropFor(src: HTMLCanvasElement, r: Region['rect'], eraseBars: boolean, scale = CROP_SCALE): HTMLCanvasElement {
  const pad = 20;
  const c = document.createElement('canvas');
  c.width = Math.round(r.width * scale) + pad * 2;
  c.height = Math.round(r.height * scale) + pad * 2;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, r.left, r.top, r.width, r.height, pad, pad, c.width - pad * 2, c.height - pad * 2);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  // Otsu 문턱값으로 흑백
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
  const total = d.length / 4;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) [best, th] = [between, t];
  }
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = d[i] > th ? 255 : 0;
  // 막대 그래프 지우기: 글자보다 훨씬 긴 가로 검은 줄은 막대·선이다
  if (eraseBars) {
    const maxRun = Math.max(40, (c.height - pad * 2) * 0.6);
    for (let y = 0; y < c.height; y++) {
      let start = -1;
      for (let x = 0; x <= c.width; x++) {
        const black = x < c.width && d[(y * c.width + x) * 4] === 0;
        if (black && start < 0) start = x;
        if (!black && start >= 0) {
          if (x - start > maxRun) for (let k = start; k < x; k++) { const i = (y * c.width + k) * 4; d[i] = d[i + 1] = d[i + 2] = 255; }
          start = -1;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** 기운 사진 바로 세우기(흰 바탕, 크기 유지) */
function rotateCanvas(src: HTMLCanvasElement, radians: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(radians);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

function wipe(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 0;
  canvas.height = 0;
}

type Progress = (stage: string, ratio: number) => void;

/** 디버그용: 중간 결과까지 돌려준다(검증 스크립트 전용). 앱 화면은 readInbodyPhoto만 쓴다. */
export async function readInbodyPhotoDetailed(file: Blob, onProgress?: Progress, debug?: { crops: Record<string, string> }) {
  const { createWorker, PSM } = await import('tesseract.js');
  let canvas: HTMLCanvasElement | null = null;
  const worker = await createWorker(['kor', 'eng'], 1, {
    workerPath: '/ocr/worker.min.js',
    corePath: '/ocr/core',
    langPath: '/ocr/lang',
    gzip: true,
    cacheMethod: 'none',
    workerBlobURL: false,
    logger: (m: { status: string; progress: number }) => onProgress?.(m.status, m.progress),
  });
  try {
    const prepared = await toCanvas(file);
    canvas = prepared.canvas;
    const source = prepared.source;
    const W = canvas.width, H = canvas.height;
    // 결과지는 A4(가로 8.27인치)라 사진 가로 픽셀로 해상도를 정한다. 정해 두면 인식기가 콘솔에 '해상도 추정' 오류를 남기지 않는다.
    // 인식기 내부 진단 문구(debug_file)도 콘솔로 내보내지 않는다.
    const dpi = Math.max(70, Math.round(Math.min(W, H) / 8.27));
    await worker.setParameters({ user_defined_dpi: String(dpi), debug_file: '/dev/null' });
    // 기울기만 먼저 잰다(글자 인식 없이 줄만 찾음). 기울었으면 캔버스를 바로 세운 뒤 읽는다.
    const skew = (await worker.recognize(canvas, { rotateAuto: true }, { text: false, blocks: false, hocr: false, tsv: false })).data.rotateRadians ?? 0;
    if (Math.abs(skew) >= 0.003) {
      const straight = rotateCanvas(canvas, SKEW_SIGN * skew);
      wipe(canvas);
      canvas = straight;
    }
    onProgress?.('항목 찾는 중', 0);
    const first = await worker.recognize(canvas, {}, { blocks: true, text: false });
    const lines: OcrLine[] = [];
    for (const b of first.data.blocks ?? [])
      for (const p of b.paragraphs)
        for (const l of p.lines)
          lines.push({ text: l.text, bbox: l.bbox, words: l.words.map((w) => ({ text: w.text, bbox: w.bbox })) });
    const regions: Region[] = parseInbody.regionsFor(lines, W, H);
    const reads: RegionRead[] = [];
    let mode: string | null = null;
    for (let i = 0; i < regions.length; i++) {
      onProgress?.('숫자 읽는 중', i / regions.length);
      const r = regions[i];
      const want = r.sparse ? PSM.SPARSE_TEXT : PSM.SINGLE_BLOCK;
      if (want !== mode) {
        await worker.setParameters({ tessedit_char_whitelist: '0123456789.~()-:', tessedit_pageseg_mode: want, user_defined_dpi: String(Math.round(dpi * CROP_SCALE)) });
        mode = want;
      }
      const crop = cropFor(canvas, r.rect, !!r.sparse);
      if (debug) debug.crops[r.key] = crop.toDataURL('image/png');
      const res = await worker.recognize(crop, {}, { text: true, blocks: true }).finally(() => wipe(crop));
      reads.push({ key: r.key, text: res.data.text, words: (res.data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words.map((w) => ({ text: w.text, bbox: w.bbox }))))) });
    }
    return { values: parseInbody.values(lines, reads), lines, reads, regions, size: [W, H], skew, source };
  } finally {
    await worker.terminate();
    wipe(canvas);
  }
}

/** 네 값과, 앱이 받은 사진 크기(가로·세로 픽셀) */
export async function readInbodyPhoto(file: Blob, onProgress?: Progress) {
  const r = await readInbodyPhotoDetailed(file, onProgress);
  return { ...r.values, image: r.source };
}
