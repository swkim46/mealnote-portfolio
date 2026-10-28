// 인식 검증용 가짜 인바디 결과지(InBody270 배치를 흉내 냄). 숫자·회원번호는 모두 지어낸 값이라 저장소에 둬도 된다.
// photo: true면 휴대폰으로 찍은 것처럼 기울이고 그림자·흐림을 넣는다.
export function sheetHtml(v, { photo = false } = {}) {
  const scale = (xs) => `<div class="scale">${xs.map((x) => `<span>${x}</span>`).join('')}<span>%</span></div>`;
  const hist = (xs) => `<div class="hist">${xs.map((x, i) => `<span style="margin-top:${(i % 3) * 8}px">${x}</span>`).join('')}</div>`;
  const comp = (desc, label, unit, val, range) => `<tr><td class="desc">${desc}</td><td class="lab">${label}</td><td class="unit">(${unit})</td><td class="num">${val} ( ${range} )</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:${photo ? '#8a8578' : '#fff'};font-family:"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
  .page{width:1600px;height:2260px;background:#fff;position:relative;padding:30px 40px;box-sizing:border-box;color:#111;
    ${photo ? 'transform:rotate(-1.8deg) scale(.94);transform-origin:center;filter:blur(.7px) contrast(.9);box-shadow:0 0 40px #0006' : ''}}
  .shade{position:absolute;inset:0;background:linear-gradient(110deg,#0000 40%,#0002 75%,#0004);pointer-events:none}
  h1{color:#b3261e;font-size:96px;margin:0;font-family:Arial}
  .model{position:absolute;left:830px;top:95px;font-size:26px}
  .head{display:flex;gap:0;border-top:6px solid #b3261e;margin-top:20px;width:950px}
  .head div{border-left:2px solid #333;padding:8px 14px;font-size:28px;min-width:120px}.head small{display:block;color:#777;font-size:27px}
  h2{font-size:34px;color:#555;margin:60px 0 10px}h2 small{font-size:18px;font-family:serif;color:#777}
  table{border-collapse:collapse;width:950px}td{padding:12px 8px;font-size:26px;border-bottom:3px solid #fff;background:#dfe3ea}
  td.num{background:#fff;text-align:right;font-size:28px}.lab{font-weight:700;font-size:30px;color:#444}.desc{color:#555}
  .row{display:flex;align-items:flex-start;width:950px;background:#e3e6ec;border-bottom:3px solid #fff;height:68px}
  .row .name{width:140px;padding:6px 10px;font-size:30px;font-weight:700;color:#444;line-height:1}.row .name small{display:block;font-size:16px;font-weight:400;font-family:serif;margin-top:6px}
  .row .u{width:55px;font-size:22px;padding-top:14px}.row .g{background:#fff;flex:1;height:100%;position:relative}
  .scale{display:flex;gap:0;font-size:17px;padding-left:20px}.scale span{width:66px}
  .bar{position:absolute;left:4px;top:34px;right:0;height:16px}.fill{height:16px;background:linear-gradient(90deg,#000 60%,#888 60%)}
  .val{position:absolute;top:-4px;font-size:28px;margin-left:12px}.bar .val{left:var(--l)}
  .right{position:absolute;left:1040px;top:290px;width:480px;font-size:28px;line-height:1.6}
  .hist{display:flex;gap:30px;font-size:27px;padding:4px 20px}.hist span{width:70px}
  .dates{display:flex;gap:30px;font-size:16px;padding-left:215px}.dates span{width:70px}
  </style></head><body><div class="page">
  <h1>InBody</h1><div class="model">[InBody270]</div>
  <div class="head"><div><small>회원번호</small>01000000000</div><div><small>신장</small>170cm</div><div><small>나이</small>40</div><div><small>성별</small>여성</div><div><small>검사일시</small>${v.dateText}</div></div>
  <h2>체성분분석 <small>Body Composition Analysis</small></h2>
  <table>
  ${comp('우리 몸을 이루고 있는 물', '체수분', 'L', v.water, '30.1~40.2')}
  ${comp('근육을 만들어 주는', '단백질', 'kg', v.protein, '8.1~11.4')}
  ${comp('뼈를 단단하게 해주는', '무기질', 'kg', v.mineral, '2.81~3.95')}
  ${comp('남은 에너지를 저장해 놓은', '체지방량', 'kg', v.fat, '10.2~19.9')}
  ${comp('체수분, 단백질, 무기질, 체지방을 모두 합하면', '체중', 'kg', v.weight, '50.1~68.4')}
  </table>
  <h2>골격근·지방분석 <small>Muscle-Fat Analysis</small></h2>
  <div class="row"><div class="name">체중<small>Weight</small></div><div class="u">(kg)</div><div class="g">${scale([55, 70, 85, 100, 115, 130, 145, 160, 175, 190, 205])}<div class="bar" style="--l:430px"><div class="fill" style="width:420px"></div><span class="val" style="left:430px">${v.weight}</span></div></div></div>
  <div class="row"><div class="name">골격근량<small>Skeletal Muscle Mass</small></div><div class="u">(kg)</div><div class="g">${scale([70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170])}<div class="bar"><div class="fill" style="width:380px"></div><span class="val" style="left:390px">${v.smm}</span></div></div></div>
  <div class="row"><div class="name">체지방량<small>Body Fat Mass</small></div><div class="u">(kg)</div><div class="g">${scale([40, 60, 80, 100, 160, 220, 280, 340, 400, 460, 520])}<div class="bar"><div class="fill" style="width:470px"></div><span class="val" style="left:480px">${v.fat}</span></div></div></div>
  <h2>비만분석 <small>Obesity Analysis</small></h2>
  <div class="row"><div class="name">BMI<small>Body Mass Index</small></div><div class="u">(kg/m²)</div><div class="g">${scale(['10.0', '15.0', '18.5', '22.0', '25.0', '30.0', '35.0', '40.0', '45.0', '50.0', '55.0'])}<div class="bar"><div class="fill" style="width:400px"></div><span class="val" style="left:410px">${v.bmi}</span></div></div></div>
  <div class="row"><div class="name">체지방률<small>Percent Body Fat</small></div><div class="u">(%)</div><div class="g">${scale(['0.0', '5.0', '10.0', '15.0', '20.0', '25.0', '30.0', '35.0', '40.0', '45.0', '50.0'])}<div class="bar"><div class="fill" style="width:500px"></div><span class="val" style="left:510px">${v.pbf}</span></div></div></div>
  <div class="right">인바디점수 <b>${v.score}</b>/100점<br>적정체중 ${v.ideal} kg<br>체중조절 - 3.1 kg<br>지방조절 - 4.2 kg<br>근육조절 + 1.1 kg<br>제지방량 ${(v.weight - v.fat).toFixed(1)} kg ( 45.0~55.0 )<br>기초대사량 1320 kcal ( 1250~1450 )</div>
  <h2 style="margin-top:420px">신체변화 <small>Body Composition History</small></h2>
  <div class="row" style="height:80px"><div class="name">체중<small>Weight</small></div><div class="u">(kg)</div><div class="g">${hist(v.histW)}</div></div>
  <div class="row" style="height:80px"><div class="name">골격근량<small>Skeletal Muscle Mass</small></div><div class="u">(kg)</div><div class="g">${hist(v.histS)}</div></div>
  <div class="row" style="height:80px"><div class="name">체지방률<small>Percent Body Fat</small></div><div class="u">(%)</div><div class="g">${hist(v.histP)}</div></div>
  <div class="dates">${v.histD.map((d) => `<span>${d}</span>`).join('')}</div>
  ${photo ? '<div class="shade"></div>' : ''}
  </div></body></html>`;
}

/** 검증에 쓰는 지어낸 값(합계·비율이 실제 결과지처럼 맞게) */
export const SAMPLE = {
  dateText: '2026.09.15. 08:42', water: '41.0', protein: '11.2', mineral: '3.81', fat: '17.3', weight: '73.3', smm: '32.4', pbf: '23.6', bmi: '24.1', score: 74, ideal: '68.4',
  histW: ['75.2', '74.6', '74.0', '73.3'], histS: ['31.8', '32.0', '32.1', '32.4'], histP: ['25.9', '25.0', '24.4', '23.6'], histD: ['26.03.02.', '26.05.11.', '26.07.20.', '26.09.15.'],
  expect: { measured_on: '2026-09-15', weight_kg: 73.3, smm_kg: 32.4, pbf_pct: 23.6 },
};
