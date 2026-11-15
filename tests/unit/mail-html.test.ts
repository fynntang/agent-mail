import {describe,it,expect} from 'vitest';
import {sanitizeMailHtml,mailHtmlPlainText,renderMailHtmlDocument,mailHtmlCsp,MAIL_HTML_MAX_BYTES,MAIL_HTML_MAX_DEPTH,MAIL_HTML_MAX_NODES} from '../../src/lib/server/core/mail-html';

describe('mail HTML policy',()=>{
  it('keeps semantic mail formatting while dropping sender styles and executable containers',()=>{
    const result=sanitizeMailHtml('<h2 style="color:red">Report</h2><table><tr><th colspan="2">Done</th></tr><tr><td>One</td><td><b>Two</b></td></tr></table><script>alert(1)</script><style>@import url(https://tracker.example.net/a)</style><form><input><p>Form secret</p></form><iframe srcdoc="<script>x</script>">nested</iframe><svg><script>svg</script></svg><math><mtext>math</mtext></math>');
    expect(result.html).toContain('<h2>Report</h2>');expect(result.html).toContain('colspan="2"');expect(result.html).toContain('<b>Two</b>');
    for(const removed of ['style=','script','Form secret','iframe','nested','<svg','math','tracker'])expect(result.html).not.toContain(removed);
  });
  it('removes all active attributes, clobbering names, document metadata and CSS URL sinks',()=>{
    const result=sanitizeMailHtml('<base href="https://evil.example.net"><meta http-equiv="refresh" content="0;url=https://evil.example.net"><link rel="stylesheet" href="https://evil.example.net"><div id="parent" name="location" onclick="parent.pwn=1" contenteditable style="background:url(https://evil.example.net);position:fixed"><p onmouseover="evil()">Visible</p><object data="https://evil.example.net">object</object><video poster="https://evil.example.net"><source src="https://evil.example.net"></video></div>');
    expect(result.html).toBe('<div><p>Visible</p></div>');
  });
  it('blocks every image by default without preserving tracking URLs or alternate sources',()=>{
    const result=sanitizeMailHtml('<img src="https://images.example.net/pixel?a=secret" srcset="https://tracker.example.net/a 2x" onerror="x" alt="logo"><img src="cid:part"><img src="data:image/svg+xml,<svg onload=alert(1)>"><picture><source srcset="https://picture.example.net/a"><img src="https://picture.example.net/b"></picture>');
    expect(result.remoteImages).toBe(1);expect(result.blockedImages).toBe(3);
    expect(result.html).toContain('[图片已屏蔽：logo]');
    for(const removed of ['<img','src=','srcset','https:','cid:','data:','onerror'])expect(result.html).not.toContain(removed);
  });
  it('escapes decoded image alt markup and exposes link labels only as untrusted plain text',()=>{
    const result=sanitizeMailHtml('<a href="https://docs.example.net/"><b>&lt;script&gt;parent.pwn=1&lt;/script&gt;</b></a><img src="https://images.example.net/x" alt="&lt;img src=x onerror=parent.pwn=1&gt;">');
    expect(result.html).toContain('&lt;script&gt;parent.pwn=1&lt;/script&gt;');
    expect(result.html).toContain('[图片已屏蔽：&lt;img src=x onerror=parent.pwn=1&gt;]');
    expect(result.html).not.toContain('<img');expect(result.html).not.toContain('<script');
    expect(result.links).toEqual([{url:'https://docs.example.net/',label:'<script>parent.pwn=1</script>'}]);
  });
  it('only embeds verified raster replacements for public HTTPS sources, never sender data or browser remote URLs',()=>{
    const urls=['http://images.example.net/a','//images.example.net/a','/owner/api/x','javascript:alert(1)','data:image/png;base64,AA==','cid:part',
      'https://localhost/x','https://foo.local/x','https://foo.internal/x','https://foo.home.arpa/x','https://127.0.0.1/x','https://0x7f000001/x',
      'https://[::1]/x','https://2130706433/x','https://foo/x','https://u:p@images.example.net/x','https://images.example.net:8443/x',
      'https://console.example.com/x','https://console.example.com./x','https:\\images.example.net/a'];
    const source='<img src="https://images.example.net/a.png" width="800" height="100000" alt="ok" srcset="https://evil.example.net/a 2x">'+urls.map(url=>`<img src="${url}">`).join('');
    const result=sanitizeMailHtml(source,{allowRemoteImages:true,blockedOrigins:['https://console.example.com'],imageSources:new Map([['https://images.example.net/a.png','data:image/png;base64,AAAA']])});
    expect(result.remoteImages).toBe(1);expect(result.blockedImages).toBe(urls.length);
    expect(result.html).toContain('src="data:image/png;base64,AAAA"');expect(result.html).not.toContain('https:');expect(result.html).toContain('referrerpolicy="no-referrer"');expect(result.html).toContain('width="800"');
    expect(result.loadedImages).toBe(1);expect(result.remoteImageUrls).toEqual(['https://images.example.net/a.png']);
    expect(sanitizeMailHtml(source,{allowRemoteImages:true}).html).not.toContain('<img');
    expect(result.html).not.toContain('srcset');expect(result.html).not.toContain('height=');expect((result.html.match(/<img/g)??[]).length).toBe(1);
  });
  it('caps duplicate embedded images and rejects invalid trusted replacements without restoring sender URLs',()=>{
    const raw='<img src="https://images.example.net/a">'.repeat(20);
    const result=sanitizeMailHtml(raw,{allowRemoteImages:true,imageSources:new Map([['https://images.example.net/a','data:image/png;base64,AAAA']])});
    expect(result.loadedImages).toBe(8);expect(result.blockedImages).toBe(12);expect(result.remoteImages).toBe(20);expect(result.remoteImageUrls).toHaveLength(1);
    for(const replacement of ['https://evil.example.net/x','data:image/svg+xml;base64,AAAA','data:image/png;base64,AA" onerror="bad']){
      expect(sanitizeMailHtml(raw,{allowRemoteImages:true,imageSources:new Map([['https://images.example.net/a',replacement]])}).html).not.toContain('<img');
    }
  });
  it('embeds verified CID data without remote permission and collects bounded case-sensitive IDs only',()=>{
    const raw='<img src="CID:Logo%40mail.example" alt="logo" onload="bad()" srcset="https://tracker.example.net/x 2x"><img src="cid:missing"><img src="https://images.example.net/x"><img src="data:image/png;base64,AAAA">';
    const result=sanitizeMailHtml(raw,{cidImageSources:new Map([['Logo@mail.example','data:image/png;base64,AAAA']])});
    expect(result.inlineImages).toBe(2);expect(result.loadedInlineImages).toBe(1);expect(result.remoteImages).toBe(1);expect(result.loadedImages).toBe(0);expect(result.blockedImages).toBe(3);
    expect(result.inlineImageIds).toEqual(['Logo@mail.example','missing']);expect(result.embeddedImageBytes).toBe(3);
    expect(result.html).toContain('<img src="data:image/png;base64,AAAA"');
    expect(result.html).not.toMatch(/cid:|https:|onload|srcset/i);
    expect(sanitizeMailHtml(raw,{cidImageSources:new Map([['logo@mail.example','data:image/png;base64,AAAA']])}).loadedInlineImages).toBe(0);
    expect(sanitizeMailHtml(raw,{cidImageSources:new Map([['Logo@mail.example','data:image/svg+xml;base64,AAAA']])}).loadedInlineImages).toBe(0);
  });
  it('reserves CID images when repeated remote tags precede them and applies one combined image budget',()=>{
    const raw='<img src="https://images.example.net/x">'.repeat(10)+'<img src="cid:logo">'.repeat(7);
    const result=sanitizeMailHtml(raw,{allowRemoteImages:true,imageSources:new Map([['https://images.example.net/x','data:image/png;base64,AAAA']]),
      cidImageSources:new Map([['logo','data:image/png;base64,AAAA']]),remoteImageBudget:{count:1,bytes:3}});
    expect(result.loadedInlineImages).toBe(7);expect(result.loadedImages).toBe(1);expect(result.blockedImages).toBe(9);expect(result.embeddedImageBytes).toBe(24);
    const inline=sanitizeMailHtml('<img src="cid:logo">'.repeat(20),{cidImageSources:new Map([['logo','data:image/png;base64,AAAA']])});
    expect(inline.loadedInlineImages).toBe(8);expect(inline.blockedImages).toBe(12);expect(inline.inlineImageIds).toEqual(['logo']);
  });
  it('removes in-frame hrefs and exposes bounded, visible text labels with safe external links only',()=>{
    const result=sanitizeMailHtml('<a href="https://docs.example.net/a?x=1&amp;y=2"><b>Read</b> docs</a><a href="java&#x73;cript:alert(1)">bad</a><a href="https://docs.example.net/a?x=1&amp;y=2">duplicate</a><a href="https://api.example.com/owner">own</a><a href="/relative">relative</a>',{blockedOrigins:['https://api.example.com']});
    expect(result.html).not.toContain('href');expect(result.links).toEqual([{url:'https://docs.example.net/a?x=1&y=2',label:'Read docs'}]);
    expect(sanitizeMailHtml(Array.from({length:60},(_,index)=>`<a href="https://links.example.net/${index}">link${index}</a>`).join('')).links.length).toBe(50);
  });
  it('handles entity obfuscation, malformed markup and namespace mutation payloads without URL or executable output',()=>{
    const payloads=[
      '<IMG SRC=jav&#x61;script:alert(1) ONERROR=alert(1)>',
      '<svg><foreignObject><p><img src=x onerror=alert(1)></p></foreignObject></svg><p>after</p>',
      '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">bad</p></noscript>',
      '<template shadowrootmode="open"><script>parent.alert(1)</script></template><p>safe',
      '<div><p><b>unterminated<img src="https://images.example.net/x" oNLoAd="evil()">'
    ];
    for(const payload of payloads) {
      const {html}=sanitizeMailHtml(payload);
      expect(html).not.toMatch(/<(?:script|iframe|svg|math|style|template|noscript|img)\b/i);
      expect(html).not.toMatch(/\son\w+=|\ssrc=|\shref=/i);
      expect(sanitizeMailHtml(html).html).toBe(html);
    }
  });
  it('bounds raw bytes, parse depth and node count before rendering',()=>{
    expect(()=>sanitizeMailHtml('x'.repeat(MAIL_HTML_MAX_BYTES+1))).toThrowError('html_too_large');
    expect(()=>sanitizeMailHtml('汉'.repeat(Math.floor(MAIL_HTML_MAX_BYTES/3)+1))).toThrowError('html_too_large');
    expect(()=>sanitizeMailHtml('<div>'.repeat(MAIL_HTML_MAX_DEPTH+1))).toThrowError('html_too_complex');
    expect(()=>sanitizeMailHtml('<br>'.repeat(MAIL_HTML_MAX_NODES+1))).toThrowError('html_too_complex');
    expect(()=>sanitizeMailHtml('\uD800')).toThrowError('html_too_large');
    expect(sanitizeMailHtml('<p>😀</p>').html).toBe('<p>😀</p>');
  });
  it('fails closed when escaping expands valid raw input beyond the output budget',()=>{
    expect(()=>sanitizeMailHtml('>'.repeat(MAIL_HTML_MAX_BYTES))).toThrowError('html_too_large');
  });
  it('projects safe plain text using decoded entities, block boundaries and table cells',()=>{
    const text=mailHtmlPlainText('<h2>Report &amp; status</h2><p>Hello <strong>世界 😀</strong><br>Next</p><ul><li>One</li><li>Two</li></ul><table><tr><td>A</td><td>B</td></tr></table><script>steal()</script><img src="https://tracker.example.net/x" alt="logo">');
    expect(text).toContain('Report & status\nHello 世界 😀\nNext');expect(text).toContain('• One\n• Two');expect(text).toContain('A\tB');expect(text).not.toContain('steal');expect(text).not.toContain('https://');expect(text).not.toContain('<strong>');
  });
  it('wraps only sanitized body under a trusted policy and keeps HTTP sandbox separate from meta CSP',()=>{
    const result=sanitizeMailHtml('<p>Hello</p><script>bad()</script>');
    const document=renderMailHtmlDocument(result);
    expect(document).toContain('<meta http-equiv="Content-Security-Policy"');expect(document).toContain("img-src 'none'");expect(document).toContain("script-src 'none'");expect(document).toContain('<body><p>Hello</p></body>');
    expect(document).not.toContain('frame-ancestors');expect(document).not.toContain('sandbox');expect(document).not.toContain('bad()');
    expect(mailHtmlCsp()).toContain("frame-ancestors 'self'; sandbox");expect(mailHtmlCsp(true)).toContain('img-src data:');expect(renderMailHtmlDocument(result,{allowImages:true})).toContain('img-src data:');
  });
});
