// The five privacy pages say the camera runs only when scanning and describe the phone's temporary computer-connection server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pages = { en: ['privacy.html', /camera access[\s\S]*only while the scanner is open/, /10 minutes[\s\S]*random port[\s\S]*6-digit[\s\S]*tallymy\.github\.io[\s\S]*fir1412\.github\.io[\s\S]*5 wrong codes/, '5 October 2026'],
  ms: ['privacy.ms.html', /akses kamera[\s\S]*hanya semasa pengimbas dibuka/, /10 minit[\s\S]*port rawak[\s\S]*6 digit[\s\S]*tallymy\.github\.io[\s\S]*fir1412\.github\.io[\s\S]*5 kod salah/, '5 Oktober 2026'],
  zh: ['privacy.zh.html', /相机权限[\s\S]*只在扫描器打开时使用/, /10 分钟[\s\S]*随机端口[\s\S]*6 位数[\s\S]*tallymy\.github\.io[\s\S]*fir1412\.github\.io[\s\S]*5 次/, '2026 年 10 月 5 日'],
  'zh-Hant': ['privacy.zh-Hant.html', /相機權限[\s\S]*只在掃描器開啟時使用/, /10 分鐘[\s\S]*隨機連接埠[\s\S]*6 位數[\s\S]*tallymy\.github\.io[\s\S]*fir1412\.github\.io[\s\S]*5 次/, '2026 年 10 月 5 日'],
  ja: ['privacy.ja.html', /カメラの使用許可[\s\S]*スキャナーを開いている間だけ/, /10 分[\s\S]*ランダムなポート[\s\S]*6 桁[\s\S]*tallymy\.github\.io[\s\S]*fir1412\.github\.io[\s\S]*5 回/, '2026 年 10 月 5 日']};
for (const [l, [f, cam, srv, date]] of Object.entries(pages)) test(`${l}: camera, computer-connection server and date`, () => {
  const s = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  assert.match(s, cam); assert.match(s, srv); assert.ok(s.includes(date)); assert.ok(!/privacy\.ta/.test(s));
});
test('no Tamil privacy page is claimed', () => assert.ok(!readFileSync(new URL('../js/views/setup.js', import.meta.url), 'utf8').includes('privacy.ta')));
