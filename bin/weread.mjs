#!/usr/bin/env node
// weread-mp-fetcher —— 通过微信读书取公众号最新文章
//
// 用法:
//   node bin/weread.mjs                 抓取(默认输出 JSON)
//   node bin/weread.mjs --format md     输出 Markdown 表格
//   node bin/weread.mjs --out [路径]    写进文件而不是 stdout(省略路径=out/weread-<时间戳>.md|json)
//   node bin/weread.mjs --pages N       每个号翻 N 页(1 页 ≈ 20 次群发 ≈ 70-80 篇),默认 1
//   node bin/weread.mjs --probe         只看页面状态,不抓取(免费,不消耗额度)
//   node bin/weread.mjs --shelf         列出你已订阅的公众号及其 bookId
//   node bin/weread.mjs --add <链接|bookId>...  订阅公众号(可给文章链接,自动算出 bookId)
//   node bin/weread.mjs --quota         查看今日已抓次数
//   node bin/weread.mjs --config x.json 指定配置文件

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { connectChrome, listTabs, createTab, evaluate, reloadTab } from '../lib/cdp.mjs';
import { PROBE_JS, buildPageJs, LIST_SHELF_JS, buildAddToShelfJs } from '../lib/scripts.mjs';
import { resolveBookId } from '../lib/mp.mjs';
import * as quota from '../lib/quota.mjs';
import { has, val, valOpt } from '../lib/args.mjs';
import { toMarkdown, fmtStamp } from '../lib/render.mjs';
import { normalizeOut, writeText } from '../lib/save.mjs';
import { fetchAll, diagnose2041, format2041Note } from '../lib/fetchflow.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);

function loadConfig() {
  const file = path.resolve(val(argv, '--config', path.join(ROOT, 'config.json')));
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
  if (cfg.chromeProfileDir) cfg.chromeProfileDir = cfg.chromeProfileDir.replace(/^~/, os.homedir());
  cfg.maxRunsPerDay = cfg.maxRunsPerDay ?? 2;
  cfg.requestIntervalMs = cfg.requestIntervalMs ?? 3000;
  cfg.outDir = cfg.outDir || 'out';
  cfg.maxRequestsPerDay = cfg.maxRequestsPerDay ?? 40;
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

// valOpt 的"给了 --out 但没给值"标记。用 Symbol 而不是"某个用户敲不出来的字符串":
// 后者要么可能撞车,要么得往源码里塞控制字符 —— 塞了 git 会把整个文件当二进制,diff 就没了。
const OUT_DEFAULT = Symbol('out-default');

/**
 * 算出 --out 要写到哪。返回 undefined 表示没给 --out(走 stdout)。
 *
 * ⚠️ 两条相对路径的基准**故意不同**:
 *   config 里的 outDir(常设默认)相对**仓库根**,与 .gitignore 的 out/ 对齐;
 *   --out <相对路径>(你当场敲的)相对 **cwd**,符合命令行直觉。
 */
function resolveOutPath(cfg, fmt) {
  const v = valOpt(argv, '--out', OUT_DEFAULT);
  if (v === undefined) return undefined;
  const name = `weread-${fmtStamp(new Date())}.${fmt}`;
  if (v === OUT_DEFAULT) return path.join(path.resolve(ROOT, cfg.outDir || 'out'), name);
  const p = path.resolve(process.cwd(), v);
  // 指到一个已存在的目录 → 在里面用默认文件名
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return path.join(p, name);
  return p;
}

async function main() {
  const cfg = loadConfig();

  if (has(argv, '--quota')) {
    const s = quota.status(cfg.statePath, cfg.maxRunsPerDay, cfg.maxRequestsPerDay);
    const r = s.requests;
    console.log(
      `今日(${s.date})已抓 ${s.count}${s.max ? '/' + s.max : ''} 次;` +
        `请求 ${r.used}${r.max ? '/' + r.max : '(不限)'}(文章 ${r.articles},书架 ${r.shelf})`
    );
    return;
  }

  // --pages 只做命令行参数,**不读 cfg.pages** —— 放 config 里容易被忘掉,
  // 某天你只是想快速看一眼,却发出了十几个请求。放命令行上强制每次明示。
  const pages = Number(val(argv, '--pages', '1'));
  if (!Number.isInteger(pages) || pages < 1) {
    console.error(`--pages 要是个正整数,收到的是:${val(argv, '--pages', '1')}`);
    process.exitCode = 2;
    return;
  }

  // ★ 上限闸门。位置有讲究:
  //   在 --quota **之后** —— 否则 config 里写了超限值的用户连账本都查不了;
  //   在 connectChrome **之前** —— 让"超限"这件事零连接、零请求、零额度就能拒绝,
  //   也让"闸门是不是真的在请求之前"变得可证伪(报的是闸门文案还是连接错误)。
  // --shelf / --add / --probe 的处理在 connectChrome 之后,所以豁免必须显式写出来。
  const isFetchRun = !has(argv, '--shelf') && !has(argv, '--add') && !has(argv, '--probe');
  const maxPages = cfg.maxPagesPerRun ?? 3;
  if (isFetchRun && pages > maxPages) {
    console.error(
      `--pages ${pages} 超过上限 ${maxPages},拒绝执行。\n` +
        '  1 页 ≈ 20 次群发 ≈ 70–80 篇(因号而异),每页每号都是一个真实请求。\n' +
        '  要调整改 config.json 的 maxPagesPerRun。'
    );
    process.exitCode = 2;
    return;
  }

  // 第二道闸门:今日请求预算。按 号数 × pages 预估,同样放在连接之前(零连接零请求)。
  // maxRunsPerDay 的语义完全不变,这是纯增量的一道,不替换它。
  if (isFetchRun && cfg.accounts.length) {
    const need = cfg.accounts.length * pages;
    const rq = quota.checkRequests(cfg.statePath, cfg.maxRequestsPerDay, need);
    if (!rq.ok) {
      console.error(
        `今日请求预算不够:已用 ${rq.used}/${rq.max},剩余 ${rq.remaining},本次需要 ${need},拒绝执行。\n` +
          '  预算是防风控用的,改 config.json 的 maxRequestsPerDay(设 0 表示不限)。'
      );
      process.exitCode = 3;
      return;
    }
    console.error(`预计 ${need} 个请求,今日已用 ${rq.used}${rq.max ? '/' + rq.max : '(不限)'} —— 可以执行。`);
  }

  const session = await connectChrome({ port: cfg.chromePort, profileDir: cfg.chromeProfileDir });
  try {
    // --shelf / --add 只用书架接口,在微信读书首页就能调,不需要阅读器页
    if (has(argv, '--shelf') || has(argv, '--add')) {
      const tab = await getAnyWereadTab(session);

      if (has(argv, '--add')) {
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
    if (has(argv, '--probe')) {
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

    // 成本对用户可见:执行前就把"这一轮最多打几个请求"说清楚
    const gapMs = cfg.requestIntervalMs;
    const maxReq = cfg.accounts.length * pages;
    console.error(
      `本次最多发出 ${cfg.accounts.length} × ${pages} = ${maxReq} 个文章接口请求,` +
        `间隔 ${gapMs}ms,预计等待 ~${Math.round(((maxReq - 1) * gapMs) / 1000)}s(提前取完会更少)。`
    );

    const result = await fetchAll({
      accounts: cfg.accounts,
      pages,
      gapMs,
      // ★ 必须 async + await:evaluate 是 async,JSON.parse(Promise) 会当场 SyntaxError。
      //   JSON.parse 也要在 try 里 —— 页面回来的不是合法 JSON 时,它抛的错要和
      //   evaluate 抛的错走同一条通道,不能穿透 fetchAll。(try 在 fetchAll 内部)
      run: async (bookId, offset) =>
        JSON.parse(await evaluate(session, targetId, buildPageJs(bookId, offset))),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });

    const failed = result.sources.filter((s) => s.err);

    // -2041 出错路径:刷新阅读器页 → 重探 → (仅全失败时)问一次书架 → 陈述观察。
    // 刷新挂在这一层、且在 fetchAll 返回之后 —— fetchAll 内部绝不做 CDP 动作。
    // 这块不改变 failed 的计算,也不改变 quota.commit 的触发条件。
    const diag = await diagnose2041(result, {
      reloadTab: () => reloadTab(session, targetId),
      probeUntilReady: () => probeUntilReady(session, targetId),
      readShelf: () => readShelf(session, targetId),
    });
    if (diag) console.error(format2041Note(diag));

    if (failed.length === result.sources.length) {
      console.error('全部公众号都抓取失败,不计入今日次数:');
      for (const f of failed) console.error(`  ${f.name}: ${f.err}`);
      console.error('\n若错误是 -2041,说明请求没发在阅读器页上下文;若是 -2010,说明登录已失效,重新扫码即可。');
      process.exitCode = 1;
      return;
    }

    // 记的是**实际发出**的请求数,不是预估值。
    // shelf 这里写死 0,是**如实**而不是漏写:书架探测只发生在"全部号都失败"那一条路径上
    // (diagnose2041 里 U4.6 的触发条件,与上面那条 return 的条件是同一个表达式),
    // 而那条路径在上面就 return 了、本来就不计账。所以**能走到这一行的运行一定没探过书架**,
    // 从 diag 去推一个"有时会是 1"的数只会误导人。这条不变式由离线测试钉住。
    // ⚠️ 连带的已知账本口径:全失败那一轮的请求(含那 1 个书架探测)不进账本 ——
    //    这是"不改变记账语义"(U3.8)的代价,是知情的选择,不是遗漏。
    // ⚠️ 将来若把书架探测挪到别的路径上(或让全失败也记账),这里必须同步改回真实计数。
    quota.commit(cfg.statePath, { articles: result.meta.requestsTotal, shelf: 0 });

    // ★ 顺序:抓取 → 渲染(只发生一次) → 输出。两条输出路径共用同一个 normalizeOut,
    //   这样"文件字节流 === 不加 --out 时终端收到的字节流"是结构性成立的。
    const fmt = has(argv, '--format') && val(argv, '--format') === 'md' ? 'md' : 'json';
    const text = fmt === 'md' ? toMarkdown(result.sources) : JSON.stringify(result, null, 2);
    const itemsTotal = result.sources.reduce((n, s) => n + (s.items ? s.items.length : 0), 0);

    const outPath = resolveOutPath(cfg, fmt);
    if (outPath) {
      const existed = fs.existsSync(outPath);
      let st;
      try {
        st = writeText(outPath, text);
      } catch (e) {
        console.error(`写入失败:${outPath}\n  ${e.message}`);
        process.exitCode = 1;
        return;
      }
      if (existed) console.error(`已覆盖同名文件:${outPath}`);
      console.error(`已写入:${outPath}  (${st.bytes} 字节, ${st.lines} 行, 共 ${itemsTotal} 篇)`);
    } else {
      // 不用 console.log:它是**无条件**追加换行,与 writeText 的"没有才补"差一个字节
      process.stdout.write(normalizeOut(text));
      console.error(`共 ${itemsTotal} 篇`);
    }

    if (failed.length) {
      console.error(`\n注意:${failed.length} 个公众号抓取失败(${failed.map((f) => f.name).join('、')})`);
    }
    const partial = result.sources.filter((s) => s.partialErr);
    if (partial.length) {
      console.error(`注意:${partial.length} 个公众号部分失败(翻页翻到一半停了,已抓到的都在结果里)`);
      for (const p of partial) console.error(`  ${p.name}: 第 ${p.pagesFetched + 1} 页起 —— ${p.partialErr}`);
    }
  } finally {
    session.close();
  }
}

export { main };

// ★ 入口守卫:必须用 realpath 两侧比较,不能用 pathToFileURL(process.argv[1]) 对比 import.meta.url。
//   package.json 声明了 "bin",`npm i -g` / `npm link` 会在 PATH 里放一个**符号链接**;
//   而 ESM 主模块的 import.meta.url 已经过 realpath 解析,process.argv[1] 却原样保留链接路径
//   —— 用 URL 比较,全局安装的用户跑本命令会**静默什么都不做、还退出码 0**。
let isMain = false;
try {
  isMain =
    !!process.argv[1] &&
    fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
} catch {
  /* argv[1] 不存在/不可读(如 node --eval) → 视为非入口,不执行 main() */
}

if (isMain) {
  main().then(
    () => process.exit(process.exitCode || 0),
    (e) => {
      console.error('出错了:', e.message);
      process.exit(1);
    }
  );
}
