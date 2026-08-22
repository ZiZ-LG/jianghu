import type { Account } from '../types';
import { computeGaps } from './gaps';
import { computeToday, type ReminderLite, type TodayItem } from './today';

/** Legacy sales-shell adapter. A no-pack/commercial shell calls computeToday directly. */
export function computeG64111Today(
  accounts: Account[],
  reminders: ReminderLite[],
  today: string,
  max = 3,
): TodayItem[] {
  const gapItems: TodayItem[] = [];
  for (const account of accounts) {
    for (const opportunity of account.opportunities) {
      if (opportunity.status && opportunity.status !== 'active') continue;
      const gap = computeGaps(account, opportunity)[0];
      if (!gap) continue;
      gapItems.push({
        icon: '🎒',
        text: gap.ask ?? gap.title,
        sub: `${account.name} · ${opportunity.name}`,
        accId: account.id,
        prio: 400 - gap.deficit,
      });
    }
  }
  return computeToday(accounts, reminders, today, max, gapItems);
}
