// 와이어프레임(app.js 131~137행)의 사진 축소를 Blob 업로드용으로 옮긴 것: 긴 변 800px, JPEG 품질 0.68
// 2026-11-03 안드로이드 제보('사진 추가가 안 돼요')를 살피며 보강: 고해상도 휴대폰 사진(108MP 등은 15MB를 넘음)도 받고,
// <img>로 열지 못한 사진은 createImageBitmap으로 한 번 더 열어 본다. HEIC(아이폰 기본·갤럭시 '고효율 사진')는 안드로이드 크롬이 열지 못해 할 일을 안내한다
export class PhotoError extends Error {}

const MAX_BYTES = 40 * 1024 * 1024;
const LONG_SIDE = 800;
const isHeic = (file: File) => /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);

/** <img>로 연다(브라우저가 사진의 회전 정보를 반영). 못 열면 null */
async function viaImage(url: string): Promise<{ draw: CanvasImageSource; w: number; h: number } | null> {
  const img = new Image();
  const ok = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
  return ok && img.naturalWidth ? { draw: img, w: img.naturalWidth, h: img.naturalHeight } : null;
}

/** createImageBitmap으로 연다(일부 안드로이드에서 <img>가 못 여는 사진). 못 열면 null */
async function viaBitmap(file: File): Promise<{ draw: CanvasImageSource; w: number; h: number } | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { draw: bmp, w: bmp.width, h: bmp.height };
  } catch {
    return null;
  }
}

export async function compressPhoto(file: File): Promise<Blob> {
  if (file.type && !file.type.startsWith('image/')) throw new PhotoError('사진 파일을 선택해 주세요.');
  if (file.size > MAX_BYTES) throw new PhotoError('40MB 이하 사진을 선택해 주세요.');
  const url = URL.createObjectURL(file);
  try {
    const src = (await viaImage(url)) ?? (await viaBitmap(file));
    if (!src)
      throw new PhotoError(
        isHeic(file)
          ? 'HEIC 형식 사진은 이 휴대폰 브라우저에서 열 수 없어요. 카메라 설정의 고효율 사진(HEIF)을 끄고 찍거나, JPG 사진을 골라 주세요.'
          : '이 사진 형식을 열 수 없어요. JPG 또는 PNG 사진을 선택해 주세요.',
      );
    const ratio = Math.min(1, LONG_SIDE / Math.max(src.w, src.h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(src.w * ratio));
    canvas.height = Math.max(1, Math.round(src.h * ratio));
    canvas.getContext('2d')!.drawImage(src.draw, 0, 0, canvas.width, canvas.height);
    if ('close' in src.draw && typeof src.draw.close === 'function') src.draw.close();
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new PhotoError('사진을 변환하지 못했어요. 다른 사진을 선택해 주세요.'))),
        'image/jpeg',
        0.68,
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
