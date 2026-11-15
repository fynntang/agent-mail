import {describe,it,expect} from 'vitest';
import {normalizeMailCidUrl,normalizeMailContentId} from '../../src/lib/server/core/mail-cid';

describe('mail Content-ID matching',()=>{
  it('decodes URL escapes exactly once and preserves exact ID case and literal URL punctuation',()=>{
    expect(normalizeMailCidUrl('CID:Logo%40EXAMPLE.net')).toBe('Logo@EXAMPLE.net');
    expect(normalizeMailCidUrl('cid:logo%252Fone%25two%2Bthree')).toBe('logo%2Fone%two+three');
    expect(normalizeMailCidUrl('cid:image001.png')).toBe('image001.png');
    expect(normalizeMailCidUrl('cid:part%2Fone')).toBe('part/one');
    expect(normalizeMailCidUrl('cid:cid:part')).toBe('cid:part');
  });
  it('strips only balanced header angle brackets without URL-decoding or case folding',()=>{
    expect(normalizeMailContentId('<Logo@EXAMPLE.net>')).toBe('Logo@EXAMPLE.net');
    expect(normalizeMailContentId('image001.png')).toBe('image001.png');
    expect(normalizeMailContentId('<logo%25one>')).toBe('logo%25one');
    expect(normalizeMailContentId('cid:part')).toBe('cid:part');
  });
  it('rejects malformed URLs, escapes, non-ASCII, controls, whitespace and angle/backslash variants',()=>{
    for(const value of [undefined,'','CID:','https://images.example.net/logo','mid:logo',' cid:logo','cid:logo ','cid:one%','cid:one%GG','cid:%ff','cid:%E6%B1%89','cid:汉','cid:one%20two','cid:one%00two','cid:one\ntwo','cid:one%7ftwo','cid:%3Clogo%3E','cid:<logo>','cid:one%5Ctwo'])expect(normalizeMailCidUrl(value)).toBeNull();
    for(const value of [undefined,null,'','<>','<logo','logo>','<<logo>>','<lo<go>',' logo','logo ','one\ttwo','one\0two','汉','one\\two'])expect(normalizeMailContentId(value)).toBeNull();
  });
  it('bounds decoded IDs without accidentally truncating different values into an alias',()=>{
    expect(normalizeMailCidUrl(`cid:${'%41'.repeat(998)}`)).toBe('A'.repeat(998));
    expect(normalizeMailContentId(`<${'A'.repeat(998)}>`)).toBe('A'.repeat(998));
    expect(normalizeMailCidUrl(`cid:${'A'.repeat(999)}`)).toBeNull();
    expect(normalizeMailContentId('A'.repeat(999))).toBeNull();
  });
});
