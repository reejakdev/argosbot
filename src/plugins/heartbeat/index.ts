/**
 * Heartbeat plugin.
 *
 * Wraps the heartbeat engine in the ArgosPlugin interface so it can be
 * registered via pluginRegistry like any other plugin.
 *
 * onBoot:
 *   - Registers the proactive_plan cron handler
 *   - Upserts the heartbeat cron job if heartbeat is enabled in config
 *
 * The underlying heartbeat engine lives in src/heartbeat/index.ts.
 * This wrapper is the integration point with the plugin system.
 */

import { createLogger } from '../../logger.js';
import { registerHandler, upsertCronJob } from '../../scheduler/index.js';
import { runProactivePlan } from '../../heartbeat/index.js';
import type { ArgosPlugin, PluginContext } from '../registry.js';

const log = createLogger('plugin:heartbeat');

export function createHeartbeatPlugin(): ArgosPlugin {
  return {
    name: 'heartbeat',
    description: 'Proactive monitoring — wakes up on a schedule to check if anything needs doing',

    async onBoot(ctx: PluginContext): Promise<void> {
      const { config } = ctx;

      // Register the handler used by agent-created cron jobs
      registerHandler('proactive_plan', async (jobConfig) => {
        await runProactivePlan(config, {
          prompt: String(jobConfig.prompt ?? ''),
          label: String(jobConfig.description ?? 'agent_cron'),
          sendToApprovalChat: ctx.notify,
        });
      });

      if (!config.heartbeat?.enabled) {
        log.debug('Heartbeat disabled — skipping cron registration');
        return;
      }

      const intervalMin = config.heartbeat.intervalMinutes ?? 60;
      const cronExpr =
        intervalMin < 60 ? `*/${intervalMin} * * * *` : `0 */${Math.round(intervalMin / 60)} * * *`;

      upsertCronJob('heartbeat', cronExpr, 'proactive_plan', {
        prompt: config.heartbeat.prompt ?? '',
        description: 'heartbeat',
      });

      log.info(`Heartbeat registered — every ${intervalMin} min [${cronExpr}]`);
    },
  };
}
