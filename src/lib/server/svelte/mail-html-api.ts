import {getOwnerMessageHtml} from '../core/mail';
import {mailHtmlCsp,renderMailHtmlDocument} from '../core/mail-html';
import {ServiceError} from '../core/types';
import {api} from './api';
import {jsonInput,ownerContext} from './owner';

function available(result:Awaited<ReturnType<typeof getOwnerMessageHtml>>):asserts result is typeof result&{html:string} {
  if(result.status!=='available'||result.html===null)throw new ServiceError(`html_${result.status}`,
    result.status==='unavailable'?503:result.status==='too_large'?413:409);
}
export function mailHtmlApi(mode:'document'|'info'|'images') {
  return api(async({locals,params,request,url})=>{
    // Remote images can only be enabled by a same-origin authenticated POST, never a shareable GET URL.
    if(url.search)throw new ServiceError('invalid_query',400);
    const allowRemoteImages=mode==='images';
    if(allowRemoteImages) {
      const input=await jsonInput(request);
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1
        ||!('allowRemoteImages' in input)||input.allowRemoteImages!==true)throw new ServiceError('invalid_input',400);
    }
    const result=await getOwnerMessageHtml(ownerContext(locals),params.id!,params.messageId!,{allowRemoteImages});
    const {html,...info}=result;
    if(mode==='info')return Response.json(info);
    available(result);
    const allowImages=result.loadedImages+result.loadedInlineImages>0;
    const document=renderMailHtmlDocument({...result,html:result.html},{allowImages});
    if(allowRemoteImages)return Response.json({...info,document});
    return new Response(document,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store',
      'Content-Security-Policy':mailHtmlCsp(allowImages),'X-Frame-Options':'SAMEORIGIN','X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'}});
  });
}
