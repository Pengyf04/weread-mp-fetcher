// 落盘:把渲染好的文本写进文件(UTF-8,无 BOM)。
//
// 为什么不让用户自己 `> x.md`:一是 stderr 的提示和 stdout 的内容混在同一个终端里,
// 重定向时容易搞混;二是有的 shell 的 `>` 默认不是 UTF-8,中文会变乱码。
// 直接 writeFileSync(..., 'utf8') 从根上绕开 shell 的编码差异。

import fs from 'node:fs';
import path from 'node:path';

// ★ 唯一的尾换行归一化点。--out 路径与 stdout 路径都必须经过它,
//   这样"文件字节流 === 不加 --out 时终端收到的字节流"才是结构性成立的,
//   而不是靠"渲染器恰好不产生尾换行"这种偶然性质。
export const normalizeOut = (text) => (text.endsWith('\n') ? text : text + '\n');

export function writeText(file, text) {
  const body = normalizeOut(text);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return {
    bytes: Buffer.byteLength(body, 'utf8'),
    lines: (body.match(/\n/g) || []).length, // ★ 行数 ≡ '\n' 个数 ≡ wc -l
  };
}
