import {afterEach,describe,expect,it,vi} from 'vitest';
import {fetchMailImages,rasterImageDataUri,MAIL_IMAGE_DEADLINE_MS,MAIL_IMAGE_MAX_BYTES,MAIL_IMAGE_MAX_COUNT,MAIL_IMAGE_TOTAL_BYTES} from '../../src/lib/server/core/mail-images';

const imageUrl='https://images.example.net/logo.png';
const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),char=>char.charCodeAt(0));
const image=(bytes:Uint8Array=png,type='image/png',headers:Record<string,string>={})=>new Response(new Uint8Array(bytes),{headers:{'Content-Type':type,...headers}});
const paddedPng=(size:number)=>{const bytes=new Uint8Array(size);bytes.set(png);return bytes;};
const rasterHeader=(text:string,size:number)=>{const bytes=new Uint8Array(size);for(let index=0;index<text.length;index++)bytes[index]=text.charCodeAt(index);return bytes;};
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});

describe('Owner remote mail images',()=>{
  it('loads a CORS-less PNG through a fresh anonymous GET and emits only raster data',async()=>{
    const fetcher=vi.fn(async()=>image());vi.stubGlobal('fetch',fetcher);
    const loaded=await fetchMailImages([imageUrl],['https://console.example.com']);
    expect(loaded.get(imageUrl)).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...png))}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe(imageUrl);expect(init).toMatchObject({method:'GET',redirect:'manual',cache:'no-store'});
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({accept:'image/png,image/jpeg,image/gif,image/webp','accept-encoding':'identity'});
    expect(new Headers(init.headers).has('Cookie')).toBe(false);expect(new Headers(init.headers).has('Authorization')).toBe(false);
  });
  it('never fetches private/literal/app origins or non-HTTPS URLs, including normalized IP forms',async()=>{
    const fetcher=vi.fn(async()=>image());vi.stubGlobal('fetch',fetcher);
    const rejected=['https://localhost/x','https://host.internal/x','https://host.home.arpa/x','https://127.0.0.1/x','https://0x7f000001/x','https://2130706433/x','https://[::1]/x','https://console.example.com/secret','http://images.example.net/x','https://user:secret@images.example.net/x','https://images.example.net:8443/x'];
    expect((await fetchMailImages(rejected,['https://console.example.com/owner'])).size).toBe(0);expect(fetcher).not.toHaveBeenCalled();
  });
  it('checks every relative/cross-host redirect and never follows a private or app target',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{Location:'/next'}}))
      .mockResolvedValueOnce(new Response(null,{status:307,headers:{Location:'https://cdn.example.net/final.png'}})).mockResolvedValueOnce(image());
    vi.stubGlobal('fetch',fetcher);
    expect((await fetchMailImages([imageUrl],[])).has(imageUrl)).toBe(true);
    expect(fetcher.mock.calls.map(call=>call[0])).toEqual([imageUrl,'https://images.example.net/next','https://cdn.example.net/final.png']);
    for(const location of ['https://127.0.0.1/private','https://console.example.com/owner','http://images.example.net/plain','https://images.example.net:8080/private']) {
      fetcher.mockReset().mockResolvedValue(new Response(null,{status:302,headers:{Location:location}}));
      expect((await fetchMailImages([imageUrl],['https://console.example.com'])).size).toBe(0);expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('limits redirects and cancels redirect bodies instead of reading them',async()=>{
    let cancelled=0;
    const fetcher=vi.fn(async()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{status:302,headers:{Location:'/loop'}}));
    vi.stubGlobal('fetch',fetcher);
    expect((await fetchMailImages([imageUrl],[])).size).toBe(0);expect(fetcher).toHaveBeenCalledTimes(3);expect(cancelled).toBe(3);
  });
  it('requires successful raster MIME, matching magic, and bounded canvas dimensions',async()=>{
    const huge=png.slice();huge.set([0,0,16,1],16);
    const tooManyPixels=png.slice();tooManyPixels.set([0,0,16,0,0,0,16,0],16);
    const invalids=[image(png,'image/svg+xml'),image(new TextEncoder().encode('<svg onload="alert(1)">'),'image/png'),image(png,'text/html'),image(huge),image(tooManyPixels),image(png,'image/jpeg'),image(png,'image/png',{'Content-Encoding':'gzip'}),new Response(png,{status:404,headers:{'Content-Type':'image/png'}})];
    const fetcher=vi.fn(async()=>invalids.shift()!);vi.stubGlobal('fetch',fetcher);
    expect((await fetchMailImages(Array.from({length:8},(_,index)=>`https://images.example.net/${index}`),[])).size).toBe(0);expect(fetcher).toHaveBeenCalledTimes(8);
  });
  it('recognizes JPEG, GIF and all three WebP raster canvas headers, rejecting truncation',async()=>{
    const gif=rasterHeader('GIF89a',13);gif.set([1,0,2,0],6);
    const jpeg=Uint8Array.from([255,216,255,224,0,2,255,192,0,11,8,0,2,0,1,1,1,17,0,255,217]);
    const webp=(kind:string,size:number)=>{const bytes=rasterHeader('RIFF',size);bytes[4]=size-8;bytes.set(new TextEncoder().encode(`WEBP${kind}`),8);bytes[16]=size-20;return bytes;};
    const extended=webp('VP8X',30);extended[24]=0;extended[27]=1;
    const lossy=webp('VP8 ',30);lossy.set([157,1,42,1,0,2,0],23);
    const lossless=webp('VP8L',26);lossless[16]=5;lossless.set([47,0,64,0,0],20);
    const cases:[[Uint8Array,string],[Uint8Array,string],[Uint8Array,string],[Uint8Array,string],[Uint8Array,string]]=[[gif,'image/gif'],[jpeg,'image/jpeg'],[extended,'image/webp'],[lossy,'image/webp'],[lossless,'image/webp']];
    for(const [bytes,type] of cases) {
      vi.stubGlobal('fetch',vi.fn(async()=>image(bytes,type)));
      expect((await fetchMailImages([imageUrl],[])).get(imageUrl)).toMatch(new RegExp(`^data:${type};base64,`));
      vi.stubGlobal('fetch',vi.fn(async()=>image(bytes.subarray(0,bytes.length-8),type)));
      expect((await fetchMailImages([imageUrl],[])).size).toBe(0);
    }
  });
  it('deduplicates URLs and bounds image count and aggregate downloaded bytes',async()=>{
    const fetcher=vi.fn(async()=>image());vi.stubGlobal('fetch',fetcher);
    const urls=Array.from({length:MAIL_IMAGE_MAX_COUNT+3},(_,index)=>`https://images.example.net/${index}`);
    const loaded=await fetchMailImages([urls[0],...urls],[]);
    expect(loaded.size).toBe(MAIL_IMAGE_MAX_COUNT);expect(fetcher).toHaveBeenCalledTimes(MAIL_IMAGE_MAX_COUNT);
    fetcher.mockReset().mockImplementation(async()=>image(paddedPng(MAIL_IMAGE_MAX_BYTES)));
    expect((await fetchMailImages(urls,[])).size).toBe(MAIL_IMAGE_TOTAL_BYTES/MAIL_IMAGE_MAX_BYTES);
    expect(fetcher).toHaveBeenCalledTimes(MAIL_IMAGE_TOTAL_BYTES/MAIL_IMAGE_MAX_BYTES);
  });
  it('rejects declared oversize before reading and cancels streamed oversize without trusting Content-Length',async()=>{
    let cancelled=0;
    const fetcher=vi.fn(async()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'Content-Type':'image/png','Content-Length':String(MAIL_IMAGE_MAX_BYTES+1)}}));
    vi.stubGlobal('fetch',fetcher);
    expect((await fetchMailImages([imageUrl],[])).size).toBe(0);expect(cancelled).toBe(1);
    fetcher.mockImplementation(async()=>new Response(new ReadableStream({start(stream){stream.enqueue(paddedPng(MAIL_IMAGE_MAX_BYTES));stream.enqueue(new Uint8Array(1));},cancel(){cancelled++;}}),{headers:{'Content-Type':'image/png','Content-Length':'1'}}));
    expect((await fetchMailImages([imageUrl],[])).size).toBe(0);expect(cancelled).toBe(2);
  });
  it('recovers from a failed fetch without exposing its error or discarding other images',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockRejectedValueOnce(new Error('upstream private details')).mockResolvedValueOnce(image()));
    const loaded=await fetchMailImages([imageUrl,'https://images.example.net/other.png'],[]);
    expect(loaded.size).toBe(1);expect(loaded.has('https://images.example.net/other.png')).toBe(true);
  });
  it('enforces one whole-operation deadline even when an upstream fetch ignores AbortSignal',async()=>{
    vi.useFakeTimers();const fetcher=vi.fn(()=>new Promise<Response>(()=>{}));vi.stubGlobal('fetch',fetcher);
    const pending=fetchMailImages([imageUrl,'https://images.example.net/other.png'],[]);
    await vi.advanceTimersByTimeAsync(MAIL_IMAGE_DEADLINE_MS);
    expect((await pending).size).toBe(0);expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].signal?.aborted).toBe(true);
  });
  it('cancels a stalled response stream at the same operation deadline',async()=>{
    vi.useFakeTimers();let cancelled=false;
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(stream){stream.enqueue(png);},cancel(){cancelled=true;}}),{headers:{'Content-Type':'image/png'}})));
    const pending=fetchMailImages([imageUrl],[]);
    await vi.advanceTimersByTimeAsync(MAIL_IMAGE_DEADLINE_MS);
    expect((await pending).size).toBe(0);expect(cancelled).toBe(true);
  });
  it('shares a size-bounded raster validator with private CID images',()=>{
    expect(rasterImageDataUri(png,'Image/PNG; x=1')).toMatch(/^data:image\/png;base64,/);
    expect(rasterImageDataUri(paddedPng(MAIL_IMAGE_MAX_BYTES+1),'image/png')).toBeNull();
    expect(rasterImageDataUri(png,'image/svg+xml')).toBeNull();
    expect(rasterImageDataUri(new Uint8Array(),'image/png')).toBeNull();
  });
  it('honors the remaining combined CID/remote image count and byte budget',async()=>{
    const fetcher=vi.fn(async()=>image());vi.stubGlobal('fetch',fetcher);
    const urls=[imageUrl,'https://images.example.net/other.png'];
    expect((await fetchMailImages(urls,[],{maxCount:1,maxBytes:png.length})).size).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);fetcher.mockClear();
    for(const budget of [{maxCount:0},{maxBytes:0},{maxCount:-1},{maxBytes:NaN}])expect((await fetchMailImages(urls,[],budget)).size).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await fetchMailImages(urls,[],{maxCount:2,maxBytes:png.length-1})).size).toBe(0);
  });
});
