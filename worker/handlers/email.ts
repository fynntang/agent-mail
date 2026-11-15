import { ingestEmail } from '../../src/lib/server/core/ingest';
import type { RuntimeEnv } from '../../src/lib/server/core/types';

export async function handleEmail(message: ForwardableEmailMessage, env: RuntimeEnv): Promise<void> {
  await ingestEmail(message,env);
}
