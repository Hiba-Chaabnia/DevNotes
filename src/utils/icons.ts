import type { IconNode as LucideNode } from 'lucide';
import * as AllLucide from 'lucide';

export type { LucideNode };
export const ALL_LUCIDE_NODES: Record<string, LucideNode> = Object.fromEntries(
  Object.entries(AllLucide as Record<string, unknown>).filter(([, v]) => Array.isArray(v))
) as Record<string, LucideNode>;
