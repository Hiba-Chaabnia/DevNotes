import type { IconNode as LucideNode } from 'lucide';

export type { LucideNode };

let _cache: Record<string, LucideNode> | undefined;

function nodes(): Record<string, LucideNode> {
  if (!_cache) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('lucide') as Record<string, unknown>;
    _cache = Object.fromEntries(
      Object.entries(mod).filter(([, v]) => Array.isArray(v))
    ) as Record<string, LucideNode>;
  }
  return _cache;
}

export const ALL_LUCIDE_NODES: Record<string, LucideNode> = new Proxy(
  {} as Record<string, LucideNode>,
  {
    get(_, key: string)   { return nodes()[key]; },
    has(_, key: string)   { return key in nodes(); },
    ownKeys()             { return Object.keys(nodes()); },
    getOwnPropertyDescriptor(_, key: string) {
      const val = nodes()[key];
      return val ? { value: val, writable: false, enumerable: true, configurable: true } : undefined;
    },
  }
);
