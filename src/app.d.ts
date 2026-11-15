import type { Actor } from './lib/server/core/types';

declare global {
  namespace App {
    interface Locals {
      actor: Actor | null;
      requestId: string;
    }
  }
}

export {};
