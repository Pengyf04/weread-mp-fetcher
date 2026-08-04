// 从公众号文章链接推导 bookId。
//
// 原理:微信读书的 bookId = "MP_WXS_" + base64解码(公众号的 __biz)。
// 而 __biz 就写在该公众号**任意一篇文章**的页面里 —— 公开信息,不需要登录,
// 也不需要任何未公开的搜索接口。
//
// 这样用户想监控某个号时,只要随手发一篇它的文章链接过来就行,
// 不用先去微信读书里搜、也不用先订阅。

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 从一段文本(文章 HTML 或 URL)里抠出 __biz */
export function extractBiz(text) {
  const m =
    text.match(/var\s+biz\s*=\s*["']([A-Za-z0-9+/=]+)["']/) ||
    text.match(/__biz=([A-Za-z0-9+/=%]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** __biz → bookId。__biz 是 base64,解出来是一串数字。 */
export function bizToBookId(biz) {
  let decoded;
  try {
    decoded = Buffer.from(biz, 'base64').toString('utf8');
  } catch {
    return null;
  }
  // 正常解出来应该是纯数字;不是就说明这个 __biz 不对
  return /^\d+$/.test(decoded) ? `MP_WXS_${decoded}` : null;
}

/**
 * 输入可以是:
 *   - bookId              MP_WXS_1234567890        直接返回
 *   - 带 __biz 的文章链接  https://mp.weixin.qq.com/s?__biz=...   直接解析,不联网
 *   - 短链文章            https://mp.weixin.qq.com/s/xxxxx       需要抓一次页面
 */
export async function resolveBookId(input) {
  const s = String(input).trim();

  if (/^MP_WXS_\d+$/.test(s)) return { bookId: s, from: '直接给的 bookId' };

  const inlineBiz = extractBiz(s);
  if (inlineBiz) {
    const bookId = bizToBookId(inlineBiz);
    if (bookId) return { bookId, from: '链接里的 __biz' };
  }

  if (!/^https?:\/\//.test(s)) {
    throw new Error(`认不出来:${s}\n请给 bookId(MP_WXS_开头)或一篇该公众号的文章链接。`);
  }

  const res = await fetch(s, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`抓取文章页失败(HTTP ${res.status}):${s}`);
  const html = await res.text();

  const biz = extractBiz(html);
  if (!biz) {
    throw new Error(
      `这个页面里找不到 __biz:${s}\n` +
        '确认它是一篇公众号文章(mp.weixin.qq.com/s/...)。已被删除或需要验证的文章会解析失败。'
    );
  }
  const bookId = bizToBookId(biz);
  if (!bookId) throw new Error(`__biz 解码结果不像公众号 id:${biz}`);

  // 顺手把公众号名字也带出来,方便用户确认加对了号。
  // ⚠️ 别用 og:site_name,那是「微信公众平台」这种固定值,不是号名;
  //    og:article:author 拿到的是公众号简介。实测有效的是这两个:
  const nameMatch =
    html.match(/nickname\s*=\s*htmlDecode\(\s*["']([^"']+)["']/) ||
    html.match(/id=["']js_name["'][^>]*>\s*([^<]+?)\s*</);
  return { bookId, name: nameMatch ? nameMatch[1].trim() : null, from: '文章页里的 __biz' };
}
