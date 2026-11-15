/** Public diagnostics contain no configured identities, resource names or credentials. */
export function ownerAuthPage(code:string,status:number,requestId:string):Response {
  const configured=code!=='owner_not_configured';
  const title=configured?'需要 Owner 身份':'Owner 认证尚未配置';
  const message=configured?'请通过配置的 Cloudflare Access 登录入口重新打开控制台。'
    :'请先配置 Cloudflare Access、Owner 邮箱和应用 Audience，再打开控制台。';
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Agent Mail</title><style>body{margin:0;background:#f5f4ef;color:#1c302a;font:16px/1.8 system-ui,sans-serif}main{max-width:580px;margin:14vh auto;padding:28px}h1{font-size:30px}p{color:#526259}a{color:#255c44;text-underline-offset:4px}</style></head><body><main><h1>${title}</h1><p>${message}</p><p>此实例不提供公开注册或本地身份认领。</p><a href="/">返回 Agent Mail</a></main></body></html>`,{status,headers:{
      'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'no-referrer','X-Request-Id':requestId,"Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"
    }});
}
