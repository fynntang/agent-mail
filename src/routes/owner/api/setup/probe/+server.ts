import {probeSetup} from '#lib/server/core/setup.ts';
import {ServiceError} from '#lib/server/core/types.ts';
import {api} from '#lib/server/svelte/api.ts';
import {jsonInput,ownerContext} from '#lib/server/svelte/owner.ts';

export const POST=api(async({locals,request})=>{
  const input=await jsonInput(request);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length) throw new ServiceError('invalid_input',400);
  return Response.json({probe:await probeSetup(ownerContext(locals))});
});
