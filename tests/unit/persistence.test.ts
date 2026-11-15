import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { ingestEmail } from '../../src/lib/server/core/ingest';
import { claimParseJob, parseEmail, runScheduled } from '../../src/lib/server/core/jobs';
import type { RuntimeEnv } from '../../src/lib/server/core/types';

let mf: Miniflare;
let env: RuntimeEnv;
let raw: Uint8Array;
beforeAll(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'core-test',modules:true,script:'export default {fetch(){return new Response("test");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'core-test'},r2Buckets:{MAIL_BLOBS:'core-test'}}],log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort()) {
    await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(statement=>db.prepare(statement)));
  }
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com'} as unknown as RuntimeEnv;
  raw=new Uint8Array(await readFile('tests/fixtures/inbound.eml'));
},60_000);
afterAll(async()=>{await mf?.dispose();});

async function mailbox() {
  const id=crypto.randomUUID(),now=Date.now();
  const address=`test-${id}@agent.example.com`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES(?,?,?,?)').bind(id,'Test',now,now),
    env.DB.prepare('INSERT INTO mailbox_addresses(id,mailbox_id,address,created_at) VALUES(?,?,?,?)').bind(crypto.randomUUID(),id,address,now)
  ]);
  const message={from:'sender@example.net',to:address,rawSize:raw.byteLength,
    raw:new Response(raw as Uint8Array<ArrayBuffer>).body,setReject(){throw new Error('unexpected_rejection');}} as unknown as ForwardableEmailMessage;
  return {id,message};
}

it('keeps pending metadata and does not enqueue parsing when R2 fails',async()=>{
  const {id,message}=await mailbox();
  const unavailable={...env,MAIL_BLOBS:{put:async()=>{throw new Error('injected_r2_failure');}}} as unknown as RuntimeEnv;
  await expect(ingestEmail(message,unavailable)).rejects.toThrow('injected_r2_failure');
  expect(await env.DB.prepare('SELECT status FROM ingest_receipts WHERE mailbox_id=?').bind(id).first('status')).toBe('pending_blob');
  expect(await env.DB.prepare('SELECT count(*) n FROM jobs WHERE mailbox_id=?').bind(id).first('n')).toBe(0);
  expect(await env.DB.prepare('SELECT state FROM objects WHERE mailbox_id=?').bind(id).first('state')).toBe('pending');
});

it('an old lease cannot publish any D1 products or ACK the new lease',async()=>{
  const {id,message}=await mailbox();
  const receiptId=await ingestEmail(message,env);
  const job=await claimParseJob(env,Date.now());
  expect(job!.mailbox_id).toBe(id);
  await env.DB.prepare("UPDATE jobs SET lease_token='new-lease',lease_until=? WHERE id=?").bind(Date.now()+60_000,job!.id).run();
  expect(await parseEmail(env,job!)).toBe(false);
  expect(await env.DB.prepare('SELECT count(*) n FROM messages WHERE mailbox_id=?').bind(id).first('n')).toBe(0);
  expect(await env.DB.prepare("SELECT count(*) n FROM objects WHERE mailbox_id=? AND purpose='body'").bind(id).first('n')).toBe(0);
  expect(await env.DB.prepare('SELECT status FROM ingest_receipts WHERE id=?').bind(receiptId).first('status')).toBe('stored');
  expect(await env.DB.prepare('SELECT lease_token FROM jobs WHERE id=?').bind(job!.id).first('lease_token')).toBe('new-lease');
  await env.DB.prepare("UPDATE jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=?").bind(job!.id).run();
});

it('a mismatching immutable body is retried without publishing a false ready message',async()=>{
  const {id,message}=await mailbox();
  const receiptId=await ingestEmail(message,env);
  const bodyKey=`${id}/body/v3/${receiptId}.json`;
  await env.MAIL_BLOBS.put(bodyKey,'corrupt derived content');
  const result=await runScheduled(env);
  expect(result.failed).toBe(1);
  const job=await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(receiptId).first();
  expect(job!.state).toBe('pending'); expect(job!.last_error_code).toBe('body_object_conflict');
  expect(job!.lease_token).toBeNull(); expect(job!.attempts).toBe(1);
  expect(await env.DB.prepare('SELECT count(*) n FROM messages WHERE mailbox_id=?').bind(id).first('n')).toBe(0);
  await env.MAIL_BLOBS.delete(bodyKey);
  await env.DB.prepare('UPDATE jobs SET available_at=? WHERE id=?').bind(Date.now(),receiptId).run();
  expect((await runScheduled(env)).completed).toBe(1);
  expect(await env.DB.prepare('SELECT count(*) n FROM messages WHERE mailbox_id=?').bind(id).first('n')).toBe(1);
});
