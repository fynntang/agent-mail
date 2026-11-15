import {getSetup} from '#lib/server/core/setup.ts';
import { api } from '#lib/server/svelte/api.ts';
import {ownerContext} from '#lib/server/svelte/owner.ts';

export const GET=api(async({locals})=>{
  const setup=await getSetup(ownerContext(locals));
  // Preserve the legacy two-field response; richer diagnostics live at /owner/api/setup.
  return Response.json({d1:setup.resources.d1,r2:setup.resources.r2});
});
