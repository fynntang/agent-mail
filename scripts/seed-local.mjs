// Local-only developer fixture. No HTTP seed route, remote flags or Owner bypass.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './sync-svelte-config.mjs';

const config = parseJsonc(await readFile('wrangler.jsonc','utf8'));
const local = process.argv[2] ?? 'research';
if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(local)) throw new Error('Usage: pnpm local:seed [local-part]');
const address = `${local}@${config.vars.MAIL_DOMAIN}`;
if (!/^[a-z0-9_-]+@[a-z0-9.-]+$/.test(address)) throw new Error('Invalid local mail domain');
const id=randomUUID(), tokenId=randomUUID(), now=Date.now();
const token=`am_${tokenId}_${randomBytes(32).toString('base64url')}`;
const hash=createHash('sha256').update(token).digest('hex');
const path=`.wrangler/seed/${id}.sql`;
await mkdir('.wrangler/seed',{recursive:true});
await writeFile(path,`INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES('${id}','Local ${local}',${now},${now});
INSERT INTO mailbox_addresses(id,mailbox_id,address,is_primary,created_at) VALUES('${randomUUID()}','${id}','${address}',1,${now});
INSERT INTO mailbox_tokens(id,mailbox_id,name,secret_sha256,created_at) VALUES('${tokenId}','${id}','Local development','${hash}',${now});
`);
try {
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url)),
    'd1','execute','DB','--config','wrangler.jsonc','--local','--persist-to','.wrangler/state','--file',path],{encoding:'utf8'});
  if(result.status!==0) {
    process.stderr.write(result.stderr||result.stdout);
    process.exitCode=1;
  } else console.log(`Local mailbox: ${address}\nMailbox ID: ${id}\nRead-only token (shown once): ${token}\nOnly the SHA-256 digest is stored in local D1.`);
} finally { await unlink(path); }
