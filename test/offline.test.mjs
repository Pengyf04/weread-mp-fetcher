#!/usr/bin/env node
// 离线自测:不连 Chrome、不碰微信读书,只验纯逻辑。
//   node test/offline.test.mjs
//
// 覆盖的是最容易悄悄坏掉、又最难在真实环境里复现的几处判据。

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { PROBE_JS, buildFetchJs, LIST_SHELF_JS } from '../lib/scripts.mjs';
import { extractBiz, bizToBookId, resolveBookId } from '../lib/mp.mjs';
import * as quota from '../lib/quota.mjs';
import { has, val, valOpt } from '../lib/args.mjs';
import { fmtTime, fmtStamp, toMarkdown } from '../lib/render.mjs';
import { normalizeOut, writeText } from '../lib/save.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const ok = (msg) => {
  passed++;
  console.log('  ✓', msg);
};

/** 找一个**确实没人在听**的本机端口。9399 空闲是环境假设,不是常量,所以每次实测。 */
function pickDeadPort(candidates = [9399, 9398, 9397, 9396]) {
  for (const port of candidates) {
    const busy = (() => {
      try {
        // 同步探测:开子进程跑一次 net.connect,拒绝连接 = 端口没人听
        execFileSync(
          process.execPath,
          [
            '-e',
            `const net=require('net');const s=net.connect(${port},'127.0.0.1');` +
              `s.setTimeout(800);` +
              `s.on('connect',()=>{s.destroy();process.exit(0)});` +
              `s.on('error',()=>process.exit(1));` +
              `s.on('timeout',()=>{s.destroy();process.exit(0)});`,
          ],
          { stdio: 'ignore' }
        );
        return true; // exit 0 = 连上了 = 被占用
      } catch {
        return false; // 非 0 = 连不上 = 空闲
      }
    })();
    if (!busy) return port;
  }
  throw new Error(`候选端口全部被占用:${candidates.join('/')} —— 换一批再跑`);
}

// ---------- 探针判据 ----------
// 用最小的 DOM 替身在 vm 里跑 PROBE_JS,不需要浏览器。

function fakeNode({ visible = true, hiddenParent = false } = {}) {
  const self = {
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    getBoundingClientRect: () => ({ width: visible ? 360 : 0, height: visible ? 360 : 0 }),
    parentElement: null,
  };
  if (!visible) self.style.display = 'none';
  if (hiddenParent) {
    // 关键场景:节点自己看着可见,是**祖先**把它藏起来了
    self.parentElement = {
      style: { display: 'block', visibility: 'visible', opacity: '0' },
      parentElement: null,
    };
  }
  return self;
}

function probe({ title, pathname, text = '', nodes = [], tcaptchaLoaded = false }) {
  const sandbox = {
    document: {
      title,
      body: { innerText: text },
      querySelectorAll: () => nodes,
    },
    location: { pathname },
    getComputedStyle: (n) => n.style,
    window: { TencentCaptcha: tcaptchaLoaded ? function () {} : undefined },
    JSON,
  };
  sandbox.getComputedStyle = (n) => n.style;
  return JSON.parse(vm.runInNewContext(PROBE_JS, sandbox));
}

console.log('探针判据');

assert.equal(
  probe({ title: '某某 - 公众号 - 微信读书', pathname: '/web/mp/reader/x', text: '正文'.repeat(30) }).verdict,
  'ready'
);
ok('渲染好的阅读器页 → ready');

assert.equal(
  probe({ title: '微信读书', pathname: '/web/mp/reader/x', nodes: [fakeNode({ visible: true })] }).verdict,
  'captcha'
);
ok('有可见验证码节点 → captcha');

// 这条最容易漏:验证码过关后 TCaptcha 不删 DOM,只把父容器 opacity 置 0。
// 只判存在性的话,过完验证码就再也抓不了了。
assert.equal(
  probe({
    title: '某某 - 公众号 - 微信读书',
    pathname: '/web/mp/reader/x',
    text: '正文'.repeat(30),
    nodes: [fakeNode({ visible: true, hiddenParent: true })],
  }).verdict,
  'ready'
);
ok('验证码残留但已被祖先隐藏 → 仍是 ready(不是 captcha)');

assert.equal(
  probe({ title: '微信读书', pathname: '/web/mp/reader/x', text: '', tcaptchaLoaded: true }).verdict,
  'loading'
);
ok('TCaptcha 已加载但还没弹 → loading(不是 blank)');

assert.equal(probe({ title: '微信读书', pathname: '/', text: '正文'.repeat(30) }).verdict, 'wrong_page');
ok('不在阅读器路径 → wrong_page');

// 健康页面的正文也只有十几个字(纯导航栏),所以判据必须看 title 而不是长度
assert.equal(
  probe({ title: '某某 - 公众号 - 微信读书', pathname: '/web/mp/reader/x', text: '微信读书书城 某某 首页 我的书架' }).verdict,
  'ready'
);
ok('正文很短但 title 正常 → ready(不能拿正文长度当判据)');

// ---------- 抓取脚本 ----------
console.log('抓取脚本');

const js = buildFetchJs([{ name: '甲', bookId: 'MP_WXS_1111111111' }], 1234);
assert.ok(js.includes('MP_WXS_1111111111'), '公众号应被烘焙进脚本');
assert.ok(js.includes('1234'), '间隔应被烘焙进脚本');
ok('配置(公众号列表、请求间隔)正确注入');
// 注:「有没有只取 subReviews[0]」不能靠搜字符串判断——注释里就写着这几个字。
//    只有下面那个跑一遍的行为测试才算数。

// 用假 fetch 跑一遍,确认一次群发里的多篇文章都被展开
const groups = {
  reviews: [
    {
      createTime: 100,
      subReviews: [
        { review: { createTime: 100, reviewId: 'r1', mpInfo: { title: '第一篇', originalId: 'AAA' } } },
        { review: { createTime: 100, reviewId: 'r2', mpInfo: { title: '第二篇', originalId: 'BBB' } } },
      ],
    },
  ],
};
const out = JSON.parse(
  await vm.runInNewContext(js, {
    location: { pathname: '/web/mp/reader/x' },
    fetch: () => Promise.resolve({ json: () => Promise.resolve(groups) }),
    setTimeout: (fn) => fn(),
    Promise,
    JSON,
  })
);
assert.equal(out.sources[0].items.length, 2, '同一次群发的两篇都要取到');
assert.equal(out.sources[0].items[0].url, 'https://mp.weixin.qq.com/s/AAA');
ok('一次群发含多篇时全部展开,原文链接拼接正确');

// ---------- bookId 推导 ----------
console.log('bookId 推导');

assert.equal(bizToBookId('MTIzNDU2Nzg5MA=='), 'MP_WXS_1234567890');
ok('__biz base64 解码后拼成 bookId');

assert.equal(bizToBookId('bm90LWEtbnVtYmVy'), null, '解出来不是纯数字应判无效');
ok('无效 __biz 被拒');

assert.equal(extractBiz('https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=1'), 'MTIzNDU2Nzg5MA==');
ok('URL 里的 __biz 能取出(含 URL 编码)');

assert.equal(extractBiz('var biz = "MTIzNDU2Nzg5MA==";'), 'MTIzNDU2Nzg5MA==');
ok('文章 HTML 里的 var biz 能取出');

assert.equal((await resolveBookId('MP_WXS_1234567890')).bookId, 'MP_WXS_1234567890');
ok('直接给 bookId 时原样返回(不联网)');

await assert.rejects(() => resolveBookId('这不是链接也不是bookId'), /认不出来/);
ok('垃圾输入被拒');

// ---------- 书架脚本 ----------
console.log('书架脚本');
assert.ok(LIST_SHELF_JS.includes('deepLink'), '必须从 deepLink 推导 readerUrl');
assert.ok(LIST_SHELF_JS.includes('/web/mp/reader/'), 'readerUrl 前缀不能少');
ok('书架脚本会推导出 readerUrl(用户不必手动复制)');

// ---------- 额度闸门 ----------
console.log('额度闸门');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmf-'));
const st = path.join(tmp, 'quota.json');

assert.equal(quota.check(st, 2).ok, true);
quota.commit(st);
assert.equal(quota.check(st, 2).ok, true);
quota.commit(st);
assert.equal(quota.check(st, 2).ok, false, '达到上限应拒绝');
ok('达到每日上限后拒绝');

assert.equal(quota.check(st, 0).ok, true, 'maxPerDay=0 表示不限制');
ok('上限设 0 = 不限制');

// 跨天必须归零:直接把日期改成昨天
const raw = JSON.parse(fs.readFileSync(st, 'utf8'));
raw.date = '2000-01-01';
fs.writeFileSync(st, JSON.stringify(raw));
assert.equal(quota.check(st, 2).count, 0, '跨天应归零');
ok('跨天自动归零');

fs.rmSync(tmp, { recursive: true, force: true });

// ---------- 参数解析 ----------
console.log('参数解析');

assert.equal(has(['--probe', '--format'], '--probe'), true);
assert.equal(has(['--format'], '--probe'), false);
assert.equal(val(['--format', 'md'], '--format', 'json'), 'md');
assert.equal(val(['--format'], '--format', 'json'), 'json', '没给值时应回退到默认');
ok('has / val 基本行为');

// U2.1 的直接靶子:--out 的值可以省略,不能把后面那个 flag 吃成路径
assert.equal(valOpt(['--out', '--format', 'md'], '--out', '<默认>'), '<默认>', 'flag 后面跟 flag → 默认标记');
assert.equal(valOpt(['--out'], '--out', '<默认>'), '<默认>', '结尾的裸 flag → 默认标记');
assert.equal(valOpt(['--out', 'a.md'], '--out', '<默认>'), 'a.md');
assert.equal(valOpt(['--format', 'md'], '--out', '<默认>'), undefined, 'flag 不存在 → undefined');
ok('valOpt 三态:不存在 / 存在但没给值 / 给了值');

// 对照:现有 val() 确实会把下一个 flag 当值(所以 --out 不能用它)
assert.equal(val(['--out', '--format', 'md'], '--out', '<默认>'), '--format');
ok('val() 会吞掉后续 flag —— 这正是 valOpt 存在的理由');

// ---------- 日期:唯一来源 ----------
console.log('日期格式化');

// fmtStamp 与 fmtTime 必须可互推,否则说明有人又写了第二份日期实现
for (const t of [
  1785636055,
  Math.floor(new Date(2026, 0, 1, 0, 30).getTime() / 1000), // 跨零点边界
  Math.floor(new Date(2026, 0, 1, 23, 30).getTime() / 1000),
  Math.floor(new Date(2025, 11, 31, 23, 59).getTime() / 1000),
]) {
  assert.equal(fmtStamp(t).slice(0, 8), fmtTime(t).slice(0, 10).replace(/-/g, ''), `t=${t}`);
}
assert.match(fmtStamp(new Date(2026, 7, 11, 15, 30)), /^20260811-1530$/);
assert.match(fmtTime(Math.floor(new Date(2026, 7, 11, 15, 30).getTime() / 1000)), /^2026-08-11 15:30$/);
ok('fmtStamp/fmtTime 同源(含跨零点边界),格式各自正确');

// ---------- CLI 入口守卫 ----------
// 目标:被 import 时**不能**跑 main();直接/经符号链接调用时**必须**跑。
// 全程零网络:临时 config 指向一个确实没人在听的端口,即使守卫失效也发不出任何请求。
console.log('CLI 入口守卫');

const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmf-guard-'));
const deadPort = pickDeadPort();
const guardCfg = path.join(guardDir, 'x.json');
const guardState = path.join(guardDir, 'quota.json');
fs.writeFileSync(
  guardCfg,
  JSON.stringify({ accounts: [], chromePort: deadPort, statePath: guardState })
);

function run(args, opts = {}) {
  const r = execFileSync(process.execPath, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  return r;
}
function runCapture(args) {
  try {
    return { code: 0, stdout: run(args), stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// 负向:import 不许有任何副作用
const probeImport = path.join(guardDir, 'probe-import.mjs');
fs.writeFileSync(probeImport, `await import(${JSON.stringify(path.join(ROOT, 'bin/weread.mjs'))});\n`);
const imported = runCapture([probeImport, '--config', guardCfg]);
assert.equal(imported.code, 0, 'import 不应退出非 0');
assert.equal(imported.stdout, '', `import 时 stdout 必须为空,实际:${imported.stdout}`);
assert.equal(imported.stderr, '', `import 时 stderr 必须为空,实际:${imported.stderr}`);
ok(`被 import 时不执行 main()(stdout/stderr 均空,端口 ${deadPort} 实测无人监听)`);

// 正向:CLI 入口没有被守卫关死。--quota 在 connectChrome 之前,零网络零额度。
const quotaLine = /^今日\(\d{4}-\d{2}-\d{2}\)已抓 0\/2 次\n$/;
const direct = runCapture([path.join(ROOT, 'bin/weread.mjs'), '--config', guardCfg, '--quota']);
assert.equal(direct.code, 0);
assert.match(direct.stdout, quotaLine, `stdout 必须恰好是那一行,实际:${JSON.stringify(direct.stdout)}`);
assert.equal(fs.existsSync(guardState), false, '--quota 只读,不该建账本文件');
ok('直接调用 → stdout 恰好一行、退出 0、不创建账本');

// 符号链接回归:npm i -g / npm link 就是这么调的
const linkPath = path.join(guardDir, 'weread-link');
fs.symlinkSync(path.join(ROOT, 'bin/weread.mjs'), linkPath);
const viaLink = runCapture([linkPath, '--config', guardCfg, '--quota']);
assert.equal(viaLink.code, 0);
assert.match(viaLink.stdout, quotaLine, `经符号链接调用时 stdout 必须相同,实际:${JSON.stringify(viaLink.stdout)}`);
assert.equal(fs.existsSync(guardState), false);
ok('经符号链接调用 → 与直接调用完全相同(旧的 pathToFileURL 写法在这里会静默什么都不做)');

fs.rmSync(guardDir, { recursive: true, force: true });

// ---------- 导出到文件(--out) ----------
console.log('导出到文件');

// 注意顺序:失败的号放前面。err / 没取到文章这两个分支自带尾换行,
// 放最后会让 toMarkdown 的返回值恰好以 '\n' 结尾,"补不补尾换行"这条就测不出来了。
const FAKE_SOURCES = [
  { name: '乙号', bookId: 'MP_WXS_0000000002', err: 'errCode=-2041' },
  {
    name: '甲号',
    bookId: 'MP_WXS_0000000001',
    items: [
      { t: 1785636055, title: '标题里有 | 竖线', url: 'https://mp.weixin.qq.com/s/AAA1', rid: 'r1' },
      { t: 1785549655, title: '另一篇', url: 'https://mp.weixin.qq.com/s/AAA2', rid: 'r2' },
    ],
  },
];
const outTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmf-out-'));
const mdText = toMarkdown(FAKE_SOURCES);

// 顺带验证会自动建目录
const f1 = path.join(outTmp, 'sub', 'a.md');
const st1 = writeText(f1, mdText);
const back1 = fs.readFileSync(f1, 'utf8');
assert.equal(back1, normalizeOut(mdText), '文件内容必须是 normalizeOut(text),不是 text');
assert.notEqual(back1, mdText, 'toMarkdown 不带尾换行,所以这里必须补了一个');
ok('写出的文件 === normalizeOut(渲染结果)(目录会自动创建)');

assert.equal(st1.lines, (back1.match(/\n/g) || []).length, "自报行数必须 ≡ '\\n' 个数(= wc -l)");
assert.equal(st1.bytes, fs.statSync(f1).size, '自报字节数必须 === 文件实际大小');
ok('自报的 字节/行数 与文件实际一致(V2.2 的 J1/J2 就靠它)');

assert.notEqual(fs.readFileSync(f1).slice(0, 3).toString('hex'), 'efbbbf');
ok('无 BOM');

// 幂等:text 本身已以 \n 结尾时不能补成两个
const f2 = path.join(outTmp, 'b.md');
writeText(f2, mdText + '\n');
assert.equal(fs.readFileSync(f2, 'utf8'), mdText + '\n', '已有尾换行时不该再补');
ok('尾换行归一化是幂等的');

// 两条输出路径的字节等价:文件大小 === 走 stdout 时写出去的字节数
for (const t of [mdText, mdText + '\n', '']) {
  const f = path.join(outTmp, `eq-${Buffer.byteLength(t)}.md`);
  const st = writeText(f, t);
  assert.equal(st.bytes, Buffer.byteLength(normalizeOut(t), 'utf8'), '两条路径字节数必须相等');
  assert.equal(st.bytes, fs.statSync(f).size);
}
ok('文件字节流 === 不加 --out 时终端收到的字节流(含空串边界)');

// J5 的离线预检:md 数据行数 === items 总数(不加文件头/统计行,所以可以直接比)
const itemsTotal = FAKE_SOURCES.reduce((n, s) => n + (s.items ? s.items.length : 0), 0);
assert.equal((back1.match(/^\| 20\d{2}-/gm) || []).length, itemsTotal);
assert.ok((back1.match(/\n/g) || []).length > itemsTotal, '数据行数必须少于总行数,否则判据退化成"匹配所有行"');
ok('md 数据行数 === 本次篇数(md 不加文件头、不加统计行)');

fs.rmSync(outTmp, { recursive: true, force: true });

// ---------- 翻页回归基线 ----------
console.log('翻页回归基线(golden fixture)');

const PAGES_INPUT = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/pages-input.json'), 'utf8'));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/fetch-pages1.golden.json'), 'utf8'));
const GOLDEN_ACCOUNTS = [
  { name: '甲号', bookId: 'MP_WXS_0000000001' },
  { name: '乙号', bookId: 'MP_WXS_0000000002' },
];

const goldenNow = JSON.parse(
  await vm.runInNewContext(buildFetchJs(GOLDEN_ACCOUNTS, 3000), {
    location: { pathname: '/web/mp/reader/x' },
    fetch: () => Promise.resolve({ json: () => Promise.resolve(PAGES_INPUT) }),
    setTimeout: (fn) => fn(),
    Promise,
    JSON,
  })
);
assert.deepEqual(goldenNow, GOLDEN, 'fixture 与当前实现不一致 —— 要么实现变了,要么 fixture 被改过');
ok('fixture 就是当前实现的产物(P3 换成 Node 侧翻页后用它做回归)');

console.log(`\n全部通过(${passed} 项)`);
