import {randomBytes} from 'node:crypto';
// Offline only. The explicit command prints a new wrapping key; keep its output private.
process.stdout.write(JSON.stringify({activeKid:'primary',keys:{primary:randomBytes(32).toString('base64url')}})+'\n');
