/**
 * Extract static OG fields without executing or loading any part of the document.
 * All helpers stay inside this function so its toString() is browser-embeddable.
 * This deliberately rejects ambiguous HTML rather than emulating browser recovery.
 */
export function extractContentMetadata(html) {
  const fail = reason => ({ ok: false, reason });
  if (typeof html !== 'string' || !html.trim() || html.includes('\0')) return fail('invalid_input');
  const source = html.trim();

  // Never scan HTML-looking strings nested in an endpoint's JSON response.
  if ('{["'.includes(source[0])) {
    try {
      const json = JSON.parse(source);
      const result = fail('json_error');
      if (json && typeof json.errCode === 'number' && Number.isSafeInteger(json.errCode)) result.errCode = json.errCode;
      return result;
    } catch {
      return fail('invalid_html');
    }
  }

  const space = char => char !== undefined && /[\t\n\f\r ]/.test(char);
  const named = { amp: '&', AMP: '&', quot: '"', QUOT: '"', apos: "'", lt: '<', LT: '<', gt: '>', GT: '>', nbsp: ' ' };

  function decode(value) {
    const chunks = [];
    let last = 0;
    let cursor = 0;
    while ((cursor = value.indexOf('&', cursor)) !== -1) {
      let end = cursor + 1;
      const numeric = value[end] === '#';
      if (numeric) end++;
      while (end < value.length && /[A-Za-z0-9]/.test(value[end])) end++;
      if (end === cursor + 1) { cursor++; continue; } // Literal "A & B".
      const token = value.slice(cursor + 1, end);
      if (value[end] !== ';') {
        // In an attribute, "&key=value" is a literal query separator.
        if (!numeric && value[end] === '=') { cursor = end + 1; continue; }
        return null;
      }
      let replacement;
      if (numeric) {
        if (!/^#(?:[0-9]+|[xX][0-9a-fA-F]+)$/.test(token)) return null;
        const point = token[1]?.toLowerCase() === 'x' ? Number.parseInt(token.slice(2), 16) : Number(token.slice(1));
        // Invalid/replacement/remapped code points require browser error recovery.
        if (!Number.isSafeInteger(point) || point <= 0 || point > 0x10ffff ||
            (point >= 0xd800 && point <= 0xdfff) || (point >= 0x7f && point <= 0x9f) ||
            (point < 0x20 && point !== 9 && point !== 10 && point !== 13) ||
            (point >= 0xfdd0 && point <= 0xfdef) || (point & 0xffff) >= 0xfffe) return null;
        replacement = String.fromCodePoint(point);
      } else {
        if (!Object.prototype.hasOwnProperty.call(named, token)) return null;
        replacement = named[token];
      }
      chunks.push(value.slice(last, cursor), replacement);
      last = end + 1;
      cursor = last;
    }
    chunks.push(value.slice(last));
    return chunks.join(''); // Replacements are never scanned a second time.
  }

  // Strict, quote-aware tag tokenizer. Each character is visited a bounded number
  // of times; no regex spans the document or retries nested variable-length groups.
  function readTag(start) {
    let cursor = start + 1;
    const closing = source[cursor] === '/';
    if (closing) cursor++;
    const begin = cursor;
    if (!/[A-Za-z]/.test(source[cursor] ?? '')) return null;
    while (cursor < source.length && /[A-Za-z0-9:_-]/.test(source[cursor])) cursor++;
    const name = source.slice(begin, cursor).toLowerCase();
    const attrs = Object.create(null);
    let duplicate = false;
    while (cursor < source.length) {
      const beforeSpace = cursor;
      while (space(source[cursor])) cursor++;
      if (source[cursor] === '>') return { name, closing, attrs, duplicate, end: cursor + 1 };
      if (!closing && source[cursor] === '/' && source[cursor + 1] === '>') {
        return { name, closing, attrs, duplicate, end: cursor + 2 };
      }
      if (closing || cursor === beforeSpace) return null;
      const attrStart = cursor;
      while (cursor < source.length && !/[\t\n\f\r /=>"'<`]/.test(source[cursor])) cursor++;
      if (cursor === attrStart) return null;
      const attr = source.slice(attrStart, cursor).toLowerCase();
      const afterName = cursor;
      while (space(source[cursor])) cursor++;
      let value = '';
      if (source[cursor] === '=') {
        cursor++;
        while (space(source[cursor])) cursor++;
        const quote = source[cursor];
        if (quote === '"' || quote === "'") {
          const end = source.indexOf(quote, cursor + 1);
          if (end === -1) return null;
          if (name === 'meta') value = source.slice(cursor + 1, end);
          cursor = end + 1;
        } else {
          const valueStart = cursor;
          while (cursor < source.length && !space(source[cursor]) && source[cursor] !== '>') {
            if (/["'<=`]/.test(source[cursor])) return null;
            cursor++;
          }
          if (cursor === valueStart) return null;
          if (name === 'meta') value = source.slice(valueStart, cursor);
        }
      } else {
        cursor = afterName; // Let the next iteration consume the separating space.
      }
      if (name === 'meta') {
        if (Object.prototype.hasOwnProperty.call(attrs, attr)) duplicate = true;
        attrs[attr] = value.replace(/\r\n?/g, '\n');
      }
    }
    return null;
  }

  let cursor = 0;
  let title;
  let url;
  let metadataError;
  let verification = false;
  let hasHead = false;
  let headClosed = false;
  const raw = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
  while ((cursor = source.indexOf('<', cursor)) !== -1) {
    if (source.startsWith('<!--', cursor)) {
      const end = source.indexOf('-->', cursor + 4);
      if (end === -1) return fail('invalid_html');
      const comment = source.slice(cursor + 4, end);
      if (comment.includes('<!--') || comment.includes('--!>')) return fail('invalid_html');
      cursor = end + 3;
      continue;
    }
    if (source.slice(cursor, cursor + 9).toLowerCase() === '<!doctype' &&
        (space(source[cursor + 9]) || source[cursor + 9] === '>')) {
      let end = cursor + 9;
      let quote;
      for (; end < source.length; end++) {
        const char = source[end];
        if (quote) { if (char === quote) quote = undefined; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === '>') break;
        else if (char === '<' || char === '[') return fail('invalid_html');
      }
      if (end === source.length) return fail('invalid_html');
      cursor = end + 1;
      continue;
    }
    if (source[cursor + 1] === '!' || source[cursor + 1] === '?') return fail('invalid_html');
    if (!/[A-Za-z/]/.test(source[cursor + 1] ?? '')) { cursor++; continue; }
    const tag = readTag(cursor);
    if (!tag) return fail('invalid_html');
    cursor = tag.end;
    if (tag.name === 'head') {
      if (tag.closing) {
        if (!hasHead) return fail('invalid_html');
        headClosed = true;
        break; // Body markup cannot contribute metadata or invalidate the head.
      }
      if (hasHead) return fail('invalid_html');
      hasHead = true;
      // Before an explicit head, fields are only provisional fragment candidates.
      title = url = metadataError = undefined;
      verification = false;
      continue;
    }
    if (tag.closing) continue;
    // These contexts need tree-builder/foreign-content rules, not just tokenizing.
    if (['template', 'svg', 'math', 'select'].includes(tag.name)) return fail('invalid_html');
    if (tag.name === 'plaintext') break;
    if (raw.has(tag.name)) {
      const closePattern = new RegExp(`</${tag.name}(?=[\\t\\n\\f\\r />])`, 'gi');
      closePattern.lastIndex = cursor;
      const close = source.matchAll(closePattern).next().value;
      if (!close) return fail('invalid_html');
      const endTag = readTag(close.index);
      if (!endTag || !endTag.closing) return fail('invalid_html');
      if (tag.name === 'script' && source.slice(cursor, close.index).includes('<!--')) return fail('invalid_html');
      if (tag.name === 'title') {
        const pageTitle = decode(source.slice(cursor, close.index).replace(/\r\n?/g, '\n'));
        if (pageTitle === null) metadataError ??= 'invalid_entity';
        else {
          // Security-topic words alone are not proof of a challenge page. Only
          // match complete known prompts; callers validate metadata identity.
          const prompt = pageTitle.trim().replace(/\s+/g, ' ')
            .replace(/^(?:微信公众平台|微信读书)\s*[-—|:：]\s*/, '')
            .replace(/[。！!]$/, '');
          if (/^(?:访问)?环境异常(?:[，,：: ]+(?:请)?完成验证后继续访问)?$/.test(prompt) ||
              /^(?:请)?完成验证后继续访问$/.test(prompt) ||
              /^请(?:输入验证码|完成安全验证)(?:后继续访问)?$/.test(prompt)) verification = true;
        }
      }
      cursor = endTag.end;
      continue;
    }
    if (tag.name !== 'meta') continue;
    if (tag.duplicate) { metadataError ??= 'ambiguous_meta'; continue; }
    const property = decode(tag.attrs.property ?? '');
    const name = decode(tag.attrs.name ?? '');
    if (property === null || name === null) { metadataError ??= 'invalid_entity'; continue; }
    const keys = [property.trim().toLowerCase(), name.trim().toLowerCase()];
    const key = keys.find(value => value === 'og:url' || value === 'og:title');
    if (!key) continue;
    if (keys.some(value => value && value !== key)) { metadataError ??= 'ambiguous_meta'; continue; }
    if (!Object.prototype.hasOwnProperty.call(tag.attrs, 'content')) { metadataError ??= 'missing_meta'; continue; }
    const value = decode(tag.attrs.content);
    if (value === null) { metadataError ??= 'invalid_entity'; continue; }
    if (key === 'og:url') {
      if (url !== undefined) metadataError ??= 'ambiguous_meta';
      url = value;
    } else {
      if (title !== undefined) metadataError ??= 'ambiguous_meta';
      title = value;
    }
  }
  if (hasHead && !headClosed) return fail('invalid_html');
  if (verification) return fail('verification_page');
  if (metadataError) return fail(metadataError);
  if (title === undefined || url === undefined) return fail('missing_meta');
  if (!title.trim() || !url.trim()) return fail('empty_meta');
  return { ok: true, url, title };
}
