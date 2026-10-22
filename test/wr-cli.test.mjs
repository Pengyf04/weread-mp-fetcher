import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RID = `MP_WXS_1234567890_WR${'a'.repeat(73)}`;
const ARTICLE_URL = 'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=123&idx=1&sn=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function runCli(mode, format) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-cli-'));
  const fake = path.join(dir, 'fake-cdp.mjs');
  const loader = path.join(dir, 'loader.mjs');
  const cfg = path.join(dir, 'config.json');
  const state = path.join(dir, 'quota.json');
  const trace = path.join(dir, 'trace.jsonl');
  const out = path.join(dir, `result.${format}`);
  fs.writeFileSync(cfg, JSON.stringify({
    accounts: [{ name: '示例号', bookId: 'MP_WXS_1234567890' }],
    chromePort: 9333, maxRunsPerDay: 2, maxRequestsPerDay: 40, statePath: state,
  }));
  fs.writeFileSync(loader, `export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/lib/cdp.mjs')) return {url:${JSON.stringify(pathToFileURL(fake).href)},shortCircuit:true};
    return nextResolve(specifier, context);
  }`);
  fs.writeFileSync(fake, `
    import fs from 'node:fs';
    import vm from 'node:vm';
    export async function connectChrome(){return {close(){}};}
    export async function listTabs(){return [{targetId:'R',title:'示例 - 公众号 - 微信读书',url:'https://weread.qq.com/web/mp/reader/test'}];}
    export async function createTab(){throw Error('unexpected createTab');}
    export async function reloadTab(){throw Error('unexpected reload');}
    export async function evaluate(session, target, expression){
      return vm.runInNewContext(expression, {
        location:{pathname:'/web/mp/reader/test'}, window:{},
        document:{title:'示例 - 公众号 - 微信读书',body:{innerText:''},querySelectorAll:()=>[]},
        AbortController, setTimeout, clearTimeout,
        fetch:async (url, options)=>{
          fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({url,redirect:options?.redirect})+'\\n');
          if(url.startsWith('/web/mp/articles?') && ${mode === 'record-failed'}) fs.mkdirSync(${JSON.stringify(state)}, {recursive:true});
          if(url.startsWith('/web/mp/articles?')) return {json:async()=>({reviews:[{subReviews:[
            {review:{reviewId:${JSON.stringify(RID)},createTime:100,mpInfo:{title:'测试文章',originalId:'WR'+'a'.repeat(73)}}},
            {review:{reviewId:'MP_WXS_1234567890_short',createTime:50,mpInfo:{title:'旧短链',originalId:'AbCdEfGhIjKlMnOpQrStUv'}}}
          ]}]})};
          if(url.startsWith('/web/mp/content?')) return {
            ok:${mode === 'success'},status:${mode === 'success' ? 200 : 429},
            text:async()=>'<html><head><meta property="og:title" content="测试文章"><meta property="og:url" content="${ARTICLE_URL.replace(/&/g, '&amp;')}&amp;pass_ticket=synthetic-ticket"></head><body>正文不输出</body></html>'
          };
          throw Error('unexpected URL: must not visit public articles');
        }
      });
    }
  `);
  const child = spawnSync(process.execPath, ['--loader', pathToFileURL(loader).href,
    path.join(ROOT, 'bin/weread.mjs'), '--config', cfg, '--format', format, '--out', out], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return {
    dir, child, hasOutput: () => fs.existsSync(out),
    readOutput: () => fs.readFileSync(out, 'utf8'),
    readState: () => JSON.parse(fs.readFileSync(state, 'utf8')),
    readTrace: () => fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse),
  };
}

test('转链记账不可写时不发单篇请求，仍导出已抓列表并返回失败状态', () => {
  const h = runCli('record-failed', 'json');
  try {
    assert.equal(h.child.status, 1);
    assert.ok(h.hasOutput(), '记账失败不能把已取得的列表一并丢掉');
    const output = JSON.parse(h.readOutput());
    assert.equal(output.sources[0].items.length, 2);
    assert.equal(output.meta.links.aborted.reason, 'record_failed');
    assert.equal(h.readTrace().length, 1, '不能在无法记录尝试时继续请求内容');
    assert.ok(h.child.stderr.includes('账本'));
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

for (const [mode, format] of [['success', 'json'], ['denied', 'md']]) {
  test(`CLI主流程离线端到端：${mode} / ${format}`, () => {
    const h = runCli(mode, format);
    try {
      assert.equal(h.child.status, 0, h.child.stderr);
      assert.equal(h.child.stdout, '', '--out仍保持stdout静默');
      const output = h.readOutput();
      const state = h.readState();
      const trace = h.readTrace();
      assert.equal(trace.length, 2, '只允许1次列表+1次单篇，不能公开页核验或重试');
      assert.equal(trace[1].url, `/web/mp/content?reviewId=${encodeURIComponent(RID)}`);
      assert.equal(trace[1].redirect, 'error');
      assert.equal(state.count, 1, '单篇不得再扣一次运行次数');
      assert.deepEqual(state.requests, { articles: 1, shelf: 0, content: 1 });
      assert.ok(!output.includes('synthetic-ticket'));
      assert.ok(!output.includes('/s/WR'));
      assert.ok(!output.includes('正文不输出'));
      if (mode === 'success') {
        const result = JSON.parse(output);
        assert.equal(result.sources[0].items[0].url, ARTICLE_URL);
        assert.equal(result.sources[0].items[0].linkStatus, 'metadata_url');
        assert.equal(result.meta.links.requestsTotal, 1);
        assert.equal(result.sources[0].items[1].url, 'https://mp.weixin.qq.com/s/AbCdEfGhIjKlMnOpQrStUv');
      } else {
        assert.ok(output.includes('原文链接未取得'));
        assert.ok(!output.includes('[原文]()'));
        assert.ok(h.child.stderr.includes('转链') && h.child.stderr.includes('停止'));
      }
    } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
  });
}
