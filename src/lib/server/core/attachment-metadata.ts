/** Sender-controlled attachment metadata is display data, never a path or response header. */
export function safeAttachmentFilename(raw:string|null|undefined,fallback='attachment.bin'):string {
  let name=(raw??'').normalize('NFC').split(/[\\/]/).at(-1)??'';
  name=name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/gu,'')
    .replace(/[<>:"|?*]/g,'_').replace(/^[. ]+|[. ]+$/g,'');
  name=Array.from(name).slice(0,180).join('');
  if(!name)name=fallback;
  if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name=`_${name}`;
  return name;
}

export function safeAttachmentContentType(value:string):string {
  const type=value.toLowerCase();
  return type.length<=127&&/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)?type:'application/octet-stream';
}

export function safeAttachmentContentId(value:string|undefined):string|null {
  if(!value)return null;
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,998)||null;
}
