import {describe,it,expect} from 'vitest';
import PostalMime from 'postal-mime';
import {normalizedContent,normalizedInlineImages,validateInlineImages,providerMessage,localSentCopy,type DraftContent,type LoadedDraftAttachment} from '../../src/lib/server/core/outbound-content';
import {sha256} from '../../src/lib/server/core/crypto';

const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),char=>char.charCodeAt(0));
const base=():DraftContent=>normalizedContent({to:['to@example.net'],cc:['cc@example.net'],bcc:['hidden@example.net'],subject:'HTML 报告 😀',text:'纯文本备用正文。'});
async function file(bytes=png,filename='内嵌图片.png',contentType='image/png'):Promise<LoadedDraftAttachment>{
  return {attachment:{id:crypto.randomUUID(),filename,contentType,sizeBytes:bytes.length,sha256:await sha256(bytes)},bytes};
}
function bind(content:DraftContent,files:LoadedDraftAttachment[]):DraftContent {
  return {...content,attachments:files.map(file=>file.attachment),html:'<h2>报告 😀</h2><img src="cid:Logo%40Agent" alt="logo">',
    inlineImages:[{attachmentId:files[0].attachment.id,contentId:'Logo@Agent'}]};
}

describe('HTML outbound content and MIME',()=>{
  it('preserves absent legacy fields and retains exact approved HTML bytes within UTF8/complexity budgets',()=>{
    const legacy=base();expect(legacy).not.toHaveProperty('html');expect(legacy).not.toHaveProperty('inlineImages');
    const html='<p style="color:red">你好 😀</p><script>sourceOnly()</script>';
    expect(normalizedContent({html}).html).toBe(html);expect(normalizedContent({html:null}).html).toBeNull();expect(normalizedContent({html:' \n '}).html).toBeNull();
    expect(()=>normalizedContent({html:'汉'.repeat(22000)})).toThrowError('html_too_large');
    for(const html of ['\uD800','bad\0html','<div>'.repeat(65)])expect(()=>normalizedContent({html})).toThrow();
  });
  it('rejects ambiguous, noncanonical or header-injecting CID bindings',()=>{
    const id=crypto.randomUUID(),other=crypto.randomUUID();
    expect(normalizedInlineImages([{attachmentId:id,contentId:'Case@Agent'}])).toEqual([{attachmentId:id,contentId:'Case@Agent'}]);
    expect(normalizedInlineImages([{attachmentId:id,contentId:'A'.repeat(984)}])[0].contentId).toHaveLength(984);
    for(const value of [[{attachmentId:id,contentId:'<Case@Agent>'}],[{attachmentId:id,contentId:'bad\r\nX-Header:bad'}],
      [{attachmentId:id,contentId:'A'.repeat(985)}],
      [{attachmentId:id,contentId:'one'},{attachmentId:id,contentId:'two'}],[{attachmentId:id,contentId:'same'},{attachmentId:other,contentId:'same'}],
      [{attachmentId:id,contentId:'one',disposition:'inline'}],Array.from({length:9},(_,i)=>({attachmentId:crypto.randomUUID(),contentId:String(i)}))])expect(()=>normalizedInlineImages(value)).toThrow();
  });
  it('permits incomplete drafting but blocks unresolved/invalid CIDs and foreign attachment references before sending',async()=>{
    const content={...base(),html:'<img src="cid:Missing">'};
    expect(()=>validateInlineImages(content)).not.toThrow();expect(()=>validateInlineImages(content,[],{complete:true})).toThrowError('unresolved_cid');
    const image=await file(),valid=bind(base(),[image]);
    expect(()=>validateInlineImages(valid,[image],{complete:true})).not.toThrow();
    expect(()=>validateInlineImages({...valid,html:'<img src="cid:Logo%2540Agent">'},[image],{complete:true})).toThrowError('unresolved_cid');
    expect(()=>validateInlineImages({...valid,attachments:[]},[image],{complete:true})).toThrowError('invalid_inline_images');
    expect(()=>validateInlineImages({...valid,html:null},[image],{complete:true})).toThrowError('invalid_inline_images');
  });
  it('checks inline raster bytes/type/size independently from ordinary binary attachments',async()=>{
    const svg=await file(new TextEncoder().encode('<svg/>'),'image.svg','image/svg+xml');
    expect(()=>validateInlineImages(bind(base(),[svg]),[svg],{complete:true})).toThrowError('inline_image_invalid');
    const spoof=await file(new TextEncoder().encode('<svg/>'));
    expect(()=>validateInlineImages(bind(base(),[spoof]),[spoof],{complete:true})).toThrowError('inline_image_invalid');
    const oversized=new Uint8Array(1024*1024+1);oversized.set(png);const large=await file(oversized);
    expect(()=>validateInlineImages(bind(base(),[large]),[large],{complete:true})).toThrowError('inline_image_invalid');
    expect(providerMessage('sender@example.com',{...base(),attachments:[svg.attachment]},[svg]).attachments?.[0].disposition).toBe('attachment');
  });
  it('passes both exact bodies and typed inline CID attachments to native Email Sending',async()=>{
    const image=await file(),binary=await file(new Uint8Array([0,255,128]),'报告.bin','application/octet-stream');
    const content={...bind(base(),[image,binary]),inReplyTo:'<source@example.net>'};
    const message=providerMessage('sender@agent.example.com',content,[image,binary]);
    expect(message.text).toBe(content.text);expect(message.html).toBe(content.html);expect(message.bcc).toEqual(['hidden@example.net']);
    expect(message.attachments).toEqual([
      {content:btoa(String.fromCharCode(...png)),filename:image.attachment.filename,type:'image/png',disposition:'inline',contentId:'Logo@Agent'},
      {content:'AP+A',filename:'报告.bin',type:'application/octet-stream',disposition:'attachment'}
    ]);
    expect(message.headers).toEqual({'In-Reply-To':'<source@example.net>',References:'<source@example.net>'});
  });
  it('round-trips alternative/related/mixed MIME with Unicode names, exact binary bytes and no public Bcc header',async()=>{
    const image=await file(),binary=await file(new Uint8Array([0,255,128]),'报告.bin','application/octet-stream');
    const content={...bind(base(),[image,binary]),inReplyTo:'<source@example.net>'};
    const raw=localSentCopy(crypto.randomUUID(),'sender@agent.example.com',content,Date.now(),[image,binary]);
    expect(raw).toContain('multipart/mixed');expect(raw).toContain('multipart/alternative');expect(raw).toContain('multipart/related');expect(raw).toContain('Content-ID: <Logo@Agent>');
    expect(raw).not.toMatch(/^Bcc:/m);expect(raw).not.toContain('hidden@example.net');
    const parsed=await PostalMime.parse(raw);
    expect(parsed.text?.trim()).toBe(content.text);expect(parsed.html?.trim()).toBe(content.html);expect(parsed.subject).toBe(content.subject);expect(parsed.inReplyTo).toBe(content.inReplyTo);
    expect(parsed.attachments).toHaveLength(2);expect(parsed.attachments.map(part=>part.filename)).toEqual([image.attachment.filename,'报告.bin']);
    expect(parsed.attachments[0].contentId).toBe('<Logo@Agent>');expect(parsed.attachments[0].disposition).toBe('inline');
    expect(new Uint8Array(parsed.attachments[0].content as ArrayBuffer)).toEqual(png);expect(new Uint8Array(parsed.attachments[1].content as ArrayBuffer)).toEqual(binary.bytes);
  });
  it('emits alternative MIME without any attachment and keeps old plain-text MIME unchanged in shape',async()=>{
    const content={...base(),html:'<p>Hello <b>HTML</b></p>'},id=crypto.randomUUID();
    const raw=localSentCopy(id,'sender@agent.example.com',content,Date.now());
    expect(raw).toContain('multipart/alternative');expect(raw).not.toContain('multipart/related');
    const parsed=await PostalMime.parse(raw);expect(parsed.text?.trim()).toBe(content.text);expect(parsed.html?.trim()).toBe(content.html);expect(parsed.attachments).toHaveLength(0);
    const plain=localSentCopy(id,'sender@agent.example.com',base(),Date.now());expect(plain).not.toContain('multipart/');expect(plain).toContain('Content-Type: text/plain');
  });
});
