import {error} from '@sveltejs/kit';
import {getSetup} from '#lib/server/core/setup.ts';
import {ServiceError} from '#lib/server/core/types.ts';
import {ownerContext} from '#lib/server/svelte/owner.ts';
import type {PageServerLoad} from './$types';

export const load:PageServerLoad=async({locals})=>{
  try {return {setup:await getSetup(ownerContext(locals))};}
  catch(cause) {
    if(cause instanceof ServiceError) error(cause.status,{message:'无法读取初始化状态，请检查资源绑定和数据库迁移后重试。'});
    throw cause;
  }
};
