// 每日抓取次数闸门。
//
// 为什么要有这个:微信读书对文章接口有风控。作者在验证方案那天一天里请求了
// 30 多次,直接触发反爬,页面白屏好几个小时。**"写在文档里的纪律"约束不住人,
// 也约束不住 AI**,所以做成执行前必须通过的硬闸门。
//
// 计数存在本机文件里,不进仓库。跨天自动归零。

import fs from 'node:fs';
import path from 'node:path';

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function read(statePath) {
  try {
    const d = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return d.date === today() ? d : { date: today(), count: 0 };
  } catch {
    return { date: today(), count: 0 };
  }
}

function write(statePath, data) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  // 先写临时文件再原子替换,进程被中断也不会留下半个 JSON
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, statePath);
}

/** 还能不能抓。maxPerDay <= 0 表示不限制。 */
export function check(statePath, maxPerDay) {
  const d = read(statePath);
  if (!maxPerDay || maxPerDay <= 0) return { ok: true, count: d.count, max: 0 };
  return { ok: d.count < maxPerDay, count: d.count, max: maxPerDay };
}

/** 抓取成功后记一次 */
export function commit(statePath) {
  const d = read(statePath);
  d.count += 1;
  write(statePath, d);
  return d.count;
}

export function status(statePath, maxPerDay) {
  const d = read(statePath);
  return { date: d.date, count: d.count, max: maxPerDay || 0 };
}
