// 注入到微信读书页面里执行的两段 JS。
//
// 之所以是「字符串拼出来」而不是独立 .js 文件:它们不在 Node 里跑,
// 而是被送进浏览器标签页执行,需要把配置(公众号列表、请求间隔)先烘焙进去。

/**
 * 页面状态探针 —— 决定「现在能不能抓」。
 *
 * 只读页面状态,不发任何业务请求,所以随便跑、不消耗每日额度。
 *
 * 返回 verdict:
 *   ready   → 可以抓
 *   captcha → 弹了验证码,交给用户手动完成(见 README「验证码」一节)
 *   loading → 还在加载/验证码正在准备,等几秒重探
 *   blank   → 页面被拦截,本轮放弃
 */
export const PROBE_JS = `(function(){
  var txt = (document.body && document.body.innerText || '').replace(/\\s+/g,' ').trim();
  var title = document.title || '';
  var onReader = location.pathname.indexOf('/web/mp/reader/') === 0;

  // 腾讯防水墙(TCaptcha)的节点。
  // ⚠️ 别写死 #tcaptcha_iframe 这类"看起来标准"的 id —— 实测真实 id 带 _dy 后缀
  //    (tcaptcha_iframe_dy / tcaptcha_wrapper_transform_dy),精确 id 一个都匹配不上。
  var capSel = '[id*="captcha"], [class*="tcaptcha"], iframe[src*="captcha"]';

  // ⚠️ 只认**仍然可见**的节点。验证码过关后 TCaptcha 不删 DOM,只把父容器透明掉:
  //    实测 iframe 自身 opacity:1 看着可见,是它的父 DIV opacity:0。
  //    只用 querySelector 判存在性 → 验证码过完之后会永远被判成 captcha,再也抓不了。
  var capVisible = [].slice.call(document.querySelectorAll(capSel)).some(function(n){
    for (var cur = n; cur; cur = cur.parentElement) {
      var s = getComputedStyle(cur);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    }
    var r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });

  // ⚠️ 验证码弹出前,页面会先把 TCaptcha 加载进来。实测开标签页后轮询 30 秒全是
  //    loading,验证码在那之后约 10 秒才弹 —— 但那 30 秒里 window.TencentCaptcha
  //    早就是 function 了。没这个旗标就会把"马上要弹验证码"误判成"被拦截了"。
  var capArming = typeof window.TencentCaptcha === 'function';

  var verdict;
  if (capVisible)                verdict = 'captcha';
  else if (!onReader)            verdict = 'wrong_page';
  else if (/公众号/.test(title)) verdict = 'ready';
  else if (capArming)            verdict = 'loading';
  else if (txt.length < 50)      verdict = 'loading';
  else                           verdict = 'blank';

  return JSON.stringify({
    verdict: verdict, title: title, len: txt.length,
    capArming: capArming, onReader: onReader
  });
})()`;

/**
 * 抓取脚本 —— 取**某个公众号的某一页**文章。一次调用 = 一个 fetch,不含循环、不含间隔。
 *
 * 翻页、间隔、去重、部分失败都在 Node 侧(lib/fetchflow.mjs)做,这里只负责发一次请求。
 *
 * ⚠️ 必须在阅读器页(/web/mp/reader/<hash>)的上下文里执行。
 *    在微信读书首页发同样的请求会返回 -2041,那不是限流,是上下文校验。
 *
 * ⚠️ 只发 offset,**不发 count、不发 maxIdx**。实测这两个参数被服务端忽略:
 *    offset=0 / offset=0&count=50 / maxIdx=20 三种请求返回**逐字段一致**。
 *    第三方项目 weread.koplugin 用的是 maxIdx=0&count=100,照抄它会翻车。
 *
 * ⚠️ 三条返回路径都必须以 JSON.stringify 收尾。evaluate 用的是
 *    {awaitPromise:true, returnByValue:true},页内 resolve 成对象的话 CDP 会按值
 *    反序列化回来,Node 侧 JSON.parse(对象) 会当场 SyntaxError。
 *
 * @param {string} bookId
 * @param {number} offset 已经跳过的**群发条数**(不是文章篇数)
 */
export function buildPageJs(bookId, offset) {
  const url = `/web/mp/articles?bookId=${encodeURIComponent(String(bookId))}&offset=${Number(offset) || 0}`;
  return `(function(){
  function flatten(o){
    var out = [];
    (o.reviews || []).forEach(function(grp){
      // ⚠️ 一次群发 = 一个 reviews 条目,里面的 subReviews 才是一篇篇文章。
      //    只取 subReviews[0] 会丢掉同一次群发的其余文章(高频错误,有的号一天 3-4 篇)。
      (grp.subReviews || []).forEach(function(s){
        var r = s.review || {}, mi = r.mpInfo || {};
        if (!mi.title) return;
        out.push({
          t: r.createTime || grp.createTime || 0,
          title: mi.title,
          // ⚠️ 微信读书把 originalId 里的 base64url 下划线编码成 ~(它的 rid 用 _ 做
          //    分隔符,MP_WXS_<数字>_<id>)。不还原的话微信侧报「参数错误」,链接打不开。
          url: mi.originalId ? ('https://mp.weixin.qq.com/s/' + mi.originalId.replace(/~/g, '_')) : '',
          rid: r.reviewId || ''
        });
      });
    });
    out.sort(function(a,b){ return b.t - a.t; });
    return out;
  }

  return fetch(${JSON.stringify(url)}, {credentials:'include'})
    .then(function(r){ return r.json(); })
    .then(function(o){
      return JSON.stringify(o.errCode
        ? {ok:false, errCode:o.errCode}
        : {ok:true,
           onReader: location.pathname.indexOf('/web/mp/reader/') === 0,
           reviews: (o.reviews || []).length,
           items: flatten(o)});
    })
    .catch(function(e){ return JSON.stringify({ok:false, err:String(e).slice(0,80)}); });
})()`;
}

/**
 * 列出当前账号在微信读书里已订阅的公众号。
 *
 * 关键:返回里顺带给出每个号的 **readerUrl**。
 * 书架接口每个条目都带 deepLink,形如 `.../book-detail?type=1&v=<hash>`,
 * 而这个 `v` 和阅读器页 URL 尾部的那串 hash **完全相同**(实测逐字符一致)。
 * 所以 readerUrl = "https://weread.qq.com/web/mp/reader/" + v。
 *
 * 这条发现让用户不必再手动去浏览器地址栏复制 URL。
 * ⚠️ 那串 hash 不能自己拼:前后缀是**每个号各不相同**的校验位
 *    (实测同一账号下四个号的前缀两两不同,后缀也不同),
 *    照着一个号的前后缀给另一个号拼出来的 URL 打开是「加载失败」。
 *
 * 本接口在微信读书**首页**就能调用,不需要阅读器页上下文。
 *
 * ⚠️ 返回契约与 buildPageJs 同口径:成功 {ok:true, books:[…]},接口出错 {ok:false, errCode},
 *    页内异常 {ok:false, err}。三条路径都以 JSON.stringify 收尾(理由见 buildPageJs 的注释)。
 *    必须先查 errCode 再碰 books:接口出错(如 -2041 会话未续期)时响应里没有 books,
 *    直接 (o.books||[]) 兜底会把「接口出错」静默装成「空书架」,Node 侧就会把登录态问题
 *    误诊成「你没订阅任何号」(NEW-1,2026-08-11 真实撞上过)。
 */
export const LIST_SHELF_JS = `fetch("/web/shelf/sync?synckey=0&teenmode=0&album=1",{credentials:"include"})
  .then(function(r){return r.json()})
  .then(function(o){
    if (o.errCode) return JSON.stringify({ok:false, errCode:o.errCode});
    return JSON.stringify({ok:true, books:(o.books||[])
      .filter(function(b){ return String(b.bookId||"").indexOf("MP_WXS_") === 0 })
      .map(function(b){
        var m = String(b.deepLink||"").match(/[?&]v=([^&]+)/);
        return {
          name: b.title,
          bookId: b.bookId,
          readerUrl: m ? ("https://weread.qq.com/web/mp/reader/" + m[1]) : null
        };
      })});
  })
  .catch(function(e){ return JSON.stringify({ok:false, err:String(e).slice(0,80)}) })`;

/**
 * 把公众号加进书架(订阅)。同样在首页就能调用。
 * 重复添加已在书架里的号是幂等的,不会出错。
 *
 * 返回契约与其他注入脚本同口径:成功 {ok:true, body:<原始响应文本>},
 * 页内异常(网络抖动等) {ok:false, err}。两条路径都以 JSON.stringify 收尾 ——
 * 没有 .catch 的话,fetch reject 会让 evaluate 直接抛错,穿透到顶层报一句
 * 看不懂的错,已解析好的 bookId 也全被丢弃。
 */
export function buildAddToShelfJs(bookIds) {
  return `fetch("/mp/shelf/addToShelf",{
    method:"POST", credentials:"include",
    headers:{"Content-Type":"application/json;charset=UTF-8"},
    body: JSON.stringify({bookIds: ${JSON.stringify(bookIds)}})
  }).then(function(r){ return r.text() })
  .then(function(t){ return JSON.stringify({ok:true, body:t}) })
  .catch(function(e){ return JSON.stringify({ok:false, err:String(e).slice(0,80)}) })`;
}
