// 命令行参数解析(极简)。
//
// 抽成模块的原因:原来它们闭包在 bin/weread.mjs 的模块级 argv 上,
// 离线测试没法直接调 —— 而"--out 后面跟的是不是另一个 flag"这种事必须能被测到。

/** flag 是否存在 */
export const has = (argv, f) => argv.includes(f);

/**
 * 取 flag 的值。**必须带值**的参数用它(--config / --format / --pages)。
 * ⚠️ 它会把紧跟其后的任意 token 当成值,包括另一个 flag:
 *    ['--format','--probe'] → '--probe'。要区分"给了 flag 没给值"请用 valOpt。
 */
export const val = (argv, f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

/**
 * 取**值可省略**的 flag(--out)。三态:
 *   flag 不存在                          → undefined
 *   flag 存在,但后面没 token 或以 -- 开头 → d(默认标记)
 *   否则                                  → 该 token
 */
export function valOpt(argv, f, d) {
  const i = argv.indexOf(f);
  if (i < 0) return undefined;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) return d;
  return next;
}
