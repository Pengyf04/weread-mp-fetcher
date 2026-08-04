#!/usr/bin/env node
// 离线自测:不连 Chrome、不碰微信读书,只验纯逻辑。
//   node test/offline.test.mjs
//
// 覆盖的是最容易悄悄坏掉、又最难在真实环境里复现的几处判据。

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { PROBE_JS, buildFetchJs } from '../lib/scripts.mjs';
import * as quota from '../lib/quota.mjs';

let passed = 0;
const ok = (msg) => {
  passed++;
  console.log('  ✓', msg);
};

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

console.log(`\n全部通过(${passed} 项)`);
