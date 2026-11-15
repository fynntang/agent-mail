const MAX_CONTENT_ID=998;
/** This display feature accepts legacy bare IDs too, while preserving their exact case. */
function validId(value:string):boolean {
  return value.length>0&&value.length<=MAX_CONTENT_ID&&!/[^\x21-\x7e]|[<>\\]/.test(value);
}

/** A MIME Content-ID header is not a URL: never percent-decode it or remove a cid: prefix. */
export function normalizeMailContentId(value:string|null|undefined):string|null {
  if(typeof value!=='string'||value.length>MAX_CONTENT_ID+2)return null;
  if(value.startsWith('<')&&value.endsWith('>'))value=value.slice(1,-1);
  return validId(value)?value:null;
}

/** RFC 2392: remove the scheme, then decode URL escapes once into an ASCII Content-ID. */
export function normalizeMailCidUrl(value:string|undefined):string|null {
  if(typeof value!=='string'||value.length>MAX_CONTENT_ID*3+4||!/^cid:/i.test(value))return null;
  try {
    const id=decodeURIComponent(value.slice(4));
    return validId(id)?id:null;
  }catch{return null;}
}
