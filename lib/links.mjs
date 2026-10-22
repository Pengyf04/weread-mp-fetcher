const reviewParts = rid => typeof rid === 'string' && rid.match(/^MP_WXS_(\d+)_[A-Za-z0-9_~-]+$/);
const normalizedTitle = title => title.replace(/\s+/g, ' ').trim();
const fail = reason => ({ ok: false, reason });

export function validateArticleMetadata(item, bookId, metadata) {
  const parts = reviewParts(item.rid);
  if (!parts || `MP_WXS_${parts[1]}` !== bookId) return fail('invalid_review_id');
  if (!metadata || metadata.ok !== true) return fail('invalid_response');
  if (typeof metadata.title !== 'string' || typeof item.title !== 'string' ||
      !normalizedTitle(metadata.title) || normalizedTitle(metadata.title) !== normalizedTitle(item.title)) {
    return fail('title_mismatch');
  }
  if (typeof metadata.url !== 'string') return fail('invalid_article_url');
  let parsed;
  try { parsed = new URL(metadata.url); } catch { return fail('invalid_article_url'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'mp.weixin.qq.com' ||
      parsed.pathname !== '/s' || parsed.username || parsed.password || parsed.port) {
    return fail('invalid_article_url');
  }
  const fields = {};
  for (const key of ['__biz', 'mid', 'idx', 'sn']) {
    const values = parsed.searchParams.getAll(key);
    if (values.length !== 1 || !values[0]) return fail('missing_article_field');
    fields[key] = values[0];
  }
  if (!/^[1-9]\d*$/.test(fields.mid) || !/^[1-9]\d*$/.test(fields.idx) || !/^[a-fA-F0-9]{32}$/.test(fields.sn)) {
    return fail('invalid_article_field');
  }
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(fields.__biz)) return fail('publisher_mismatch');
    const publisher = atob(fields.__biz);
    if (publisher !== parts[1] || btoa(publisher) !== fields.__biz) return fail('publisher_mismatch');
  } catch { return fail('publisher_mismatch'); }
  const url = new URL('https://mp.weixin.qq.com/s');
  for (const key of ['__biz', 'mid', 'idx', 'sn']) url.searchParams.set(key, fields[key]);
  return { ok: true, url: url.href };
}

const REASONS = {
  not_resolved: '尚未转链',
  invalid_review_id: '缺少合法且归属一致的 reviewId',
  conflicting_article: '同一 reviewId 的条目信息冲突',
  list_error: '列表阶段异常，本轮不继续请求单篇',
  page_not_ready: '阅读器页面未就绪',
  page_unavailable: '无法检查阅读器页面',
  verification_required: '页面出现验证码，请手动处理',
  verification_page: '响应是验证页面，请手动处理',
  record_failed: '无法记录转链尝试，已停止发送',
  content_unavailable: '单篇请求或 CDP 执行异常',
  http_error: '单篇接口拒绝请求',
  json_error: '单篇接口返回业务错误',
  timeout: '单篇请求超时',
  invalid_response: '单篇响应无法识别',
  invalid_input: '单篇响应不是有效文本',
  invalid_html: '单篇 HTML 无法可靠解析',
  invalid_entity: '元数据含无法确认的实体编码',
  missing_meta: '未取得文章元数据',
  empty_meta: '文章元数据为空',
  ambiguous_meta: '文章元数据有冲突或歧义',
  title_mismatch: '元数据标题与列表不符',
  invalid_article_url: '元数据不是标准微信文章地址',
  missing_article_field: '微信地址缺少或重复定位参数',
  invalid_article_field: '微信文章定位参数格式异常',
  publisher_mismatch: '原文公众号与 reviewId 不符',
  not_attempted: '转链批次已停止，未请求此篇',
};
export const linkReasonText = reason => REASONS[reason] || REASONS.invalid_response;

/** 内容请求和计数由调用方注入；此处不连接浏览器、不读写账本。 */
export async function resolveLinks(result, { run, sleep, probe, record, gapMs = 3000, onProgress = () => {} }) {
  const sources = result.sources.map(source => ({
    ...source,
    ...(source.items ? { items: source.items.map(it => ({ ...it })) } : {}),
  }));
  const groups = new Map();
  for (const source of sources) {
    for (const it of source.items || []) {
      if (it.url) continue;
      it.linkStatus = 'unresolved';
      it.linkReason = 'not_resolved';
      const parts = reviewParts(it.rid);
      if (!parts || `MP_WXS_${parts[1]}` !== source.bookId) {
        it.linkReason = 'invalid_review_id';
        continue;
      }
      const group = groups.get(it.rid);
      if (group) {
        group.targets.push(it);
        if (group.bookId !== source.bookId || group.item.title !== it.title) group.conflict = true;
      } else {
        groups.set(it.rid, { bookId: source.bookId, item: it, targets: [it] });
      }
    }
  }
  const queue = [];
  for (const group of groups.values()) {
    if (group.conflict) {
      for (const it of group.targets) it.linkReason = 'conflicting_article';
    } else queue.push(group);
  }
  queue.sort((a, b) => (Number(b.item.t) || 0) - (Number(a.item.t) || 0));
  const stats = { candidates: queue.length, requestsTotal: 0, resolved: 0, unresolved: 0, aborted: null };
  const stop = (reason, group, errCode) => {
    stats.aborted = { reason, ...(group ? { rid: group.item.rid } : {}),
      ...(Number.isSafeInteger(errCode) ? { code: errCode } : {}) };
    if (group) for (const it of group.targets) it.linkReason = reason;
  };
  if (queue.length && sources.some(s => s.err || s.partialErr)) stop('list_error');
  const requestedGap = Number(gapMs);
  // 超出setTimeout范围会被折算成1ms，不能让错误配置破坏至少3秒的约束。
  const gap = Number.isFinite(requestedGap) && requestedGap <= 2147483647 ? Math.max(3000, requestedGap) : 3000;
  for (const group of queue) {
    if (stats.aborted) break;
    // 首次也等待，覆盖最后一个列表请求到第一个单篇请求的边界。
    await sleep(gap);
    let state;
    try { state = await probe(); } catch { stop('page_unavailable', group); break; }
    if (!state || state.verdict !== 'ready') {
      stop(state?.verdict === 'captcha' ? 'verification_required' : 'page_not_ready', group);
      break;
    }
    try { await record(); } catch { stop('record_failed', group); break; }
    stats.requestsTotal++;
    let response;
    try { response = await run(group.item); } catch { stop('content_unavailable', group); break; }
    if (!response || response.ok !== true) {
      const reason = response && Object.prototype.hasOwnProperty.call(REASONS, response.reason)
        ? response.reason : 'invalid_response';
      stop(reason, group, response?.errCode);
      break;
    }
    const validated = validateArticleMetadata(group.item, group.bookId, response);
    if (!validated.ok) { stop(validated.reason, group); break; }
    for (const it of group.targets) {
      it.url = validated.url;
      it.linkStatus = 'metadata_url';
      delete it.linkReason;
    }
    stats.resolved++;
    onProgress({ ...stats });
  }
  for (const source of sources) {
    for (const it of source.items || []) {
      if (!it.url) {
        if (it.linkReason === 'not_resolved' && stats.aborted) it.linkReason = 'not_attempted';
        stats.unresolved++;
      }
    }
  }
  return { ...result, sources, meta: { ...result.meta, links: stats } };
}
