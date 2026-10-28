// 와이어프레임(app.js 131~137행)의 사진 축소를 Blob 업로드용으로 옮긴 것: 긴 변 800px, JPEG 품질 0.68
export class PhotoError extends Error {}

export async function compressPhoto(file: File): Promise<Blob> {
  if (file.type && !file.type.startsWith('image/')) throw new PhotoError('사진 파일을 선택해 주세요.');
  if (file.size > 15 * 1024 * 1024) throw new PhotoError('15MB 이하 사진을 선택해 주세요.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new PhotoError('이 사진 형식을 열 수 없어요. JPG 또는 PNG 사진을 선택해 주세요.'));
      img.src = url;
    });
    const ratio = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * ratio);
    canvas.height = Math.round(img.naturalHeight * ratio);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
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
