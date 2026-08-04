#!/usr/bin/env node
// weread-mp-fetcher —— 通过微信读书取公众号最新文章
//
// 用法:
//   node bin/weread.mjs                 抓取(默认输出 JSON)
//   node bin/weread.mjs --format md     输出 Markdown 表格
//   node bin/weread.mjs --probe         只看页面状态,不抓取(免费,不消耗额度)
//   node bin/weread.mjs --shelf         列出你已订阅的公众号及其 bookId
//   node bin/weread.mjs --add <链接|bookId>...  订阅公众号(可给文章链接,自动算出 bookId)
//   node bin/weread.mjs --quota         查看今日已抓次数
//   node bin/weread.mjs --config x.json 指定配置文件

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { connectChrome, listTabs, createTab, evaluate } from '../lib/cdp.mjs';
import { PROBE_JS, buildFetchJs, LIST_SHELF_JS, buildAddToShelfJs } from '../lib/scripts.mjs';
import { resolveBookId } from '../lib/mp.mjs';
import * as quota from '../lib/quota.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

function loadConfig() {
  const file = path.resolve(val('--config', path.join(ROOT, 'config.json')));
  if (!fs.existsSync(file)) {
    console.error(
      `找不到配置文件:${file}\n\n` +
        '第一次用请先复制一份模板:\n' +
        '  cp config.example.json config.json\n' +
        '然后按 README 填上 readerUrl 和要监控的公众号。'
    );
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.statePath = (cfg.statePath || '~/.weread-mp-fetcher/quota.json').replace(/^~/, os.homedir());
  cfg.maxRunsPerDay = cfg.maxRunsPerDay ?? 2;
  cfg.requestIntervalMs = cfg.requestIntervalMs ?? 3000;
  cfg.accounts = cfg.accounts || [];
  return cfg;
}

/** 找任意一个微信读书标签页(首页也行)。书架/订阅这类接口在首页就能调。 */
async function getAnyWereadTab(session) {
  const tabs = await listTabs(session);
  const wr = tabs.filter((t) => t.url.includes('weread.qq.com'));
  // 已渲染好的阅读器页最好用,其次任意 weread 页
  wr.sort((a, b) => Number(b.title.includes('公众号')) - Number(a.title.includes('公众号')));
  if (wr.length) return wr[0].targetId;
  console.error('提示:没有已打开的微信读书页面,正在打开首页。');
  return await createTab(session, 'https://weread.qq.com/');
}

/** 读书架:拿到已订阅公众号 + 每个号的 readerUrl(从 deepLink 推导,不用手动复制) */
async function readShelf(session, targetId) {
  return JSON.parse(await evaluate(session, targetId, LIST_SHELF_JS));
}

/**
 * 找一个可用的阅读器标签页。
 * 抓文章必须在阅读器页上下文里发请求(首页发会 -2041),所以这一步不能省。
 */
async function getReaderTab(session, cfg) {
  const tabs = await listTabs(session);
  const readers = tabs.filter((t) => t.url.includes('weread.qq.com/web/mp/reader/'));
  readers.sort((a, b) => Number(b.title.includes('公众号')) - Number(a.title.includes('公众号')));
  if (readers.length) return readers[0].targetId;

  // 没有现成的就自己推导一个:配置里填了就用配置的,没填就从书架里取
  let url = cfg.readerUrl && !cfg.readerUrl.includes('<') ? cfg.readerUrl : null;
  if (!url) {
    const anyTab = await getAnyWereadTab(session);
    const shelf = await readShelf(session, anyTab);
    const withUrl = shelf.find((b) => b.readerUrl);
    if (!withUrl) {
      console.error(
        '你的微信读书书架里还没有任何公众号,所以拿不到阅读器页。\n\n' +
          '先加一个:\n' +
          '  node bin/weread.mjs --add <该公众号任意一篇文章的链接>\n' +
          '例如:\n' +
          '  node bin/weread.mjs --add https://mp.weixin.qq.com/s/xxxxxxxx\n'
      );
      process.exit(2);
    }
    url = withUrl.readerUrl;
    console.error(`提示:自动使用「${withUrl.name}」的阅读器页(无需手动复制 URL)。`);
  }
  console.error('提示:没有可复用的阅读器标签页,正在打开一个。建议之后别关它,下次直接复用。');
  return await createTab(session, url);
}

async function probeUntilReady(session, targetId, { tries = 12, gapMs = 5000 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = JSON.parse(await evaluate(session, targetId, PROBE_JS));
    if (last.verdict === 'ready') return last;
    if (last.verdict === 'captcha' || last.verdict === 'blank' || last.verdict === 'wrong_page') return last;
    await new Promise((r) => setTimeout(r, gapMs)); // loading:再等等
  }
  return last;
}

function explain(state) {
  switch (state.verdict) {
    case 'captcha':
      return (
        '页面弹出了验证码,需要你在 Chrome 里手动完成。\n' +
        '   完成后重新运行本命令即可。\n' +
        '   (本工具不会替你识别或点选验证码 —— 那是绕过人机校验,不做。)'
      );
    case 'blank':
      return (
        '页面被拦截了(白屏)。通常是短时间内新开太多标签页导致的。\n' +
        '   建议:隔几小时再试,并且保持阅读器标签页常开、不要反复新开。'
      );
    case 'wrong_page':
      return '这个标签页不是公众号阅读器页。请检查 config.json 里的 readerUrl。';
    case 'loading':
      return '页面一直没加载完。可能是网络慢,也可能验证码马上要弹出来(capArming=' + state.capArming + ')。';
    default:
      return '未知状态。';
  }
}

// 用本机时区格式化。不能用 toISOString() —— 那是 UTC,
// 东八区会把下午 5 点的文章显示成上午 9 点,看着像凌晨发的。
function fmtTime(unixSec) {
  const d = new Date(unixSec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toMarkdown(sources) {
  const lines = [];
  for (const s of sources) {
    lines.push(`\n### ${s.name}`);
    if (s.err) {
      lines.push(`\n> 抓取失败:${s.err}\n`);
      continue;
    }
    if (!s.items.length) {
      lines.push('\n> 没有取到文章\n');
      continue;
    }
    lines.push('\n| 时间 | 标题 | 链接 |', '|---|---|---|');
    for (const it of s.items) {
      const t = fmtTime(it.t);
      lines.push(`| ${t} | ${it.title.replace(/\|/g, '\\|')} | [原文](${it.url}) |`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const cfg = loadConfig();

  if (has('--quota')) {
    const s = quota.status(cfg.statePath, cfg.maxRunsPerDay);
    console.log(`今日(${s.date})已抓 ${s.count}${s.max ? '/' + s.max : ''} 次`);
    return;
  }

  const session = await connectChrome({ port: cfg.chromePort, profileDir: cfg.chromeProfileDir });
  try {
    // --shelf / --add 只用书架接口,在微信读书首页就能调,不需要阅读器页
    if (has('--shelf') || has('--add')) {
      const tab = await getAnyWereadTab(session);

      if (has('--add')) {
        const inputs = argv.slice(argv.indexOf('--add') + 1).filter((a) => !a.startsWith('--'));
        if (!inputs.length) {
          console.error('用法:--add <公众号任意一篇文章的链接 或 MP_WXS_xxx> [更多...]');
          process.exitCode = 2;
          return;
        }
        const resolved = [];
        for (const input of inputs) {
          try {
            const r = await resolveBookId(input);
            console.error(`  解析成功:${r.bookId}${r.name ? ' (' + r.name + ')' : ''}  ← ${r.from}`);
            resolved.push(r.bookId);
          } catch (e) {
            console.error(`  解析失败:${e.message}`);
          }
        }
        if (!resolved.length) {
          process.exitCode = 1;
          return;
        }
        const res = await evaluate(session, tab, buildAddToShelfJs(resolved));
        const okAdd = /"succ"\s*:\s*1/.test(res) || /"errCode"\s*:\s*0/.test(res);
        console.error(okAdd ? `已加入书架:${resolved.join('、')}` : `订阅接口返回:${res.slice(0, 200)}`);
      }

      const books = await readShelf(session, tab);
      console.log(JSON.stringify(books, null, 2));
      console.error(
        `\n共 ${books.length} 个公众号。把想监控的 name/bookId 粘进 config.json 的 accounts 即可。`
      );
      return;
    }

    const targetId = await getReaderTab(session, cfg);


    // 先探针,再决定要不要发业务请求。探针不消耗额度,所以放在闸门前面。
    const state = await probeUntilReady(session, targetId);
    if (has('--probe')) {
      console.log(JSON.stringify(state, null, 2));
      if (state.verdict !== 'ready') console.error('\n' + explain(state));
      return;
    }
    if (state.verdict !== 'ready') {
      console.error(`无法抓取(${state.verdict}):${explain(state)}`);
      process.exitCode = 1;
      return;
    }

    const q = quota.check(cfg.statePath, cfg.maxRunsPerDay);
    if (!q.ok) {
      console.error(
        `今日已抓 ${q.count}/${q.max} 次,达到上限,本次跳过。\n` +
          '这个上限是防风控用的。要调整改 config.json 的 maxRunsPerDay(设 0 表示不限)。'
      );
      process.exitCode = 3;
      return;
    }

    if (!cfg.accounts.length) {
      console.error('config.json 里还没有配置任何公众号。先跑 `--shelf` 看看有哪些 bookId 可用。');
      process.exitCode = 2;
      return;
    }

    const js = buildFetchJs(cfg.accounts, cfg.requestIntervalMs);
    const raw = await evaluate(session, targetId, js);
    const result = JSON.parse(raw);

    const failed = result.sources.filter((s) => s.err);
    if (failed.length === result.sources.length) {
      console.error('全部公众号都抓取失败,不计入今日次数:');
      for (const f of failed) console.error(`  ${f.name}: ${f.err}`);
      console.error('\n若错误是 -2041,说明请求没发在阅读器页上下文;若是 -2010,说明登录已失效,重新扫码即可。');
      process.exitCode = 1;
      return;
    }

    quota.commit(cfg.statePath);
    console.log(has('--format') && val('--format') === 'md' ? toMarkdown(result.sources) : JSON.stringify(result, null, 2));
    if (failed.length) {
      console.error(`\n注意:${failed.length} 个公众号抓取失败(${failed.map((f) => f.name).join('、')})`);
    }
  } finally {
    session.close();
  }
}

main().then(
  () => process.exit(process.exitCode || 0),
  (e) => {
    console.error('出错了:', e.message);
    process.exit(1);
  }
);
