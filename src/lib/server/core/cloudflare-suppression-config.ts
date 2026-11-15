import type {RuntimeEnv} from './types';

/** Only public configuration leaves this helper. Credentials remain in the Worker secret binding. */
export function cloudflareSuppressionIdentity(env:RuntimeEnv):{accountId:string;domain:string}|null {
  const account=env.EMAIL_SUPPRESSIONS_ACCOUNT_ID,domain=env.EMAIL_SUPPRESSIONS_DOMAIN;
  if(typeof account!=='string'||!/^[a-f0-9]{32}$/i.test(account)||typeof domain!=='string'||domain.length>253||!domain.includes('.')||domain!==domain.toLowerCase()
    ||!domain.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))return null;
  return {accountId:account.toLowerCase(),domain};
}
export function cloudflareSuppressionConfig(env:RuntimeEnv):{accountId:string;domain:string}|null {
  const token=env.EMAIL_SUPPRESSIONS_API_TOKEN;
  return typeof token==='string'&&/^[\x21-\x7e]{20,4096}$/.test(token)?cloudflareSuppressionIdentity(env):null;
}
