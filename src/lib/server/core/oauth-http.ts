import {OAuthError,oauthConfig,oauthScopes,registerOAuthClient,trustedCimdHosts} from './oauth';
import {exchangeOAuthToken,revokeOAuthToken} from './oauth-tokens';
import {readBounded} from './storage';
import {ServiceError,type Actor,type RuntimeEnv} from './types';

const protectedPaths=['/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-protected-resource'];
const publicPaths=[...protectedPaths,'/.well-known/oauth-authorization-server','/oauth/register','/oauth/token','/oauth/revoke'];
export function validOAuthOrigin(value:string|null):boolean {
  if(value===null) return true;
  try {
    const url=new URL(value);
    return url.origin===value&&!url.username&&!url.password&&(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)));
  }catch{return false;}
}
const corsHeaders={'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'WWW-Authenticate, MCP-Protocol-Version, Mcp-Session-Id, X-Request-Id',
  'Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
function json(data:unknown,status=200,extra:Record<string,string>={}) {
  return Response.json(data,{status,headers:{...corsHeaders,...extra}});
}
export function oauthChallenge(env:RuntimeEnv):string {
  try {return `Bearer realm="agent-mail", resource_metadata="${oauthConfig(env).issuer}/.well-known/oauth-protected-resource/mcp", scope="mail:read"`;}
  catch{return 'Bearer realm="agent-mail"';}
}
export function addMcpCors(response:Response,request:Request) {
  if(validOAuthOrigin(request.headers.get('Origin'))) {
    response.headers.set('Access-Control-Allow-Origin',request.headers.get('Origin')??'*');
    response.headers.set('Access-Control-Expose-Headers',corsHeaders['Access-Control-Expose-Headers']);
    response.headers.append('Vary','Origin');
  }
}
export async function checkMcpOrigin(request:Request,env:RuntimeEnv,actor:Actor) {
  const origin=request.headers.get('Origin');
  if(!validOAuthOrigin(origin)) throw new ServiceError('forbidden_origin',403);
  if(origin===null||origin===env.API_ORIGIN) return;
  if(actor.kind!=='token'||!actor.oauthGrantId) throw new ServiceError('forbidden_origin',403);
  const row=await env.DB.prepare('SELECT redirect_uri FROM oauth_authorization_codes WHERE grant_id=? LIMIT 1').bind(actor.oauthGrantId).first<{redirect_uri:string}>();
  if(!row||new URL(row.redirect_uri).origin!==origin) throw new ServiceError('forbidden_origin',403);
}
async function requestInput(request:Request,format:'json'|'form'):Promise<unknown> {
  const expected=format==='json'?'application/json':'application/x-www-form-urlencoded';
  if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!==expected) throw new OAuthError('invalid_request',415);
  if(!request.body) throw new OAuthError('invalid_request');
  let text:string;
  try {text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(await readBounded(request.body,16*1024));}
  catch(error) {throw new OAuthError('invalid_request',error instanceof ServiceError&&error.status===413?413:400);}
  if(format==='json') {try{return JSON.parse(text);}catch{throw new OAuthError('invalid_client_metadata');}}
  const params=new URLSearchParams(text),result:Record<string,string>=Object.create(null);
  for(const [key,value] of params) {if(Object.hasOwn(result,key)) throw new OAuthError('invalid_request');result[key]=value;}
  return result;
}
/** Called by the native fetch wrapper before Kit's CSRF gate, and by hooks in Vite development.
 * These public protocol endpoints use explicit PKCE credentials; Owner consent keeps normal hooks+CSRF. */
export async function handlePublicOAuth(request:Request,env:RuntimeEnv,requestId:string):Promise<Response|null> {
  const path=new URL(request.url).pathname,isMcpPreflight=path==='/mcp'&&request.method==='OPTIONS'&&request.headers.has('Origin');
  if(!publicPaths.includes(path)&&!isMcpPreflight) return null;
  if(!validOAuthOrigin(request.headers.get('Origin'))) return json({error:'invalid_request'},403,{'Access-Control-Allow-Origin':''});
  const metadata=path.startsWith('/.well-known/'),allowed=metadata?'GET, HEAD, OPTIONS':'POST, OPTIONS';
  if(request.method==='OPTIONS') {
    const method=request.headers.get('Access-Control-Request-Method');
    if(method&&!(metadata?['GET','HEAD']:['POST']).includes(method)) return json({error:'invalid_request'},405,{Allow:allowed});
    return new Response(null,{status:204,headers:{...corsHeaders,Allow:allowed,'Access-Control-Allow-Methods':metadata?'GET, HEAD':'POST',
      'Access-Control-Allow-Headers':'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id','Access-Control-Max-Age':'600'}});
  }
  if(!(metadata?['GET','HEAD']:['POST']).includes(request.method)) return json({error:'invalid_request'},405,{Allow:allowed});
  try {
    const config=oauthConfig(env);
    if(metadata) {
      const data=protectedPaths.includes(path)?{resource:config.resource,authorization_servers:[config.issuer],scopes_supported:[...oauthScopes],bearer_methods_supported:['header'],resource_name:'Agent Mail MCP'}:
        {issuer:config.issuer,authorization_endpoint:config.authorizationEndpoint,token_endpoint:`${config.issuer}/oauth/token`,registration_endpoint:`${config.issuer}/oauth/register`,
          revocation_endpoint:`${config.issuer}/oauth/revoke`,response_types_supported:['code'],response_modes_supported:['query'],grant_types_supported:['authorization_code','refresh_token'],
          token_endpoint_auth_methods_supported:['none'],revocation_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],
          scopes_supported:[...oauthScopes],authorization_response_iss_parameter_supported:true,client_id_metadata_document_supported:trustedCimdHosts(env).length>0};
      return request.method==='HEAD'?new Response(null,{headers:corsHeaders}):json(data);
    }
    if(path==='/oauth/register') return json(await registerOAuthClient(env,await requestInput(request,'json')),201);
    const input=await requestInput(request,'form') as Record<string,string>;
    if(request.headers.has('Authorization')||Object.hasOwn(input,'client_secret')) throw new OAuthError('invalid_client',401);
    if(path==='/oauth/token') return json(await exchangeOAuthToken(env,input,requestId));
    await revokeOAuthToken(env,input,requestId);
    return new Response(null,{status:200,headers:corsHeaders});
  }catch(error) {
    const known=error instanceof OAuthError,status=known?error.status:500;
    if(status>=500) console.error(JSON.stringify({code:known?error.error:'oauth_server_error',requestId}));
    return json({error:known?error.error:'server_error'},status,status===401&&request.headers.has('Authorization')?{'WWW-Authenticate':'Basic realm="agent-mail-oauth"'}:{});
  }
}
