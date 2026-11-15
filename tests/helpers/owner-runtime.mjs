import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {parseJsonc} from '../../scripts/sync-svelte-config.mjs';

/** Test-only network adapter: the shipped Worker still verifies real RSA signatures and fixed Access claims. */
export async function createOwnerRuntime({consoleOrigin='https://console.example.com',port=0,bindings={},outboundService}={}) {
  const config=parseJsonc(await readFile('wrangler.jsonc','utf8'));
  const {privateKey,publicKey}=await generateKeyPair('RS256',{extractable:true});
  const jwk={...await exportJWK(publicKey),kid:'owner-test-key',alg:'RS256',use:'sig'};
  const issuer='https://agent-mail-tests.cloudflareaccess.com';
  const audience='agent-mail-owner-tests';
  const ownerEmail='owner@example.com';
  const options={host:'127.0.0.1',port,unsafeTriggerHandlers:true,log:new Log(LogLevel.ERROR),
    workers:[{name:'owner-console-test',modules:true,scriptPath:resolve('dist/worker/entry.js'),compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,
      bindings:{...config.vars,...bindings,CONSOLE_ORIGIN:consoleOrigin,ACCESS_TEAM_DOMAIN:issuer,ACCESS_AUD:audience,OWNER_EMAIL:ownerEmail},
      d1Databases:{DB:'owner-test-db'},r2Buckets:{MAIL_BLOBS:'owner-test-blobs'},
      email:{send_email:[{name:'EMAIL'}]},
      assets:{directory:resolve('.svelte-kit/cloudflare'),binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true}},
      outboundService:async request=>{
        const url=new URL(request.url);
        if(url.origin===issuer && url.pathname==='/cdn-cgi/access/certs') return Response.json({keys:[jwk]});
        if(outboundService) {const result=await outboundService(request);if(result) return result;}
        return new Response('External network disabled in tests',{status:502});
      }
    }]};
  const mf=new Miniflare(convertV4MiniflareOptions(options));
  try {
    const db=await mf.getD1Database('DB');
    for(const migration of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort()) {
      await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${migration}`,'utf8')).map(sql=>db.prepare(sql)));
    }
    const sign=async(overrides={},key=privateKey,kid='owner-test-key')=>{
      const now=Math.floor(Date.now()/1000);
      return new SignJWT({iss:issuer,aud:audience,sub:'owner-test',iat:now,exp:now+3600,email:ownerEmail,...overrides})
        .setProtectedHeader({alg:'RS256',kid}).sign(key);
    };
    const jwt=await sign();
    const request=async(path,{method='GET',body,headers={},authenticated=true}={})=>mf.dispatchFetch(new URL(path,consoleOrigin),{
      method,headers:{Accept:'application/json',...(authenticated?{'Cf-Access-Jwt-Assertion':jwt}:{}),
        ...(['GET','HEAD'].includes(method)?{}:{Origin:consoleOrigin}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    const runtime={mf,db,bucket:await mf.getR2Bucket('MAIL_BLOBS'),jwt,sign,request,issuer,audience,ownerEmail};
    // Reconfigure the same local deployment while retaining its real D1/R2 data.
    // Access issuer/audience stay fixed; tests never bypass JWT verification.
    runtime.updateBindings=async changes=>{
      const worker=options.workers[0];
      worker.bindings={...worker.bindings,...changes,ACCESS_TEAM_DOMAIN:issuer,ACCESS_AUD:audience,OWNER_EMAIL:ownerEmail,CONSOLE_ORIGIN:consoleOrigin};
      await mf.setOptions(convertV4MiniflareOptions(options));
      runtime.db=await mf.getD1Database('DB');runtime.bucket=await mf.getR2Bucket('MAIL_BLOBS');
    };
    return runtime;
  }catch(error){await mf.dispose();throw error;}
}
