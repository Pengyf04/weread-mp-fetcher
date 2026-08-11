// 每日抓取闸门。
//
// 为什么要有这个:微信读书对文章接口有风控。作者在验证方案那天一天里请求了
// 30 多次,直接触发反爬,页面白屏好几个小时。**"写在文档里的纪律"约束不住人,
// 也约束不住 AI**,所以做成执行前必须通过的硬闸门。
//
// 两道闸门,语义互不干扰:
//   1. maxRunsPerDay      —— 「一次不算全败的抓取运行」记 1 次。**语义与最初一样,一个字没改。**
//   2. maxRequestsPerDay  —— 纯增量的第二道:按 号数 × pages 预估,超预算就拒绝。
//      加它的理由:额度计的是"次",风控看的是"请求",两者脱钩时账本反映不了真实敞口。
//      ⚠️ 它的默认值 40 是**选定值,不是实测出来的安全阈值**。唯一的参照点是
//         "原作者 30+ 请求触发过一次反爬"这条一手观察 —— 那不是已知阈值,别当安全线用。
//
// 账本存在本机文件里,不进仓库,跨天自动归零。格式:
//   {date, count, requests:{articles, shelf}}
// 老账本(只有 {date,count})读进来缺的字段按 0 算;新账本被老代码读到时,
// 多出来的字段会被原样忽略 —— 两个方向都不会坏。

import fs from 'node:fs';
import path from 'node:path';

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 归一化:补齐缺失字段,但**不丢弃**账本里已有的其它键 */
function normalize(d) {
  const r = d.requests || {};
  return {
    ...d,
    date: d.date,
    count: Number(d.count) || 0,
    requests: { articles: Number(r.articles) || 0, shelf: Number(r.shelf) || 0 },
  };
}

const fresh = () => ({ date: today(), count: 0, requests: { articles: 0, shelf: 0 } });

function read(statePath) {
  try {
    const d = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return d.date === today() ? normalize(d) : fresh();
  } catch {
    return fresh();
  }
}

function write(statePath, data) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  // 先写临时文件再原子替换,进程被中断也不会留下半个 JSON
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, statePath);
}

/** 第一道闸门:还能不能抓。maxPerDay <= 0 表示不限制。 */
export function check(statePath, maxPerDay) {
  const d = read(statePath);
  if (!maxPerDay || maxPerDay <= 0) return { ok: true, count: d.count, max: 0 };
  return { ok: d.count < maxPerDay, count: d.count, max: maxPerDay };
}

/**
 * 第二道闸门:今天的请求预算还够不够发 need 个请求。
 * maxRequestsPerDay <= 0 表示不限制。**只读,不写。**
 */
export function checkRequests(statePath, maxRequestsPerDay, need) {
  const d = read(statePath);
  const used = d.requests.articles + d.requests.shelf;
  const want = Number(need) || 0;
  if (!maxRequestsPerDay || maxRequestsPerDay <= 0) {
    return { ok: true, used, max: 0, need: want, remaining: Infinity };
  }
  const remaining = maxRequestsPerDay - used;
  return { ok: want <= remaining, used, max: maxRequestsPerDay, need: want, remaining };
}

/**
 * 抓取成功后记一次。
 * @param {{articles?:number, shelf?:number}} requests 本次**实际发出**的请求数,不是预估值
 */
export function commit(statePath, requests = {}) {
  const d = read(statePath);
  d.count += 1;
  d.requests.articles += Number(requests.articles) || 0;
  d.requests.shelf += Number(requests.shelf) || 0;
  write(statePath, d);
  return d.count;
}

export function status(statePath, maxPerDay, maxRequestsPerDay) {
  const d = read(statePath);
  return {
    date: d.date,
    count: d.count,
    max: maxPerDay || 0,
    requests: { ...d.requests, used: d.requests.articles + d.requests.shelf, max: maxRequestsPerDay || 0 },
  };
}
