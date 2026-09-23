/**
 * Priority vocabulary in one place (R038).
 */

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  P1: 'Urgent',
  P2: 'High',
  P3: 'Medium',
  P4: 'Low',
};

export const PRIORITY_COLORS: Record<Priority, { bg: string; text: string; border: string }> = {
  P1: { bg: 'bg-rose-500/10', text: 'text-rose-500', border: 'border-rose-500/30' },
  P2: { bg: 'bg-amber-500/10', text: 'text-amber-500', border: 'border-amber-500/30' },
  P3: { bg: 'bg-blue-500/10', text: 'text-blue-500', border: 'border-blue-500/30' },
  P4: { bg: 'bg-zinc-500/10', text: 'text-zinc-400', border: 'border-zinc-500/30' },
};
