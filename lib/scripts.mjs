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
 * 抓取脚本 —— 逐个公众号取最新文章。
 *
 * ⚠️ 必须在阅读器页(/web/mp/reader/<hash>)的上下文里执行。
 *    在微信读书首页发同样的请求会返回 -2041,那不是限流,是上下文校验。
 *
 * @param {Array<{name:string, bookId:string}>} accounts
 * @param {number} intervalMs 每个号之间的间隔,别调太小
 */
export function buildFetchJs(accounts, intervalMs = 3000) {
  const list = JSON.stringify(accounts.map((a) => [a.name, a.bookId]));
  return `(function(){
  var MPS = ${list};
  var GAP = ${Number(intervalMs)};

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
          url: mi.originalId ? ('https://mp.weixin.qq.com/s/' + mi.originalId) : '',
          rid: r.reviewId || ''
        });
      });
    });
    out.sort(function(a,b){ return b.t - a.t; });
    return out;
  }

  function one(i, acc){
    if (i >= MPS.length) return Promise.resolve(acc);
    return fetch('/web/mp/articles?bookId=' + MPS[i][1] + '&offset=0', {credentials:'include'})
      .then(function(r){ return r.json(); })
      .then(function(o){
        if (o.errCode) acc.push({name:MPS[i][0], bookId:MPS[i][1], err:'errCode=' + o.errCode});
        else acc.push({name:MPS[i][0], bookId:MPS[i][1], items:flatten(o)});
      })
      .catch(function(e){ acc.push({name:MPS[i][0], bookId:MPS[i][1], err:String(e).slice(0,80)}); })
      .then(function(){
        return new Promise(function(ok){ setTimeout(function(){ one(i+1, acc).then(ok); }, GAP); });
      });
  }

  return one(0, []).then(function(a){
    return JSON.stringify({onReader: location.pathname.indexOf('/web/mp/reader/') === 0, sources: a});
  });
})()`;
}

/** 列出当前账号在微信读书里已收藏的公众号,用来找 bookId */
export const LIST_SHELF_JS = `fetch("/web/shelf/sync?synckey=0&teenmode=0&album=1",{credentials:"include"})
  .then(function(r){return r.json()})
  .then(function(o){
    return JSON.stringify((o.books||[])
      .filter(function(b){ return String(b.bookId||"").indexOf("MP_WXS_") === 0 })
      .map(function(b){ return {name:b.title, bookId:b.bookId} }));
  })`;
