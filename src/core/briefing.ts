/**
 * Task briefing — sent 3x/day (morning, noon, evening).
 *
 * Groups open tasks by owner (my_task) and team (team_task).
 * Future: when multi-user, routes each team's tasks to their own chat.
 */

import { getDb, audit } from '../db/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('briefing');

type Period = 'morning' | 'noon' | 'evening';

interface TaskRow {
  id:            string;
  title:         string;
  partner_name:  string | null;
  assigned_team: string | null;
  is_my_task:    number;
  detected_at:   number;
}

export async function sendTaskBriefing(
  period: Period,
  sendFn: (text: string) => Promise<void>,
): Promise<void> {
  const db = getDb();

  const tasks = db.prepare(`
    SELECT id, title, partner_name, assigned_team, is_my_task, detected_at
    FROM tasks
    WHERE status = 'open' OR status = 'in_progress'
    ORDER BY is_my_task DESC, detected_at ASC
    LIMIT 30
  `).all() as TaskRow[];

  const icons  = { morning: '☀️', noon: '🌤', evening: '🌙' } as const;
  const labels = { morning: 'Bonjour', noon: 'Mi-journée', evening: 'Récap du soir' } as const;

  if (tasks.length === 0) {
    if (period === 'morning') await sendFn(`${icons[period]} *${labels[period]}* — aucune task en attente. Bonne journée !`);
    log.info(`Briefing ${period}: no open tasks`);
    return;
  }

  const myTasks   = tasks.filter(t => t.is_my_task === 1);
  const teamTasks = tasks.filter(t => t.is_my_task === 0);

  const lines: string[] = [
    `${icons[period]} *${labels[period]}* — ${tasks.length} task(s) ouverte(s)\n`,
  ];

  if (myTasks.length) {
    lines.push('*📋 Mes tâches*');
    for (const t of myTasks) {
      const partner = t.partner_name ? ` _(${t.partner_name})_` : '';
      lines.push(`• ${t.title.slice(0, 80)}${partner}`);
    }
    lines.push('');
  }

  if (teamTasks.length) {
    // Group by assigned_team
    const byTeam = new Map<string, TaskRow[]>();
    for (const t of teamTasks) {
      const team = t.assigned_team ?? 'Autre';
      if (!byTeam.has(team)) byTeam.set(team, []);
      byTeam.get(team)!.push(t);
    }
    for (const [team, tTasks] of byTeam) {
      lines.push(`*👥 ${team}*`);
      for (const t of tTasks) {
        const partner = t.partner_name ? ` _(${t.partner_name})_` : '';
        lines.push(`• ${t.title.slice(0, 80)}${partner}`);
      }
      lines.push('');
    }
  }

  const msg = lines.join('\n').trim();
  await sendFn(msg);

  log.info(`Briefing ${period} sent — ${tasks.length} tasks (${myTasks.length} mine, ${teamTasks.length} team)`);
  audit('briefing_sent', period, 'briefing', { total: tasks.length, mine: myTasks.length, team: teamTasks.length });
}
