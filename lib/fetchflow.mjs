// 翻页调度 —— 纯 Node 逻辑,**零网络、零 CDP 依赖**。
//
// 为什么翻页循环在 Node 侧而不在页内:
//   · 页内循环时 4 个号 × 10 页 × 3s 会超过 evaluate 的 90s 超时,得给 CDP 打动态超时补丁;
//     Node 侧每次 evaluate 只做一个 fetch,远低于 90s,lib/cdp.mjs 一行都不用动。
//   · 第 3 页失败时,前 2 页的数据**已经在 Node 手上**,部分失败是自然结果,不用额外契约带出来。
//   · 翻页/去重/GAP/部分失败全变成纯函数,用假 run / 假 sleep 就能做行为测试。
//
// ⚠️ 纯度是硬约束:本文件内部**绝不做任何 CDP 动作,尤其绝不刷新页面**。
//    -2041 的处理全部在 bin 层、在 fetchAll 返回**之后**做(见 diagnose2041)。

/**
 * source 的四种形状(互斥),不变式:**err ⟺ 该号零数据**
 *   1. 第 0 页就失败            → {name, bookId, err}                     ← 与改动前同形
 *   2. 第 k≥1 页失败            → {name, bookId, items, pageMeta, partialErr, pagesFetched:k}
 *   3. 全部成功 / 提前无更多    → {name, bookId, items, pageMeta, pagesFetched}
 *   4. run() 自己抛错(CDP 层)  → 按页号映射进 1 或 2,**不新造第四种结构**
 *
 * @param run   (bookId, offset) => Promise<解析后的对象>  生产环境注入 evaluate+JSON.parse
 * @param sleep (ms) => Promise                            测试注入立即 resolve
 */
export async function fetchAll({ accounts, pages, gapMs, run, sleep, maxConsecutiveThrows = 2 }) {
  const sources = [];
  let requestsTotal = 0;
  let onReader = null;
  let consecutiveThrows = 0;
  let tripped = false; // 熔断器已跳闸

  for (const acc of accounts) {
    if (tripped) {
      // 未尝试的号确实零数据 → 记 err(不是 partialErr),守住 err ⟺ 零数据 这条不变式
      sources.push({ name: acc.name, bookId: acc.bookId, err: '未尝试:上游连续失败' });
      continue;
    }

    let offset = 0; // ★★ 必须在【号循环内】声明并归零。写到外面 → 第 2 个号从 offset=20 起跑,
    //                  连 pages=1 都会漏掉每个号最新的一整页群发,而输出看上去完全正常。
    const pageMeta = [];
    const items = [];
    const seen = new Set();
    let fetched = 0;
    let err;
    let partialErr;

    for (let k = 0; k < pages; k++) {
      // GAP 加在**每两个请求之间**(跨页也跨号统一计数),最后一个请求之后不等;
      // 因异常提前结束的号,其后也不补等待。
      if (requestsTotal > 0) await sleep(gapMs);

      let page;
      requestsTotal++; // 抛错的那一次也算:请求很可能已经发出去了,只是结果没回来
      try {
        page = await run(acc.bookId, offset);
        consecutiveThrows = 0; // 成功即清零
      } catch (e) {
        consecutiveThrows++;
        const msg = 'evaluate 失败:' + String((e && e.message) || e).slice(0, 80);
        if (fetched === 0) err = msg;
        else partialErr = msg;
        break;
      }

      if (!page || page.ok !== true) {
        // ⚠️ 文案钉死:下游(-2041 分支、bin 的错误码提示)要能从文本里认出错误码
        const msg =
          page && page.errCode !== undefined && page.errCode !== null
            ? 'errCode=' + page.errCode
            : (page && page.err) || '页面返回了无法识别的结果';
        if (fetched === 0) err = msg;
        else partialErr = msg;
        break;
      }

      fetched++;
      if (onReader === null && page.onReader !== undefined) onReader = page.onReader;

      const reviews = Number(page.reviews) || 0;
      const pageItems = page.items || [];
      pageMeta.push({
        offset,
        reviews,
        items: pageItems.length,
        oldest: pageItems.length ? pageItems.reduce((m, it) => Math.min(m, it.t), Infinity) : null,
      });

      for (const it of pageItems) {
        // ⚠️ 去重键 = url || rid || null。**键为 null 的不参与去重**:
        //    url 和 rid 都可能是空串(flatten 只要求 title 非空),
        //    用 url||rid 会把它们全算成 '' → 塌缩成一条 → 静默丢文章。
        //    也**绝不能按时间戳去重**:同一次群发里所有文章的 createTime 完全相同。
        const key = it.url || it.rid || null;
        if (key === null) {
          items.push(it);
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(it);
      }

      offset += reviews; // 累加该页**实际返回**的群发条数,不是硬编码 += 20
      if (reviews === 0) break; // 没有更多了,提前停 —— 不算失败
    }

    if (fetched === 0) {
      sources.push({ name: acc.name, bookId: acc.bookId, err: err || '没有取到任何一页' });
    } else {
      items.sort((a, b) => b.t - a.t);
      const s = { name: acc.name, bookId: acc.bookId, items, pageMeta, pagesFetched: fetched };
      if (partialErr) s.partialErr = partialErr;
      sources.push(s);
    }

    if (consecutiveThrows >= maxConsecutiveThrows) tripped = true;
  }

  return { onReader, meta: { pages, requestsTotal }, sources };
}

/** 结果里有没有 -2041。文案由 fetchAll 钉死为 errCode=<n>,这里就是它的消费方。 */
export const has2041 = (result) =>
  result.sources.some((s) => String(s.err || s.partialErr || '').includes('errCode=-2041'));

/**
 * 抓完之后的 -2041 出错路径:刷新阅读器页 → 重探 → (仅全失败时)问一次书架 → 陈述观察。
 *
 * ⚠️ 本函数**自己不做任何 CDP 动作**,三个依赖全部由 bin 层注入。它跑在 fetchAll
 *    **返回之后**,所以"刷新后不自动重发任何业务请求"是结构性成立的 —— 数据已经在手,
 *    没有可重发的东西。
 * ⚠️ 顺序不可调换:readShelf 必须在探针之后 —— 刷新会销毁页面的执行上下文,
 *    页面没就绪时 evaluate 会失败。
 * ⚠️ 它**不改变 failed 的计算,也不改变 quota.commit 的触发条件**。
 *
 * @returns null(没有 -2041) 或 {reloadNote, probeVerdict, shelfSignal}
 */
export async function diagnose2041(result, { reloadTab, probeUntilReady, readShelf }) {
  if (!has2041(result)) return null;

  let reloadNote = '已刷新';
  try {
    await reloadTab();
  } catch (e) {
    reloadNote = '刷新失败:' + ((e && e.message) || e); // 刷新失败不影响后续流程
  }

  let probeVerdict = '未知';
  try {
    const p = await probeUntilReady();
    probeVerdict = (p && p.verdict) || '未知';
  } catch (e) {
    probeVerdict = '探针失败:' + ((e && e.message) || e);
  }

  // 只在**全部号都失败**时才花这 1 个书架请求:部分号成功时,"账号还好着"
  // 已经由那些成功的号自证了。全失败本来就不计额度,所以记账语义零变化。
  let shelfSignal = '未检查';
  if (result.sources.filter((s) => s.err).length === result.sources.length) {
    try {
      const rows = await readShelf();
      shelfSignal = Array.isArray(rows) ? '可用' : '不可用';
    } catch {
      shelfSignal = '不可用';
    }
  }

  return { reloadNote, probeVerdict, shelfSignal };
}

/**
 * 陈述式文案。措辞是设计的一部分,不是文案润色:
 * 只许「观察到」「判定为」,**不许**出现「原因是」「因为」「说明被限流」。
 * 最后那句"不下结论"必须保留 —— -2041 已知不止一种成因,而刷新这个动作
 * 同时改变了多个变量(页面上下文重置 + 验证码可能显形),因果没法从这里推出来。
 */
export function format2041Note({ reloadNote, probeVerdict, shelfSignal }) {
  return (
    '接口返回 -2041。已自动刷新阅读器页并重探,观察到:\n' +
    `  · 刷新阅读器页: ${reloadNote}\n` +
    `  · 刷新后探针判定: ${probeVerdict}\n` +
    `  · 书架接口 /web/shelf/sync: ${shelfSignal}   ← 可用说明登录态还在\n` +
    '建议: 切到 Chrome 看一眼阅读器页;若探针报 captcha 就手动过一下验证码,过完重跑本命令。\n' +
    '本工具不对 -2041 的原因下结论 —— 已知它不止一种成因,且刷新这个动作同时改变了多个变量。'
  );
}
