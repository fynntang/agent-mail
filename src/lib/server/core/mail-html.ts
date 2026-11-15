import sanitizeHtml from 'sanitize-html';
import {Parser} from 'htmlparser2';
import {ServiceError} from './types';
import {normalizeMailCidUrl} from './mail-cid';

export const MAIL_HTML_POLICY_VERSION='mail-html-v3';
export const MAIL_HTML_MAX_BYTES=512*1024;
export const MAIL_HTML_MAX_OUTPUT_BYTES=1024*1024;
export const MAIL_HTML_MAX_NODES=20_000;
export const MAIL_HTML_MAX_DEPTH=64;
const encoder=new TextEncoder();
const controls=/[\u0000-\u0020\u007f-\u009f]/;
const loneSurrogates=/[\uD800-\uDFFF]/u;
const tags=['p','div','span','a','br','hr','h1','h2','h3','h4','h5','h6','blockquote','pre','code',
  'strong','b','em','i','u','s','small','sub','sup','ul','ol','li','dl','dt','dd',
  'table','thead','tbody','tfoot','tr','td','th','caption','colgroup','col','img'];
const discarded=['script','style','textarea','option','noscript','template','svg','math','iframe',
  'object','embed','form','button','input','select','video','audio','picture','canvas'];

export interface MailHtmlOptions {
  allowRemoteImages?:boolean;
  blockedOrigins?:string[];
  /** Internal, verified raster data from fetchMailImages; never accepts sender-supplied data URLs. */
  imageSources?:ReadonlyMap<string,string>;
  /** Internal, verified current-message attachment data indexed by normalized Content-ID. */
  cidImageSources?:ReadonlyMap<string,string>;
  /** Preserve already rendered local images when a remote-image opt-in is added. */
  remoteImageBudget?:{count:number;bytes:number};
}
export interface SanitizedMailHtml {
  html:string;
  /** All image nodes actually removed by this policy. */
  blockedImages:number;
  /** Eligible public HTTPS image nodes in the source, including ones blocked by default. */
  remoteImages:number;
  loadedImages:number;
  inlineImages:number;
  loadedInlineImages:number;
  /** Internal fetch candidates only; never included in the Owner HTTP metadata. */
  remoteImageUrls:string[];
  inlineImageIds:string[];
  embeddedImageBytes:number;
  links:{label:string;url:string}[];
}

function plainLabel(value:string,max=200):string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim()).slice(0,max).join('');
}
/** Syntactic URL allowlist. Server fetch additionally relies on Workers strictly-public global fetch. */
export function publicMailHttpsUrl(value:string|undefined,blockedOrigins:Set<string>):string|null {
  if(!value||value.length>2048||controls.test(value)||value.includes('\\')||!/^https:\/\//i.test(value))return null;
  try {
    const url=new URL(value),host=url.hostname;
    if(url.protocol!=='https:'||url.username||url.password||url.port||host.endsWith('.')||!host.includes('.')
      ||host.startsWith('[')||/^[\d.]+$/.test(host)||['localhost','local','internal'].includes(host)
      ||/\.(?:localhost|local|internal|lan|home|onion)$/.test(host)||host.endsWith('.home.arpa')
      ||!host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      ||blockedOrigins.has(url.origin))return null;
    return url.href;
  }catch{return null;}
}
/** Bound tokenization before the sanitizer allocates nested frames; raw HTML is never regex-stripped. */
function inputBudget(raw:string):void {
  if(typeof raw!=='string'||raw.length>MAIL_HTML_MAX_BYTES||loneSurrogates.test(raw)||encoder.encode(raw).byteLength>MAIL_HTML_MAX_BYTES)throw new ServiceError('html_too_large',413);
  let nodes=0,depth=0;
  const parser=new Parser({
    onopentag(){if(++nodes>MAIL_HTML_MAX_NODES||++depth>MAIL_HTML_MAX_DEPTH)throw new ServiceError('html_too_complex',413);},
    onclosetag(){depth=Math.max(0,depth-1);}
  },{decodeEntities:true,xmlMode:false,recognizeSelfClosing:false});
  parser.end(raw);
}
function numberAttribute(value:string|undefined,max:number):string|undefined {
  return value&&/^[1-9]\d{0,3}$/.test(value)&&Number(value)<=max?String(Number(value)):undefined;
}

/** Semantic HTML only. Sender styles and all in-frame navigation are deliberately removed. */
export function sanitizeMailHtml(raw:string,options:MailHtmlOptions={}):SanitizedMailHtml {
  inputBudget(raw);
  const blockedOrigins=new Set((options.blockedOrigins??[]).flatMap(value=>{try{return [new URL(value).origin];}catch{return [];}}));
  const links:SanitizedMailHtml['links']=[],seenLinks=new Set<string>();
  const pendingLinks=new WeakMap<object,string>();
  const remoteImageUrls:string[]=[],inlineImageIds:string[]=[],seenImages=new Set<string>(),seenCids=new Set<string>();
  let blockedImages=0,remoteImages=0,loadedImages=0,inlineImages=0,loadedInlineImages=0,embeddedCharacters=0,embeddedImageBytes=0,remoteImageBytes=0;
  const html=sanitizeHtml(raw,{
    allowedTags:tags,
    allowedAttributes:{'*':['title'],td:['colspan','rowspan'],th:['colspan','rowspan'],ol:['start'],
      img:['src','alt','crossorigin','referrerpolicy','decoding','width','height']},
    allowedSchemes:['data'],allowedSchemesAppliedToAttributes:['src'],allowProtocolRelative:false,
    parseStyleAttributes:false,nestingLimit:MAIL_HTML_MAX_DEPTH,nonTextTags:discarded,
    parser:{decodeEntities:true,xmlMode:false,recognizeSelfClosing:false},
    transformTags:{
      a:(_tag,attributes)=>{
        const clean:Record<string,string>={};
        const url=publicMailHttpsUrl(attributes.href,blockedOrigins);
        if(url)pendingLinks.set(clean,url);
        return {tagName:'a',attribs:clean};
      },
      img:(_tag,attributes)=>{
        const url=publicMailHttpsUrl(attributes.src,blockedOrigins),cid=normalizeMailCidUrl(attributes.src),alt=plainLabel(attributes.alt??'',160);
        if(url){
          remoteImages++;
          if(!seenImages.has(url)&&remoteImageUrls.length<8){remoteImageUrls.push(url);seenImages.add(url);}
        }
        if(cid){
          inlineImages++;
          if(!seenCids.has(cid)&&inlineImageIds.length<8){inlineImageIds.push(cid);seenCids.add(cid);}
        }
        const src=cid?options.cidImageSources?.get(cid):url&&options.allowRemoteImages?options.imageSources?.get(url):undefined;
        const base64Length=src?src.length-src.indexOf(',')-1:0;
        const bytes=src?base64Length/4*3-(src.endsWith('==')?2:src.endsWith('=')?1:0):0;
        // Bound duplicate embedding too: one downloaded URL can occur thousands of times in sender markup.
        if(!src||loadedImages+loadedInlineImages>=8||src.length>1_398_200||base64Length%4!==0
          ||!Number.isSafeInteger(bytes)||bytes<1||bytes>1024*1024||embeddedImageBytes+bytes>4*1024*1024
          ||(!cid&&(loadedImages>=(options.remoteImageBudget?.count??8)||remoteImageBytes+bytes>(options.remoteImageBudget?.bytes??4*1024*1024)))
          ||!/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(src)){
          blockedImages++;
          return {tagName:'span',attribs:{},text:alt?`[图片已屏蔽：${alt}]`:'[图片已屏蔽]'};
        }
        if(cid)loadedInlineImages++;else {loadedImages++;remoteImageBytes+=bytes;}
        embeddedCharacters+=src.length;embeddedImageBytes+=bytes;
        const clean:Record<string,string>={src,alt,referrerpolicy:'no-referrer',decoding:'async'};
        const width=numberAttribute(attributes.width,2048),height=numberAttribute(attributes.height,2048);
        if(width)clean.width=width;if(height)clean.height=height;
        return {tagName:'img',attribs:clean};
      },
      '*':(tag,attributes)=>{
        // The tag-specific transforms above already replace all original attributes.
        if(tag==='img'||tag==='a')return {tagName:tag,attribs:attributes};
        const clean:Record<string,string>={};
        if(attributes.title)clean.title=plainLabel(attributes.title,256);
        if(tag==='td'||tag==='th')for(const key of ['colspan','rowspan']){const value=numberAttribute(attributes[key],100);if(value)clean[key]=value;}
        if(tag==='ol'){const value=numberAttribute(attributes.start,1000);if(value)clean.start=value;}
        return {tagName:tag,attribs:clean};
      }
    },
    exclusiveFilter:frame=>{
      const url=pendingLinks.get(frame.attribs);
      if(url&&!seenLinks.has(url)&&links.length<50){links.push({url,label:plainLabel(frame.text)||url});seenLinks.add(url);}
      return false;
    }
  });
  if(encoder.encode(html).byteLength-embeddedCharacters>MAIL_HTML_MAX_OUTPUT_BYTES)throw new ServiceError('html_too_large',413);
  return {html,blockedImages,remoteImages,loadedImages,inlineImages,loadedInlineImages,remoteImageUrls,inlineImageIds,embeddedImageBytes,links};
}

function contentPolicy(allowImages:boolean):string {
  return `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src ${allowImages?'data:':"'none'"}; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; font-src 'none'; media-src 'none'`;
}
/** Header policy. sandbox and frame-ancestors are intentionally absent from the meta variant below. */
export function mailHtmlCsp(allowImages=false,{sandbox=true}:{sandbox?:boolean}={}):string {
  return `${contentPolicy(allowImages)}; frame-ancestors 'self'${sandbox?'; sandbox':''}`;
}
/** Only pass the output of sanitizeMailHtml; sender markup is never interpolated into the trusted head. */
export function renderMailHtmlDocument(result:Pick<SanitizedMailHtml,'html'>,{allowImages=false}:{allowImages?:boolean}={}):string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${contentPolicy(allowImages)}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><title>邮件正文</title><style>html{color-scheme:light}body{margin:0;padding:18px;color:#24372f;background:#fffefa;font:15px/1.75 system-ui,sans-serif;overflow-wrap:anywhere}h1,h2,h3,h4,h5,h6{line-height:1.4;margin:1em 0 .6em}p,ul,ol,dl,pre,blockquote,table{margin:.8em 0}a{color:inherit}table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}td,th{padding:7px 10px;border:1px solid #d6ddd3;vertical-align:top}th{background:#f3f5ee}blockquote{padding-left:14px;border-left:3px solid #b8c6b9;color:#526259}pre{white-space:pre-wrap;background:#f5f4ef;padding:12px;border-radius:5px}code{font-size:.9em}img{max-width:100%;height:auto}hr{border:0;border-top:1px solid #d6ddd3}</style></head><body>${result.html}</body></html>`;
}

/** Plain-text projection uses the same policy and a maintained HTML tokenizer, never raw markup regexes. */
export function mailHtmlPlainText(raw:string):string {
  const safe=sanitizeMailHtml(raw).html,parts:string[]=[];
  const blocks=new Set(['p','div','h1','h2','h3','h4','h5','h6','ul','ol','li','dl','dt','dd','blockquote','pre','table','tr','hr']);
  const newline=()=>{if(parts.length&&parts.at(-1)!=='\n')parts.push('\n');};
  const parser=new Parser({
    onopentag(name){if(blocks.has(name)||name==='br')newline();if(name==='li')parts.push('• ');if(name==='td'||name==='th')parts.push('\t');},
    ontext(text){parts.push(text);},
    onclosetag(name){if(blocks.has(name))newline();}
  },{decodeEntities:true,xmlMode:false});
  parser.end(safe);
  const text=parts.join('').replace(/[ \t]+\n/g,'\n').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  if(encoder.encode(text).byteLength>MAIL_HTML_MAX_BYTES)throw new ServiceError('html_too_large',413);
  return text;
}
