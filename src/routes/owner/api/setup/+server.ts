import {getSetup,updateSetup} from '#lib/server/core/setup.ts';
import {api} from '#lib/server/svelte/api.ts';
import {jsonInput,ownerContext} from '#lib/server/svelte/owner.ts';

export const GET=api(async({locals})=>Response.json({setup:await getSetup(ownerContext(locals))}));
export const POST=api(async({locals,request})=>Response.json({setup:await updateSetup(ownerContext(locals),await jsonInput(request))}));
