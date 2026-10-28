// 인바디 결과지 글자 인식(Tesseract.js)에 필요한 파일을 public/ocr/에 복사한다(dev·build 전에 자동 실행).
// 인식은 휴대폰 안에서만 일어난다. 이 파일들을 우리 주소에서 받게 해 외부 CDN에 아무 요청도 하지 않게 한다.
// public/ocr/는 git에 넣지 않는다(node_modules에서 매번 만든다). 서비스워커 미리 저장 대상도 아니다(vite.config.ts globIgnores).
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const out = 'public/ocr';
const files = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ...['lstm', 'simd-lstm', 'relaxedsimd-lstm'].map((k) => [`node_modules/tesseract.js-core/tesseract-core-${k}.wasm.js`, `core/tesseract-core-${k}.wasm.js`]),
  ['node_modules/@tesseract.js-data/kor/4.0.0_best_int/kor.traineddata.gz', 'lang/kor.traineddata.gz'],
  ['node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'lang/eng.traineddata.gz'],
];
for (const [from, to] of files) {
  const dest = join(out, to);
  if (existsSync(dest) && statSync(dest).size === statSync(from).size) continue;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(from, dest);
}
