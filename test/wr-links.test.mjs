import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as quota from '../lib/quota.mjs';
import * as scripts from '../lib/scripts.mjs';
const { buildPageJs } = scripts;
import { toMarkdown } from '../lib/render.mjs';

test('单篇尝试单独落账，失败也计尝试，但不增加预算用量或运行次数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-content-quota-'));
  const file = path.join(dir, 'quota.json');
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  try {
    fs.writeFileSync(file, JSON.stringify({ date, count: 1, requests: { articles: 2, shelf: 1, future: 8 } }));
    assert.equal(quota.status(file, 2, 40).requests.content, 0);
    quota.recordContentAttempt(file);
    quota.recordContentAttempt(file); // 第二次也可能拒绝/超时，已在请求尝试前记录
    const s = quota.status(file, 2, 40);
    assert.equal(s.requests.content, 2);
    assert.equal(s.requests.used, 3);
    assert.equal(s.count, 1);
    assert.equal(s.requests.future, 8);
    assert.equal(quota.checkRequests(file, 40, 37).ok, true);
    quota.commit(file, { articles: 1 });
    assert.equal(quota.status(file, 2, 40).requests.content, 2);
    assert.equal(quota.status(file, 2, 40).count, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const BOOK = 'MP_WXS_1234567890';
const RID = `${BOOK}_WR${'a'.repeat(73)}`;
const SHORT = 'AbCdEfGhIjKlMnOpQrStUv';
const ARTICLE_URL = 'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=123&idx=1&sn=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const metadata = () => ({ ok: true, title: '测试文章', url: ARTICLE_URL + '&pass_ticket=synthetic-ticket&chksm=temporary&poc_token=temporary#fragment' });
const item = (rid = RID, t = 100) => ({ rid, t, title: '测试文章', url: '' });
const batch = (items, extra = {}) => ({ onReader: true, meta: { pages: 1, requestsTotal: 1 }, sources: [{ bookId: BOOK, name: '示例号', items, ...extra }] });

async function harness(input, replies, options = {}) {
  const { resolveLinks } = await import('../lib/links.mjs');
  const events = [];
  let active = 0;
  const result = await resolveLinks(input, {
    sleep: async ms => events.push(['sleep', ms]),
    probe: async () => { events.push(['probe']); return { verdict: 'ready' }; },
    record: async () => { events.push(['record']); },
    run: async it => {
      assert.equal(active++, 0, '请求不得并行');
      events.push(['run', it.rid]);
      try {
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      } finally { active--; }
    },
    ...options,
  });
  return { result, events };
}

test('只从合法元数据生成四参数标准地址，不泄露临时票据', async () => {
  const { validateArticleMetadata } = await import('../lib/links.mjs');
  assert.deepEqual(validateArticleMetadata(item(), BOOK, metadata()), { ok: true, url: ARTICLE_URL });
  const invalid = [
    { ...metadata(), title: '另一篇' },
    { ...metadata(), url: metadata().url.replace('mp.weixin.qq.com', 'mp.weixin.qq.com.evil.example') },
    { ...metadata(), url: metadata().url.replace('https:', 'http:') },
    { ...metadata(), url: metadata().url.replace('/s?', '/s/WRfake?') },
    { ...metadata(), url: metadata().url.replace('mp.weixin.qq.com', 'user:password@mp.weixin.qq.com') },
    { ...metadata(), url: metadata().url.replace('mp.weixin.qq.com', 'mp.weixin.qq.com:8443') },
    { ...metadata(), url: ARTICLE_URL + '&idx=2' },
    { ...metadata(), url: ARTICLE_URL.replace('&mid=123', '') },
    { ...metadata(), url: ARTICLE_URL.replace('MTIzNDU2Nzg5MA%3D%3D', '!!!') },
    { ...metadata(), url: ARTICLE_URL.replace('MTIzNDU2Nzg5MA%3D%3D', 'OTk5OTk5OTk5OQ%3D%3D') },
    { ...metadata(), url: ARTICLE_URL.replace('mid=123', 'mid=nan') },
    { ...metadata(), url: ARTICLE_URL.replace('sn=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'sn=invalid') },
  ];
  for (const m of invalid) assert.equal(validateArticleMetadata(item(), BOOK, m).ok, false);
  assert.equal(validateArticleMetadata(item(), 'MP_WXS_9999999999', metadata()).ok, false);
  assert.equal(validateArticleMetadata(item('invalid'), BOOK, metadata()).ok, false);
});

test('标题只比较已经解码的og:title与列表标题，不重复实体解码', async () => {
  const { validateArticleMetadata } = await import('../lib/links.mjs');
  assert.equal(validateArticleMetadata({ ...item(), title: ' A &amp; B ' }, BOOK,
    { ...metadata(), title: 'A &amp; B' }).ok, true);
  assert.equal(validateArticleMetadata({ ...item(), title: 'A & B' }, BOOK,
    { ...metadata(), title: 'A &amp; B' }).ok, false);
});

test('全部缺链项都处理，同rid全局去重，保留条目及输出顺序', async () => {
  const rid2 = `${BOOK}_WR${'b'.repeat(73)}`;
  const original = batch([item(RID, 50), item(rid2, 100), item(RID, 50)]);
  const { result, events } = await harness(original, [metadata(), metadata()], { gapMs: 20 });
  assert.deepEqual(events, [
    ['sleep', 3000], ['probe'], ['record'], ['run', rid2],
    ['sleep', 3000], ['probe'], ['record'], ['run', RID],
  ]);
  assert.equal(result.sources[0].items.length, 3);
  assert.deepEqual(result.sources[0].items.map(i => i.rid), [RID, rid2, RID]);
  assert.ok(result.sources[0].items.every(i => i.url === ARTICLE_URL && i.linkStatus === 'metadata_url'));
  assert.equal(original.sources[0].items[0].url, '', '不要修改调用方原对象');
  assert.equal(result.meta.links.requestsTotal, 2);
  assert.equal(result.meta.links.unresolved, 0);
});

test('无效或溢出计时器范围的间隔不能被Node折算成1ms', async () => {
  for (const gapMs of [Infinity, 'Infinity', 2147483648, NaN]) {
    const { events } = await harness(batch([item()]), [metadata()], { gapMs });
    assert.deepEqual(events[0], ['sleep', 3000]);
  }
});

test('已有链接不额外请求，不合法或缺失rid保留明确缺口', async () => {
  const short = { ...item(), url: `https://mp.weixin.qq.com/s/${SHORT}` };
  const { result, events } = await harness(batch([short, item(''), item('bad/rid')]), []);
  assert.deepEqual(events, []);
  assert.equal(result.sources[0].items[0].url, short.url);
  assert.equal(result.sources[0].items[1].linkReason, 'invalid_review_id');
  assert.equal(result.meta.links.requestsTotal, 0);
});

for (const reply of [
  { ok: false, reason: 'http_error', errCode: 429 },
  { ok: false, reason: 'json_error', errCode: -2041 },
  { ok: false, reason: 'verification_page' },
  { ok: false, reason: 'timeout' },
  { ...metadata(), title: '错误文章' },
  new Error('CDP failure with synthetic-ticket'),
]) test(`转链失败即停且不重试：${reply.reason || (reply instanceof Error ? 'CDP' : 'title')}`, async () => {
  const rid2 = `${BOOK}_WR${'b'.repeat(73)}`;
  const rid3 = `${BOOK}_WR${'c'.repeat(73)}`;
  const { result, events } = await harness(batch([item(RID, 300), item(rid2, 200), item(rid3, 100)]),
    [metadata(), reply, metadata()]);
  assert.equal(events.filter(e => e[0] === 'run').length, 2);
  assert.equal(events.filter(e => e[0] === 'record').length, 2);
  assert.equal(result.sources[0].items[0].url, ARTICLE_URL);
  assert.equal(result.sources[0].items[1].url, '');
  assert.equal(result.sources[0].items[2].url, '');
  assert.equal(result.sources[0].err, undefined);
  assert.equal(result.meta.links.requestsTotal, 2);
  assert.ok(result.meta.links.aborted);
  assert.ok(!JSON.stringify(result).includes('synthetic-ticket'));
});

test('列表已有错误时，不能因页面恢复ready而继续单篇转链', async () => {
  const { result, events } = await harness(batch([item()], { partialErr: 'errCode=-2041' }), []);
  assert.deepEqual(events, []);
  assert.equal(result.meta.links.aborted.reason, 'list_error');
});

test('验证码/探针异常或记账失败：请求前停手，不丢原列表', async () => {
  for (const options of [
    { probe: async () => ({ verdict: 'captcha' }) },
    { probe: async () => { throw Error('closed'); } },
    { record: async () => { throw Error('disk full'); } },
  ]) {
    const { result, events } = await harness(batch([item()]), [], options);
    assert.equal(events.filter(e => e[0] === 'run').length, 0);
    assert.equal(result.meta.links.requestsTotal, 0);
    assert.equal(result.sources[0].items.length, 1);
    assert.equal(result.sources[0].items[0].url, '');
    assert.ok(result.meta.links.aborted);
  }
});

const HTML = `<html><head><title>测试文章</title><meta property="og:title" content="测试文章"><meta property="og:url" content="${ARTICLE_URL.replace(/&/g, '&amp;')}&amp;pass_ticket=synthetic-ticket"></head><body>${'无关正文'.repeat(20000)}</body></html>`;
async function contentPage(response, { timeout = false } = {}) {
  const requests = [];
  let cleared = 0;
  const script = scripts.buildContentJs(RID, 50);
  const raw = await vm.runInNewContext(script, {
    AbortController,
    setTimeout: fn => { if (timeout) fn(); return 7; },
    clearTimeout: id => { assert.equal(id, 7); cleared++; },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (options.signal.aborted) throw Error('aborted');
      if (response instanceof Error) throw response;
      return { ok: true, status: 200, text: async () => HTML, ...response };
    },
  });
  assert.equal(cleared, 1);
  return { out: JSON.parse(raw), requests, raw };
}

test('单篇脚本同源请求完整rid，不跟随重定向、不返回全文、不执行页面脚本', async () => {
  const { out, requests, raw } = await contentPage({});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `/web/mp/content?reviewId=${encodeURIComponent(RID)}`);
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(out.ok, true);
  assert.equal(out.title, '测试文章');
  assert.ok(raw.length < 2000, '数MB响应不得穿透CDP返回给Node');
  assert.ok(!raw.includes('无关正文'));
});

test('单篇HTTP拒绝、业务错误和超时均返回失败，不重试', async () => {
  for (const [response, options, reason] of [
    [{ ok: false, status: 429 }, {}, 'http_error'],
    [{ text: async () => '{"errCode":-2041}' }, {}, 'json_error'],
    [new Error('network'), {}, 'content_unavailable'],
    [{}, { timeout: true }, 'timeout'],
  ]) {
    const { out, requests } = await contentPage(response, options);
    assert.equal(out.ok, false);
    assert.equal(out.reason, reason);
    assert.equal(requests.length, 1);
  }
});

async function pageItem(originalId, rid = RID) {
  const raw = await vm.runInNewContext(buildPageJs(BOOK, 0), {
    location: { pathname: '/web/mp/reader/test' },
    fetch: async () => ({
      json: async () => ({
        reviews: [{ subReviews: [{ review: {
          reviewId: rid, createTime: 100,
          mpInfo: { title: '测试文章', originalId },
        } }] }],
      }),
    }),
  });
  return JSON.parse(raw).items[0];
}

test('WR不透明长ID不能伪装成微信短链，完整rid不变', async () => {
  const item = await pageItem(`WR${'a'.repeat(73)}`);
  assert.equal(item.url, '');
  assert.equal(item.rid, RID);
});

test('空链接明确显示缺口，不生成可点击的空原文链接', () => {
  const md = toMarkdown([{ name: '示例号', items: [{ t: 100, title: '测试文章', rid: RID, url: '' }] }]);
  assert.ok(md.includes('原文链接未取得'));
  assert.ok(!md.includes('[原文]()'));
});

test('已知22字符短token沿用~还原规则，不改rid', async () => {
  const token = 'Ab~dEfGhIjKlMnOpQrStUv';
  assert.equal(token.length, 22);
  const item = await pageItem(token);
  assert.equal(item.url, 'https://mp.weixin.qq.com/s/Ab_dEfGhIjKlMnOpQrStUv');
  assert.equal(item.rid, RID);
  assert.equal((await pageItem(SHORT)).url, `https://mp.weixin.qq.com/s/${SHORT}`);
});
