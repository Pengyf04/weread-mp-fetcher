// 渲染层:时间格式化 + Markdown 表格。
//
// ★ 本文件是**唯一的日期格式化实现**。任何地方要格式化日期,一律 import 这里的函数,
//   不许再写第二遍 —— 见下面 fmtTime 的注释,重复实现迟早有一处忘了"不能用 UTC"。

/** 入参:Date 或 unix 秒 */
const toDate = (t) => (t instanceof Date ? t : new Date(Number(t) * 1000));
const p = (n) => String(n).padStart(2, '0');

// 用本机时区格式化。不能用 toISOString() —— 那是 UTC,
// 东八区会把下午 5 点的文章显示成上午 9 点,看着像凌晨发的。
/** YYYY-MM-DD HH:MM —— md 表格里的**文章时间** */
export function fmtTime(t) {
  const d = toDate(t);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** YYYYMMDD-HHMM —— 默认 --out 文件名里的**运行时刻** */
export function fmtStamp(t) {
  const d = toDate(t);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function toMarkdown(sources) {
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
