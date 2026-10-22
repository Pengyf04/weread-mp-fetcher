import test from 'node:test';
import assert from 'node:assert/strict';
import { extractContentMetadata } from '../lib/link-metadata.mjs';

const meta = '<meta property="og:url" content="https://example.test/article?a=1&amp;b=2"><meta property="og:title" content="合成标题">';
const success = { ok: true, url: 'https://example.test/article?a=1&b=2', title: '合成标题' };

// A naive global <meta> regex would accept these decoys or truncate quoted values.
test('extracts static metadata with mixed-case, reordered and differently quoted attributes', () => {
  assert.deepEqual(extractContentMetadata(`<!DOCTYPE html><html><head>
    <META CONTENT='合成标题' data-note="a > b < c" PROPERTY = 'OG:TITLE'>
    <meta content="https://example.test/article?a=1&amp;b=2" property=og:url />
    </head><body><img src="https://example.test/not-loaded"></body></html>`), success);
});

test('does not split tags at angle brackets inside quoted attribute values', () => {
  assert.deepEqual(extractContentMetadata(`<meta property="og:title" content='甲 < 乙 > 丙'><meta property='og:url' content='https://example.test/a'>`), {
    ok: true, url: 'https://example.test/a', title: '甲 < 乙 > 丙',
  });
});

test('supports the name spelling of OG metadata without guessing conflicting aliases', () => {
  assert.deepEqual(extractContentMetadata('<meta name="og:title" content="标题"><meta name="og:url" content="https://example.test/a">'), {
    ok: true, url: 'https://example.test/a', title: '标题',
  });
  assert.deepEqual(extractContentMetadata(`${meta}<meta property="og:title" name="og:url" content="other">`), {
    ok: false, reason: 'ambiguous_meta',
  });
});

test('decodes named and decimal/hex numeric entities exactly once', () => {
  assert.deepEqual(extractContentMetadata(`<meta property="og&#58;url" content="https://example.test/a?x=&#49;&amp;y=&#x32;"><meta property="og:title" content="&amp; &quot; &apos; &lt; &gt; &nbsp; &#20013; &#x1F680; &amp;amp; &amp;lt;">`), {
    ok: true,
    url: 'https://example.test/a?x=1&y=2',
    title: '& " \' < >   中 🚀 &amp; &lt;',
  });
});

test('does not decode an already decoded list title a second time outside the HTML boundary', () => {
  assert.deepEqual(extractContentMetadata('<meta property="og:url" content="https://example.test/a"><meta property="og:title" content="A &amp;amp; B">'), {
    ok: true, url: 'https://example.test/a', title: 'A &amp; B',
  });
});

test('keeps unescaped query separators that cannot be an attribute entity', () => {
  assert.deepEqual(extractContentMetadata('<meta property="og:url" content="https://example.test/a?a=1&b=2"><meta property="og:title" content="A & B">'), {
    ok: true, url: 'https://example.test/a?a=1&b=2', title: 'A & B',
  });
});

test('ignores metadata inside comments and raw-text elements', () => {
  for (const html of [
    `<!-- ${meta} -->`,
    `<script>const decoy = '${meta}';</script>`,
    `<STYLE>/* ${meta} */</STYLE>`,
    `<textarea>${meta}</textarea>`,
    `<title>${meta}</title>`,
    `<xmp>${meta}</xmp>`,
    `<iframe>${meta}</iframe>`,
    `<noembed>${meta}</noembed>`,
    `<noframes>${meta}</noframes>`,
    `<noscript>${meta}</noscript>`,
    `<plaintext>${meta}`,
    `<div data-fragment='${meta}'></div>`,
  ]) {
    assert.deepEqual(extractContentMetadata(html), { ok: false, reason: 'missing_meta' }, html.slice(0, 35));
  }
});

test('skips decoys without hiding genuine metadata after comments or scripts', () => {
  assert.deepEqual(extractContentMetadata(`<!-- <meta property='og:title' content='wrong'> -->
    <script>const decoy = '<meta property="og:url" content="wrong">';</script>
    <style>/* <meta property="og:title" content="wrong"> */</style>${meta}`), success);
});

test('rejects verification page titles even when convincing OG metadata comes first', () => {
  for (const title of ['请输入验证码', '微信公众平台 - 环境异常', '完成验证后继续访问', '请完成安全验证', '环境异常，完成验证后继续访问', '环境异常，请完成验证后继续访问', '微信读书：环境异常，\n完成验证后继续访问！']) {
    assert.deepEqual(extractContentMetadata(`${meta}<title>${title}</title>`), {
      ok: false, reason: 'verification_page',
    });
  }
  assert.deepEqual(extractContentMetadata(`${meta}<title>&#29615;境异常</title>`), {
    ok: false, reason: 'verification_page',
  });
});

test('does not classify legitimate security-topic article titles as verification pages', () => {
  for (const title of ['聊聊验证码的设计', 'CAPTCHA 的演进', '安全验证的实现', '访问环境异常时如何排查', '完成验证后继续访问：提示文案的设计', '验证码', '安全验证', 'CAPTCHA']) {
    const html = `<html><head><title>${title}</title>
      <meta property="og:title" content="${title}">
      <meta property="og:url" content="https://example.test/article">
      </head><body><p>正常讨论安全设计的文章，没有验证组件。</p></body></html>`;
    assert.deepEqual(extractContentMetadata(html), { ok: true, url: 'https://example.test/article', title });
  }
  assert.deepEqual(extractContentMetadata('<head><title>验证码</title></head>'), {
    ok: false, reason: 'missing_meta',
  });
});

test('rejects an explicit verification instruction in the real head even with valid OG fields', () => {
  assert.deepEqual(extractContentMetadata(`<html><head>${meta}<title>环境异常，完成验证后继续访问</title></head><body></body></html>`), {
    ok: false, reason: 'verification_page',
  });
});

test('does not mistake verification-looking text in scripts or ordinary article text for a page title', () => {
  assert.deepEqual(extractContentMetadata(`<title>正常文章</title>${meta}<script>const text = '<title>环境异常</title>';</script><p>完成验证后</p>`), success);
});

test('recognizes trimmed JSON business errors instead of trusting HTML-looking strings', () => {
  assert.deepEqual(extractContentMetadata(` \n${JSON.stringify({ errCode: -2012, errMsg: meta })}\n `), {
    ok: false, reason: 'json_error', errCode: -2012,
  });
  assert.deepEqual(extractContentMetadata(JSON.stringify({ error: 'failed', html: meta })), {
    ok: false, reason: 'json_error',
  });
  assert.deepEqual(extractContentMetadata(JSON.stringify([meta])), { ok: false, reason: 'json_error' });
  assert.deepEqual(extractContentMetadata(JSON.stringify(meta)), { ok: false, reason: 'json_error' });
  assert.deepEqual(extractContentMetadata(`{"errCode":-1,"html":"${meta}"`), { ok: false, reason: 'invalid_html' });
});

test('rejects missing metadata instead of returning partial success', () => {
  for (const html of ['<html><body>正文</body></html>', '<meta property="og:title" content="标题">', '<meta property="og:url" content="https://example.test/a">']) {
    assert.deepEqual(extractContentMetadata(html), { ok: false, reason: 'missing_meta' });
  }
});

test('rejects empty title or URL after one entity decode', () => {
  for (const html of [
    '<meta property="og:title" content=" "><meta property="og:url" content="https://example.test/a">',
    '<meta property="og:title" content="标题"><meta property="og:url" content="">',
    '<meta property="og:title" content="&nbsp;"><meta property="og:url" content="https://example.test/a">',
  ]) assert.deepEqual(extractContentMetadata(html), { ok: false, reason: 'empty_meta' });
});

test('rejects duplicate attributes and duplicate/conflicting metadata', () => {
  for (const html of [
    `${meta}<meta property="og:title" content="different">`,
    `${meta}<meta property="og:url" content="https://example.test/article?a=1&amp;b=2">`,
    '<meta property="og:title" content="first" CONTENT="second"><meta property="og:url" content="https://example.test/a">',
    '<meta property="og:title" PROPERTY="og:url" content="first">',
    '<meta property="og:title" content="first" content="first">',
  ]) assert.deepEqual(extractContentMetadata(html), { ok: false, reason: 'ambiguous_meta' });
});

test('refuses unknown, unterminated or invalid entities instead of corrupting metadata', () => {
  for (const entity of ['&copy;', '&unknown;', '&amp', '&#xZZ;', '&#0;', '&#xD800;', '&#x110000;', '&#128;', '&#999999999999999999999999999999;']) {
    assert.deepEqual(extractContentMetadata(`<meta property="og:url" content="https://example.test/a"><meta property="og:title" content="${entity}">`), {
      ok: false, reason: 'invalid_entity',
    }, entity);
  }
});

test('refuses malformed or unsupported ambiguous HTML rather than harvesting nested decoys', () => {
  for (const html of [
    `<div title="unterminated>${meta}`,
    `<!-- ${meta}`,
    `<script>${meta}`,
    `<meta property="og:title" content=bad<value>${meta}`,
    `<meta property="og:title" content="title"property="og:url">${meta}`,
    `<![CDATA[${meta}]]>`,
    `<template>${meta}</template>`,
    `<svg>${meta}</svg>`,
    `<script><!-- <script></script>${meta}</script>`,
  ]) assert.deepEqual(extractContentMetadata(html), { ok: false, reason: 'invalid_html' }, html.slice(0, 40));
});

test('rejects invalid inputs synchronously without coercion or HTML execution', () => {
  for (const value of [undefined, null, false, 0, {}, [], new String(meta), '', ' \n\t ', `${meta}\0`]) {
    assert.deepEqual(extractContentMetadata(value), { ok: false, reason: 'invalid_input' });
  }
});

test('uses only an explicit head and ignores unrelated body markup and verification-looking titles', () => {
  const html = `<html><head>${meta}<title>正常文章</title></head><body>
    <svg><meta property="og:title" content="SVG decoy"></svg>
    <template><meta property="og:url" content="template decoy"><title>验证码</title></template>
    <select><option>正常正文</option></select>
    <script><!--任意正文脚本--></script><title>环境异常</title>
    </body></html>`;
  assert.deepEqual(extractContentMetadata(html), success);
});

test('does not treat script strings, comments or quoted values as the real head closing tag', () => {
  const html = `<html><head>
    <script>const decoy = '</head><title>环境异常</title>';</script>
    <!-- </head><title>验证码</title> -->
    <meta data-note="</head>" property="og:title" content="合成标题">
    <meta property="og:url" content="https://example.test/article?a=1&amp;b=2">
    <title>正常文章</title></head><body><title>验证码</title></body></html>`;
  assert.deepEqual(extractContentMetadata(html), success);
});

test('does not fill missing head fields from body metadata', () => {
  assert.deepEqual(extractContentMetadata(`<html><head><title>正常文章</title></head><body>${meta}</body></html>`), {
    ok: false, reason: 'missing_meta',
  });
});

test('discards provisional fragment fields and page titles when an explicit head is encountered', () => {
  assert.deepEqual(extractContentMetadata(`${meta}<title>验证码</title><head>${meta}<title>正常文章</title></head>`), success);
});

test('still rejects conflicting metadata inside an explicit head', () => {
  assert.deepEqual(extractContentMetadata(`<html><head>${meta}<meta property="og:title" content="different"></head><body></body></html>`), {
    ok: false, reason: 'ambiguous_meta',
  });
});

test('rejects an explicit head without its real closing tag', () => {
  assert.deepEqual(extractContentMetadata(`<html><head>${meta}<script>const decoy = '</head>';</script><!-- </head> -->`), {
    ok: false, reason: 'invalid_html',
  });
});

test('returns only the small metadata object from a multi-megabyte synthetic body', () => {
  const html = `<!doctype html><head>${meta}</head><body>${'合成正文 > 普通文本 '.repeat(200_000)}<img src="https://example.test/not-loaded"></body>`;
  const result = extractContentMetadata(html);
  assert.deepEqual(result, success);
  assert.ok(JSON.stringify(result).length < 150);
});

test('is self-contained when serialized into a fresh JavaScript module', async () => {
  const { isolated } = await import(`data:text/javascript,${encodeURIComponent(`export const isolated = ${extractContentMetadata.toString()};`)}`);
  assert.deepEqual(isolated(meta), success);
  assert.deepEqual(isolated(`<!-- ${meta} -->`), { ok: false, reason: 'missing_meta' });
});
