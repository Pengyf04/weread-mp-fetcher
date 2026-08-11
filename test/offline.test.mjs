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
import { PROBE_JS, buildPageJs, LIST_SHELF_JS } from '../lib/scripts.mjs';
import { extractBiz, bizToBookId, resolveBookId } from '../lib/mp.mjs';
import * as quota from '../lib/quota.mjs';
import { has, val, valOpt } from '../lib/args.mjs';
import { fmtTime, fmtStamp, toMarkdown } from '../lib/render.mjs';
import { normalizeOut, writeText } from '../lib/save.mjs';
import { fetchAll, diagnose2041, format2041Note } from '../lib/fetchflow.mjs';
import { connectChrome, CONNECT_HELP } from '../lib/cdp.mjs';
// 直接 import bin 是安全的:入口守卫保证被 import 时不跑 main()(下面「CLI 入口守卫」一节验的就是它)
import { getReaderTab, commitRun } from '../bin/weread.mjs';

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

// ---------- 抓取脚本(一次调用 = 一页) ----------
console.log('抓取脚本');

// 在 vm 里真跑一遍,记录**真实请求的 URL** 与返回值。
// 注:「有没有只取 subReviews[0]」「有没有混进 count=」都不能靠搜源码字符串判断
//    ——注释和字面量里本来就有这些字。只有跑一遍的行为测试才算数。
async function runPageJs(bookId, offset, resp, { reject = false } = {}) {
  let requested = null;
  const s = await vm.runInNewContext(buildPageJs(bookId, offset), {
    location: { pathname: '/web/mp/reader/x' },
    fetch: (u) => {
      requested = u;
      return reject ? Promise.reject(new Error('boom')) : Promise.resolve({ json: () => Promise.resolve(resp) });
    },
    Promise,
    JSON,
    String,
  });
  return { requested, out: JSON.parse(s) };
}

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

const p1 = await runPageJs('MP_WXS_1111111111', 40, groups);
assert.equal(p1.requested, '/web/mp/articles?bookId=MP_WXS_1111111111&offset=40', '请求的 URL 必须逐字如此');
assert.ok(!p1.requested.includes('count='), 'count 被服务端忽略,不许发');
assert.ok(!p1.requested.includes('maxIdx='), 'maxIdx 被服务端忽略,不许发');
ok('实际请求的 URL 只带 bookId 与 offset(不含 count / maxIdx)');

assert.equal(p1.out.ok, true);
assert.equal(p1.out.reviews, 1, 'reviews 报的是**群发条数**,翻页靠它累加 offset');
assert.equal(p1.out.items.length, 2, '同一次群发的两篇都要取到');
assert.equal(p1.out.items[0].url, 'https://mp.weixin.qq.com/s/AAA');
assert.equal(p1.out.onReader, true);
ok('一次群发含多篇时全部展开,原文链接拼接正确');

const p2 = await runPageJs('B', 0, { errCode: -2041 });
assert.deepEqual(p2.out, { ok: false, errCode: -2041 }, '错误码要原样带回来给 Node 侧');
const p3 = await runPageJs('B', 0, null, { reject: true });
assert.equal(p3.out.ok, false);
assert.ok(String(p3.out.err).includes('boom'));
ok('页内失败的两条路径(errCode / 抛异常)都 resolve 成字符串,不会让 JSON.parse 炸');

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

// ---- 第二道闸门:请求预算 + 账本明细 ----
const today = new Date();
const p2d = (n) => String(n).padStart(2, '0');
const TODAY = `${today.getFullYear()}-${p2d(today.getMonth() + 1)}-${p2d(today.getDate())}`;

// 老账本(只有 date/count,没有 requests)必须能读,缺的字段按 0 算
const st2 = path.join(tmp, 'old.json');
fs.writeFileSync(st2, JSON.stringify({ date: TODAY, count: 1 }));
assert.equal(quota.check(st2, 2).count, 1, '老账本的 count 要读出来');
assert.deepEqual(quota.status(st2, 2, 40).requests, { articles: 0, shelf: 0, used: 0, max: 40 });
ok('老格式账本能读,缺失的请求明细按 0 算');

// commit 记的是**实际**发生数
quota.commit(st2, { articles: 12, shelf: 1 });
const after = JSON.parse(fs.readFileSync(st2, 'utf8'));
assert.equal(after.count, 2);
assert.deepEqual(after.requests, { articles: 12, shelf: 1 });
assert.deepEqual(Object.keys(after.requests).sort(), ['articles', 'shelf'], '账本明细只有 articles / shelf');
ok('commit 记实际请求数,账本字段是 {articles, shelf}');

// 回滚兼容:新账本被老代码读到时,多出来的字段只是被忽略,count 仍然正确
assert.equal(after.date, TODAY);
assert.equal(typeof after.count, 'number');
ok('新账本对老代码是向后兼容的(多余字段被忽略,date/count 位置不变)');

// 预算闸门:只读不写
const before = fs.readFileSync(st2, 'utf8');
assert.equal(quota.checkRequests(st2, 40, 12).ok, true, '13 + 12 = 25 ≤ 40,放行');
const tight = quota.checkRequests(st2, 20, 12);
assert.equal(tight.ok, false, '13 + 12 = 25 > 20,拒绝');
assert.equal(tight.used, 13);
assert.equal(tight.remaining, 7);
assert.equal(quota.checkRequests(st2, 0, 999).ok, true, 'maxRequestsPerDay=0 表示不限制');
assert.equal(fs.readFileSync(st2, 'utf8'), before, 'checkRequests 必须只读不写');
ok('请求预算闸门:够就放行、不够就拒绝、设 0 不限制,且只读不写');

// 未知键(顶层 + requests 内部)必须原样保留:将来某版写了新字段,回滚到本版再 commit
// 一次不能把它静默抹掉。但**保留不等于计入** —— used 仍然只数 articles + shelf。
const st3 = path.join(tmp, 'unknown.json');
fs.writeFileSync(
  st3,
  JSON.stringify({ date: TODAY, count: 1, note: '顶层未知键', requests: { articles: 3, shelf: 1, mystery: 7 } })
);
assert.equal(quota.checkRequests(st3, 40, 1).used, 4, 'used 只数 articles + shelf,未知键不参与计算');
quota.commit(st3, { articles: 2 });
const kept = JSON.parse(fs.readFileSync(st3, 'utf8'));
assert.equal(kept.note, '顶层未知键', '顶层未知键要留着');
assert.equal(kept.requests.mystery, 7, 'requests 内部的未知键同样要留着');
assert.deepEqual({ a: kept.requests.articles, s: kept.requests.shelf, c: kept.count }, { a: 5, s: 1, c: 2 });
ok('账本里的未知键(顶层与 requests 内部)原样保留,且不被计入 used');

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
const quotaLine = /^今日\(\d{4}-\d{2}-\d{2}\)已抓 0\/2 次;请求 0\/40\(文章 0,书架 0\)\n$/;
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

// ---------- 翻页调度 ----------
console.log('翻页调度(fetchflow)');

const ACC2 = [
  { name: '甲号', bookId: 'B1' },
  { name: '乙号', bookId: 'B2' },
];
const ACC4 = [
  { name: '甲号', bookId: 'B1' },
  { name: '乙号', bookId: 'B2' },
  { name: '丙号', bookId: 'B3' },
  { name: '丁号', bookId: 'B4' },
];
/** 一页成功的返回。reviews = 该页的群发条数,offset 靠它累加 */
const page = (reviews, items = []) => ({ ok: true, onReader: true, reviews, items });
const art = (t, id) => ({ t, title: '文章' + id, url: 'https://mp.weixin.qq.com/s/' + id, rid: 'r' + id });

function mkRun(handler) {
  const calls = [];
  const fn = async (bookId, offset) => {
    calls.push({ bookId, offset });
    return handler(bookId, offset, calls.length - 1);
  };
  fn.calls = calls;
  fn.offsetsOf = (bookId) => calls.filter((c) => c.bookId === bookId).map((c) => c.offset);
  return fn;
}
function mkSleep() {
  const s = async () => {
    s.n++;
  };
  s.n = 0;
  return s;
}
// bin 里的"全失败"判据,逐字照抄过来当断言用
const allFailed = (r) => r.sources.filter((s) => s.err).length === r.sources.length;

// 1. ⚠️ E1 的直接靶子:offset 必须**按号重置**。单号测试对这个 bug 完全免疫,所以必须 ≥2 个号。
{
  const run = mkRun(() => page(20));
  const sleep = mkSleep();
  const r = await fetchAll({ accounts: ACC2, pages: 3, gapMs: 3000, run, sleep });
  assert.deepEqual(run.offsetsOf('B1'), [0, 20, 40], '第 1 个号的 offset 序列');
  assert.deepEqual(run.offsetsOf('B2'), [0, 20, 40], '第 2 个号必须也从 0 开始 —— offset 写在号循环外就会是 60,80,100');
  assert.equal(r.meta.requestsTotal, 6);
  assert.equal(r.meta.pages, 3);
  ok('2 个号 × 3 页:每个号的 offset 都是 0,20,40(offset 按号重置)');

  // 8. GAP 加在每两个请求之间,最后一个请求之后不等
  assert.equal(sleep.n, 5, 'sleep 次数必须是 实际请求数 − 1');
  ok('间隔次数 === 实际请求数 − 1(尾部没有多余等待)');
}

// 3. 某页返回 0 条群发 → 提前停,后续不再请求
{
  const run = mkRun((b, o, i) => (i === 1 ? page(0) : page(20)));
  const r = await fetchAll({ accounts: [ACC2[0]], pages: 3, gapMs: 0, run, sleep: mkSleep() });
  assert.equal(run.calls.length, 2, '第 2 页就没有更多了,不该再打第 3 页');
  assert.equal(r.sources[0].pagesFetched, 2);
  assert.ok(!r.sources[0].err && !r.sources[0].partialErr, '没有更多 ≠ 失败');
  ok('某页 0 条群发 → 提前停止,且不算失败');
}

// 4 + 5 + 13. 去重:跨页同 url 只留一条;同一次群发的同 t 两篇都在;url/rid 皆空的不参与去重
{
  const run = mkRun((b, o, i) =>
    i === 0
      ? page(20, [art(100, 'AAA'), art(100, 'BBB')]) // 同一次群发,t 相同
      : page(20, [art(100, 'AAA'), art(90, 'CCC')]) // AAA 与上一页重复
  );
  const r = await fetchAll({ accounts: [ACC2[0]], pages: 2, gapMs: 0, run, sleep: mkSleep() });
  const urls = r.sources[0].items.map((it) => it.url);
  assert.equal(urls.length, 3, '重复的 AAA 只能出现一次');
  assert.equal(new Set(urls).size, 3);
  assert.equal(r.sources[0].items.filter((it) => it.t === 100).length, 2, '同 t 的两篇都要在(不能按时间戳去重)');
  ok('跨页按 url 去重;同一次群发的同时间戳文章不会被误删');

  const runEmpty = mkRun(() =>
    page(20, [
      { t: 5, title: '甲', url: '', rid: '' },
      { t: 4, title: '乙', url: '', rid: '' },
      { t: 3, title: '丙', url: 'https://mp.weixin.qq.com/s/X', rid: '' },
      { t: 2, title: '丁', url: 'https://mp.weixin.qq.com/s/X', rid: '' },
    ])
  );
  const r2 = await fetchAll({ accounts: [ACC2[0]], pages: 1, gapMs: 0, run: runEmpty, sleep: mkSleep() });
  assert.equal(r2.sources[0].items.length, 3, 'url/rid 皆空的两条都要保留,同 url 的两条合成一条');
  ok('去重键为空时不参与去重(否则会静默丢文章)');
}

// 6. 第 0 页失败 → {name,bookId,err},没有 items
{
  const run = mkRun(() => ({ ok: false, errCode: -2041 }));
  const r = await fetchAll({ accounts: [ACC2[0]], pages: 3, gapMs: 0, run, sleep: mkSleep() });
  assert.deepEqual(Object.keys(r.sources[0]).sort(), ['bookId', 'err', 'name']);
  assert.equal(run.calls.length, 1, '第 0 页就失败了,不该继续翻页');
  assert.equal(allFailed(r), true);
  ok('第 0 页失败 → 形状 {name,bookId,err},且停止该号翻页');
}

// 7. 第 2 页失败 → 保留前 2 页 + partialErr,**不设 err** → 整轮不算全失败
{
  const run = mkRun((b, o, i) => (i === 2 ? { ok: false, errCode: -2041 } : page(20, [art(100 - i, 'X' + i)])));
  const r = await fetchAll({ accounts: [ACC2[0]], pages: 3, gapMs: 0, run, sleep: mkSleep() });
  const s = r.sources[0];
  assert.equal(s.err, undefined, 'err 只表示该号零数据');
  assert.equal(s.partialErr, 'errCode=-2041');
  assert.equal(s.pagesFetched, 2);
  assert.equal(s.items.length, 2, '前 2 页的文章必须保住');
  assert.equal(allFailed(r), false, '已经花掉的请求必须有产出');
  ok('第 2 页失败 → items + partialErr,无 err,不判全失败');
}

// 10. run() 在第 2 页抛错 → 同样归到 partialErr;后续号照常;异常不穿透
{
  const run = mkRun((b, o, i) => {
    if (b === 'B1' && i === 2) throw new Error('target closed');
    return page(20, [art(100, b + i)]);
  });
  const r = await fetchAll({ accounts: ACC2, pages: 3, gapMs: 0, run, sleep: mkSleep() });
  assert.equal(r.sources[0].err, undefined);
  assert.ok(String(r.sources[0].partialErr).includes('evaluate 失败'));
  assert.equal(r.sources[0].items.length, 2);
  assert.ok(run.calls.some((c) => c.bookId === 'B2'), '后面的号仍要继续抓');
  assert.equal(allFailed(r), false);
  ok('run() 抛错(CDP 层)按页号映射进已有形状,不新造结构、不穿透 fetchAll');
}

// 11. run() 在第 0 页抛错 → 归形状 1
{
  const run = mkRun(() => {
    throw new Error('target closed');
  });
  const r = await fetchAll({ accounts: [ACC2[0]], pages: 3, gapMs: 0, run, sleep: mkSleep() });
  assert.deepEqual(Object.keys(r.sources[0]).sort(), ['bookId', 'err', 'name']);
  assert.ok(r.sources[0].err.includes('evaluate 失败'));
  ok('第 0 页 run() 抛错 → 归形状 1(err)');
}

// 12. 熔断器:连续 2 个号在第 0 页抛错 → 剩下的号一次都不请求
{
  const run = mkRun((b) => {
    if (b === 'B1' || b === 'B2') throw new Error('socket 已断');
    return page(20);
  });
  const r = await fetchAll({ accounts: ACC4, pages: 1, gapMs: 0, run, sleep: mkSleep() });
  assert.equal(run.calls.filter((c) => c.bookId === 'B3' || c.bookId === 'B4').length, 0, '熔断后不该再打请求');
  assert.equal(r.sources[2].err, '未尝试:上游连续失败');
  assert.equal(r.sources[3].err, '未尝试:上游连续失败');
  assert.equal(r.meta.requestsTotal, 2);
  assert.equal(allFailed(r), true, '4 个号全零数据 → 与改动前同义:不输出、不记账');
  ok('熔断器:连续 2 次 CDP 抛错后停手,剩余号记 err(不是 partialErr)');
}

// 15. ⚠️ E6 的直接靶子:熔断器**只数 run() 抛错**,不数 errCode 类失败
{
  const run = mkRun((b) => (b === 'B4' ? page(20) : { ok: false, errCode: -2041 }));
  const r = await fetchAll({ accounts: ACC4, pages: 1, gapMs: 0, run, sleep: mkSleep() });
  assert.ok(run.calls.some((c) => c.bookId === 'B4'), '前 3 个号都 -2041 也不该熔断');
  assert.equal(r.meta.requestsTotal, 4, '总请求数 = 号数 × 1');
  ok('errCode 类失败(含 -2041)不触发熔断 —— 与改动前行为一致,不是缺陷');
}

// 14. ⚠️ E2 的直接靶子:四种错误文案逐条钉死(下游的 -2041 判定就靠它)
{
  const cases = [
    [() => ({ ok: false, errCode: -2041 }), 'errCode=-2041'],
    [() => ({ ok: false, err: 'TypeError: Failed to fetch' }), 'TypeError: Failed to fetch'],
  ];
  for (const [handler, expect] of cases) {
    const r = await fetchAll({ accounts: [ACC2[0]], pages: 1, gapMs: 0, run: mkRun(handler), sleep: mkSleep() });
    assert.equal(r.sources[0].err, expect);
  }
  const rThrow = await fetchAll({
    accounts: [ACC2[0]],
    pages: 1,
    gapMs: 0,
    run: mkRun(() => {
      throw new Error('页面里执行出错: xyz');
    }),
    sleep: mkSleep(),
  });
  assert.equal(rThrow.sources[0].err, 'evaluate 失败:页面里执行出错: xyz');

  const rTrip = await fetchAll({
    accounts: ACC4,
    pages: 1,
    gapMs: 0,
    run: mkRun((b) => {
      if (b === 'B1' || b === 'B2') throw new Error('x');
      return page(20);
    }),
    sleep: mkSleep(),
  });
  assert.equal(rTrip.sources[3].err, '未尝试:上游连续失败');

  // 这正是 bin 的 -2041 提示与 §3.5 分支所依赖的判定式
  const r2041 = await fetchAll({
    accounts: [ACC2[0]],
    pages: 1,
    gapMs: 0,
    run: mkRun(() => ({ ok: false, errCode: -2041 })),
    sleep: mkSleep(),
  });
  assert.equal(String(r2041.sources[0].err).includes('errCode=-2041'), true);
  ok('四种错误文案钉死:errCode=<n> / 页内异常原文 / evaluate 失败:… / 未尝试:上游连续失败');
}

// toMarkdown:部分失败时,已抓到的文章照常出表格,警告附在表格**之后**
{
  const md = toMarkdown([
    {
      name: '甲号',
      bookId: 'B1',
      items: [art(1785636055, 'AAA'), art(1785549655, 'BBB')],
      pagesFetched: 2,
      partialErr: 'errCode=-2041',
    },
  ]);
  const dataRows = (md.match(/^\| 20\d{2}-/gm) || []).length;
  assert.equal(dataRows, 2, '已抓到的两条必须还在');
  assert.ok(md.includes('第 3 页起未取到:errCode=-2041'));
  assert.ok(md.indexOf('未取到') > md.lastIndexOf('[原文]'), '警告必须在表格之后');
  // 渲染层不区分失败来源,只区分"有没有数据"
  const md2 = toMarkdown([{ name: '甲号', bookId: 'B1', items: [art(1785636055, 'AAA')], pagesFetched: 1, partialErr: 'evaluate 失败:target closed' }]);
  assert.ok(md2.includes('第 2 页起未取到:evaluate 失败'));
  ok('部分失败的号:表格照出,警告附在表格之后');
}

// 零篇 + partialErr:第 0 页成功但返回 0 篇、第 1 页失败。
// 这是"没有取到文章"分支早退时会被静默吞掉的那条警告 —— 它必须还在。
{
  const zero = { name: '丙号', bookId: 'B3', items: [], pageMeta: [], pagesFetched: 1, partialErr: 'errCode=-2041' };
  const md = toMarkdown([zero]);
  assert.ok(md.includes('没有取到文章'), '零篇的说明还要在');
  assert.ok(md.includes('第 2 页起未取到:errCode=-2041'), '零篇时 partialErr 警告不许被吞掉');
  assert.ok(md.indexOf('未取到') > md.indexOf('没有取到文章'), '警告仍在数据说明之后');
  assert.equal((md.match(/^\| 20\d{2}-/gm) || []).length, 0, '零篇不该凭空长出数据行');
  assert.ok(!md.includes('| 时间 | 标题 | 链接 |'), '零篇不该出表头');

  // 对照组:同样零篇但没有 partialErr → 一个字的警告都不该出现(防"无脑打印")
  const clean = toMarkdown([{ name: '丁号', bookId: 'B4', items: [], pageMeta: [], pagesFetched: 1 }]);
  assert.ok(clean.includes('没有取到文章'));
  assert.ok(!clean.includes('未取到:'), '没有 partialErr 就不该有警告');
  ok('零篇 + partialErr:警告照出(不再被"没有取到文章"分支吞掉),无 partialErr 时不误报');
}

// ---------- -2041 出错路径 ----------
// 全离线:reloadTab / probeUntilReady / readShelf 全是假的,零网络零额度。
console.log('-2041 出错路径');

function mkDeps({ reloadThrows = false, shelf = [{ name: 'x' }] } = {}) {
  const n = { reload: 0, probe: 0, shelf: 0 };
  return {
    n,
    deps: {
      reloadTab: async () => {
        n.reload++;
        if (reloadThrows) throw new Error('Page.reload 不支持');
      },
      probeUntilReady: async () => {
        n.probe++;
        return { verdict: 'ready' };
      },
      readShelf: async () => {
        n.shelf++;
        return shelf;
      },
    },
  };
}
const mkResult = (sources) => ({ onReader: true, meta: { pages: 1, requestsTotal: sources.length }, sources });

{
  // 1. 有 -2041 → 刷新恰好 1 次
  const { n, deps } = mkDeps();
  const r = mkResult([
    { name: '甲', bookId: 'B1', err: 'errCode=-2041' },
    { name: '乙', bookId: 'B2', items: [], pageMeta: [], pagesFetched: 1 },
  ]);
  const failedBefore = r.sources.filter((s) => s.err).length;
  const d = await diagnose2041(r, deps);
  assert.equal(n.reload, 1);
  assert.equal(d.probeVerdict, 'ready');
  // 5. 额度红线:走了这条分支之后,failed 的计算结果必须完全不变
  assert.equal(r.sources.filter((s) => s.err).length, failedBefore);
  ok('有 -2041 → 刷新恰好 1 次,且 failed 的计算结果不受影响');

  // 3. 部分失败 → 刷新 1 次,但**不问书架**
  assert.equal(n.shelf, 0, '还有号成功,账号显然没事,不该再花一个书架请求');
  ok('部分失败时不查书架(U4.6:只在全失败时探)');
}

{
  // 2. 只有 -2010 → 一次都不刷新
  const { n, deps } = mkDeps();
  const d = await diagnose2041(mkResult([{ name: '甲', bookId: 'B1', err: 'errCode=-2010' }]), deps);
  assert.equal(d, null);
  assert.equal(n.reload, 0);
  assert.equal(n.shelf, 0);
  ok('只有 -2010(登录失效)→ 不刷新、不查书架');
}

{
  // 3'. partialErr 里的 -2041 也要认出来
  const { n, deps } = mkDeps();
  await diagnose2041(
    mkResult([{ name: '甲', bookId: 'B1', items: [], pageMeta: [], pagesFetched: 2, partialErr: 'errCode=-2041' }]),
    deps
  );
  assert.equal(n.reload, 1);
  assert.equal(n.shelf, 0, 'partialErr 意味着有数据,不算全失败');
  ok('partialErr 里的 -2041 同样触发刷新,但不查书架');
}

{
  // 4. 全部 -2041 → 刷新 1 次 + 书架 1 次
  const { n, deps } = mkDeps();
  const d = await diagnose2041(
    mkResult([
      { name: '甲', bookId: 'B1', err: 'errCode=-2041' },
      { name: '乙', bookId: 'B2', err: 'errCode=-2041' },
    ]),
    deps
  );
  assert.equal(n.reload, 1);
  assert.equal(n.shelf, 1);
  assert.equal(d.shelfSignal, '可用');
  ok('全部号 -2041 → 刷新 1 次 + 书架信号 1 次(可用 = 登录态还在)');
}

{
  // 6. reloadTab 抛错 → 流程不中断,照常陈述,书架逻辑照走
  const { n, deps } = mkDeps({ reloadThrows: true });
  const d = await diagnose2041(mkResult([{ name: '甲', bookId: 'B1', err: 'errCode=-2041' }]), deps);
  assert.ok(d.reloadNote.startsWith('刷新失败:'));
  assert.equal(n.probe, 1, '刷新失败也要重探');
  assert.equal(n.shelf, 1);
  ok('reloadTab 抛错不中断流程,如实写成「刷新失败:…」');
}

{
  // U4.6 的书架探测为什么进不了账本 —— 结构性事实,钉住它。
  // ⚠️ 这里说的**只有 diagnose2041 这一次探测**。getReaderTab 推导 readerUrl 时发的那次
  //    书架请求是另一回事:它在主路径上、会被如实记进 requests.shelf
  //    (见下面「阅读器页与书架记账」一节)。两者的不对称是刻意的,依据就是下面这两条。
  const partial = mkResult([
    { name: '甲', bookId: 'B1', err: 'errCode=-2041' },
    { name: '乙', bookId: 'B2', items: [art(1785636055, 'AAA')], pageMeta: [], pagesFetched: 1 },
  ]);
  assert.equal(allFailed(partial), false, '有号成功 → 非全失败 → 这类运行才会走到 quota.commit');
  const d1 = await diagnose2041(partial, mkDeps().deps);
  assert.equal(d1.shelfSignal, '未检查', '能走到记账点的运行,U4.6 那次探测一定没发生');

  const total = mkResult([
    { name: '甲', bookId: 'B1', err: 'errCode=-2041' },
    { name: '乙', bookId: 'B2', err: 'errCode=-2041' },
  ]);
  const d2 = await diagnose2041(total, mkDeps().deps);
  assert.equal(d2.shelfSignal, '可用', '唯一会探书架的场景');
  assert.equal(allFailed(total), true, '而它必然被全失败判据拦下(return 在 commit 之前)→ 不记账');
  ok('U4.6 的书架探测与记账互斥:走到记账点 ⟹ 没探过它,探了它 ⟹ 全失败不记账');
}

{
  // 措辞是设计的一部分:只陈述观察,不下结论
  const note = format2041Note({ reloadNote: '已刷新', probeVerdict: 'captcha', shelfSignal: '可用' });
  for (const banned of ['原因是', '因为', '说明被限流']) {
    assert.ok(!note.includes(banned), `陈述式文案里不许出现「${banned}」`);
  }
  assert.ok(note.includes('观察到'));
  assert.ok(note.includes('不对 -2041 的原因下结论'));
  ok('文案只陈述观察,不断定因果(无「原因是/因为/说明被限流」)');

  // 注解只配给真的探过书架的值。「未检查」时那句"可用说明登录态还在"读不通,不许拼上去
  const HINT = '← 可用说明登录态还在';
  const skipped = format2041Note({ reloadNote: '已刷新', probeVerdict: 'ready', shelfSignal: '未检查' });
  assert.ok(skipped.includes('/web/shelf/sync: 未检查'), '值本身照常如实显示');
  assert.ok(!skipped.includes(HINT), '未检查时不该拼那句注解');
  for (const banned of ['原因是', '因为', '说明被限流']) assert.ok(!skipped.includes(banned));
  for (const sig of ['可用', '不可用']) {
    const n = format2041Note({ reloadNote: '已刷新', probeVerdict: 'ready', shelfSignal: sig });
    assert.ok(n.includes(`/web/shelf/sync: ${sig}   ${HINT}`), `${sig} 时注解要在`);
  }
  ok('书架那行的注解只在真的探过时才出现(未检查时不拼读不通的话)');
}

// ---------- Chrome 连接报错文案 ----------
// 用户照着报错做,必须和照着 README 做是同一件事。全程零网络:不连 Chrome、不发任何请求。
console.log('Chrome 连接报错文案');

{
  const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  // 关键 token 两边都得在 —— 改了 README 不改报错(或反过来)会在这里当场失败
  for (const token of [
    '--remote-debugging-port=9333',
    '--user-data-dir',
    '.weread-mp-fetcher/chrome-profile',
    'chrome://inspect/#remote-debugging',
    'Allow remote debugging for this browser instance',
  ]) {
    assert.ok(README.includes(token), `README 里应该有:${token}`);
    assert.ok(CONNECT_HELP.includes(token), `连接报错文案里应该有:${token}`);
  }
  // 旧写法「请用 --remote-debugging-port=9222 启动 Chrome」必须绝迹
  assert.ok(!CONNECT_HELP.includes('9222'), '报错文案里不许再出现 9222');
  // 「两个参数缺一不可」:凡提到端口参数的行,必须同时提到 --user-data-dir。
  // 这一条正是 Chrome 136 那个静默失效坑的靶子 —— 只写端口的指引会把人带沟里。
  for (const line of CONNECT_HELP.split('\n')) {
    if (line.includes('--remote-debugging-port')) {
      assert.ok(line.includes('--user-data-dir'), `这一行只提了端口、没提目录:${line}`);
    }
  }
  ok('连接指引与 README 一致:9333 + user-data-dir 缺一不可、含方案B 开关、无 9222 旧写法');
}

{
  const cdpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmf-cdp-'));

  // (a) 端口都找不到:空 profile 目录里没有 DevToolsActivePort,连 fetch 都走不到
  await assert.rejects(
    () => connectChrome({ profileDir: cdpDir }),
    (e) => {
      assert.ok(e.message.includes('找不到 Chrome 的调试端口'), e.message);
      assert.ok(e.message.includes(CONNECT_HELP), '双方案指引必须真的出现在报错正文里');
      assert.ok(!e.message.includes('9222'));
      return true;
    }
  );

  // (b) 拿不到 wsPath:用假 fetch 挡住,连一个 socket 都不建立
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('离线测试:不许真的发请求');
  };
  try {
    await assert.rejects(
      () => connectChrome({ port: 9333, profileDir: cdpDir }),
      (e) => {
        assert.ok(e.message.includes('拿不到浏览器 WebSocket 路径'), e.message);
        assert.ok(e.message.includes(CONNECT_HELP), '双方案指引必须真的出现在报错正文里');
        return true;
      }
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  fs.rmSync(cdpDir, { recursive: true, force: true });
  ok('两处连接失败的报错都带上了双方案指引(零网络:空 profile 目录 + 假 fetch)');
}

// ---------- 阅读器页与书架记账 ----------
// 靶子:getReaderTab 在"没有可复用阅读器页且没配 readerUrl"时发的那 1 个真实
// /web/shelf/sync,必须如实记进账本的 requests.shelf(用户 2026-08-11 授权的额度语义变更)。
console.log('阅读器页与书架记账');

/**
 * 假 CDP 会话:只认 lib/cdp.mjs 真正会发的那几个方法。
 * 用它跑的是**真实的** getReaderTab / listTabs / createTab / evaluate 代码路径,零网络。
 */
function fakeCdpSession({ tabs = [], shelf = [] } = {}) {
  const pages = tabs.map((t, i) => ({
    targetId: t.targetId || `T${i}`,
    type: 'page',
    title: t.title || '',
    url: t.url,
  }));
  const calls = { shelfSync: 0, created: [] };
  const attached = new Map();
  let n = 0;
  const session = {
    send: async (method, params = {}, sessionId) => {
      switch (method) {
        case 'Target.getTargets':
          return { targetInfos: pages };
        case 'Target.createTarget': {
          const t = { targetId: `NEW${++n}`, type: 'page', title: '某某 - 公众号 - 微信读书', url: params.url };
          pages.push(t);
          calls.created.push(params.url);
          return { targetId: t.targetId };
        }
        case 'Target.attachToTarget': {
          const sid = `S${++n}`;
          attached.set(sid, params.targetId);
          return { sessionId: sid };
        }
        case 'Target.detachFromTarget':
          return {};
        case 'Runtime.evaluate': {
          const expr = params.expression;
          if (expr === LIST_SHELF_JS) {
            calls.shelfSync++; // ★ 这一次就是真实的 /web/shelf/sync
            return { result: { value: JSON.stringify(shelf) } };
          }
          if (expr.includes('location.href')) {
            const t = pages.find((p) => p.targetId === attached.get(sessionId));
            return { result: { value: `${t.url}|complete` } };
          }
          throw new Error('假会话不认识这段 JS:' + expr.slice(0, 40));
        }
        default:
          throw new Error('假会话不认识的 CDP 方法:' + method);
      }
    },
  };
  return { session, calls };
}

// getReaderTab 会往 stderr 打提示,测试里静音,免得淹掉判据
const quiet = async (fn) => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};

const READER_URL = 'https://weread.qq.com/web/mp/reader/xyz';

// 路径 1:有可复用的阅读器标签页 → 一个请求都不发
const A = fakeCdpSession({
  tabs: [{ targetId: 'READER', title: '某某 - 公众号 - 微信读书', url: 'https://weread.qq.com/web/mp/reader/abc' }],
});
const rA = await quiet(() => getReaderTab(A.session, {}));
assert.equal(rA.targetId, 'READER');
assert.equal(rA.shelfRequests, 0, '复用现成的阅读器页 → 书架请求数必须是 0');
assert.equal(A.calls.shelfSync, 0, '而且确实一次书架接口都没调');
assert.deepEqual(A.calls.created, [], '也没有新开标签页');

// 路径 2:没有可复用页、也没配 readerUrl → 真的问一次书架
const B = fakeCdpSession({
  tabs: [{ targetId: 'HOME', title: '微信读书', url: 'https://weread.qq.com/' }],
  shelf: [{ name: '甲号', bookId: 'MP_WXS_1', readerUrl: READER_URL }],
});
const rB = await quiet(() => getReaderTab(B.session, {}));
assert.equal(B.calls.shelfSync, 1, '推导 readerUrl 必须真的问一次书架');
assert.equal(rB.shelfRequests, 1, '发了就得如实报出来,不能吞掉');
assert.deepEqual(B.calls.created, [READER_URL], '并用书架里推出来的 URL 开阅读器页');
assert.equal(rB.targetId, 'NEW2');

// 路径 3:没有可复用页,但 config 写了 readerUrl → 不必问书架
const C = fakeCdpSession({ tabs: [{ targetId: 'HOME', title: '微信读书', url: 'https://weread.qq.com/' }] });
const rC = await quiet(() => getReaderTab(C.session, { readerUrl: READER_URL }));
assert.equal(C.calls.shelfSync, 0, 'config 里已经有 URL 了,没有理由再问书架');
assert.equal(rC.shelfRequests, 0);
ok('getReaderTab 如实报出书架请求数:复用页=0、推导 readerUrl=1、config 写死 readerUrl=0');

{
  // 账目:同样两次运行,只有"问过书架"的那本账多记 1 个,并因此更早顶到预算上限
  const acctDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmf-shelf-'));
  const stReuse = path.join(acctDir, 'reuse.json');
  const stDerive = path.join(acctDir, 'derive.json');
  const fakeResult = { onReader: true, meta: { pages: 1, requestsTotal: 4 }, sources: [] };

  commitRun({ statePath: stReuse }, fakeResult, rA.shelfRequests);
  assert.deepEqual(JSON.parse(fs.readFileSync(stReuse, 'utf8')).requests, { articles: 4, shelf: 0 });
  assert.equal(quota.status(stReuse, 2, 40).requests.used, 4);

  commitRun({ statePath: stDerive }, fakeResult, rB.shelfRequests);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(stDerive, 'utf8')).requests,
    { articles: 4, shelf: 1 },
    '书架请求要落在 shelf 一栏,不能混进 articles'
  );
  assert.equal(quota.status(stDerive, 2, 40).requests.used, 5, 'shelf 计入 used(用户知情授权的额度语义变更)');

  // 进而参与预算闸门判定 —— 这正是这次语义变更的实际后果
  assert.equal(quota.checkRequests(stDerive, 5, 1).ok, false, 'used=5 已顶满 5 的预算 → 再要 1 个就该拒绝');
  assert.equal(quota.checkRequests(stReuse, 5, 1).ok, true, '同样两次运行,没问书架的那本账还剩 1 个额度');
  fs.rmSync(acctDir, { recursive: true, force: true });
  ok('书架请求如实进账本 requests.shelf,计入 used 并参与预算闸门判定');
}

// ---------- 翻页回归基线 ----------
console.log('翻页回归基线(golden fixture)');

const PAGES_INPUT = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/pages-input.json'), 'utf8'));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/fetch-pages1.golden.json'), 'utf8'));
const GOLDEN_ACCOUNTS = [
  { name: '甲号', bookId: 'MP_WXS_0000000001' },
  { name: '乙号', bookId: 'MP_WXS_0000000002' },
];

// 新链路 = 页内 buildPageJs + Node 侧 fetchAll,喂**同一份**假接口响应
const goldenNow = await fetchAll({
  accounts: GOLDEN_ACCOUNTS,
  pages: 1,
  gapMs: 0,
  run: async (bookId, offset) => (await runPageJs(bookId, offset, PAGES_INPUT)).out,
  sleep: mkSleep(),
});

// 六条口径,缺一不可。白名单是**测试代码里的字面量**:要往产物里加字段,
// 就得先改这一行 —— 强制把改动摆到台面上。
const TOP_ADD_OK = ['meta'];
const SRC_ADD_OK = ['pageMeta', 'pagesFetched'];
const diff = (a, b) => a.filter((k) => !b.includes(k));

assert.equal(goldenNow.onReader, GOLDEN.onReader, '① 顶层 onReader 不许静默消失');
assert.equal(goldenNow.sources.length, GOLDEN.sources.length);
for (let i = 0; i < GOLDEN.sources.length; i++) {
  assert.equal(goldenNow.sources[i].name, GOLDEN.sources[i].name, '② name');
  assert.equal(goldenNow.sources[i].bookId, GOLDEN.sources[i].bookId, '② bookId');
  assert.deepEqual(goldenNow.sources[i].items, GOLDEN.sources[i].items, '③ 数据本体必须逐字段一致');
  const added = diff(Object.keys(goldenNow.sources[i]), Object.keys(GOLDEN.sources[i]));
  const removed = diff(Object.keys(GOLDEN.sources[i]), Object.keys(goldenNow.sources[i]));
  assert.deepEqual(diff(added, SRC_ADD_OK), [], `⑤ source 级新增字段超出白名单:${added}`);
  assert.deepEqual(removed, [], `⑥ source 级字段被删:${removed}`);
}
const addedTop = diff(Object.keys(goldenNow), Object.keys(GOLDEN));
const removedTop = diff(Object.keys(GOLDEN), Object.keys(goldenNow));
assert.deepEqual(diff(addedTop, TOP_ADD_OK), [], `④ 顶层新增字段超出白名单:${addedTop}`);
assert.deepEqual(removedTop, [], `⑥ 顶层字段被删:${removedTop}`);
ok('pages=1 的产物与改动前的 golden 六条口径全对得上(新增只有 meta / pageMeta / pagesFetched)');

console.log(`\n全部通过(${passed} 项)`);
