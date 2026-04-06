/**
 * Argos Plugin Registry
 *
 * Plugins extend Argos without touching the core pipeline.
 * Each plugin is an independent module that reacts to lifecycle events.
 *
 * Lifecycle:
 *   onBoot     — called once after core is initialised (DB, LLM, channels ready)
 *   onMessage  — called for every inbound partner message (after sanitize+anonymize)
 *   onShutdown — called on SIGINT/SIGTERM before process exits
 *
 * Guarantees from the core:
 *   - onMessage is called AFTER sanitization — content is injection-checked
 *   - onMessage is called AFTER anonymization — content may still contain real data
 *     (anonymization result available as msg.anonText if plugin needs it)
 *   - Plugins run non-blocking (errors are caught and logged, never crash the core)
 *   - Plugin config is validated against pluginSchema at boot
 *
 * Distributing a plugin:
 *   1. Implement ArgosPlugin
 *   2. Export a factory: (config: PluginConfig) => ArgosPlugin
 *   3. User adds entry in config.json → "plugins": { "my-plugin": { "enabled": true, ... } }
 *   4. Register in their index.ts: pluginRegistry.register(myPlugin(config))
 */

import { createLogger } from '../logger.js';
import type { RawMessage } from '../types.js';
import type { Config } from '../config/schema.js';
import type { LLMConfig } from '../llm/index.js';

const log = createLogger('plugin-registry');

// ─── Context passed to every plugin hook ─────────────────────────────────────

export interface PluginContext {
  /** Full Argos config */
  config: Config;
  /** Primary LLM config (cloud) */
  llmConfig: LLMConfig;
  /** Privacy LLM config (local) — null if not configured */
  privacyConfig: LLMConfig | null;
  /** Send a notification to the owner (Saved Messages / approval chat) */
  notify: (text: string) => Promise<void>;
}

// ─── Plugin interface ─────────────────────────────────────────────────────────

export interface ArgosPlugin {
  /** Unique snake_case identifier — used as config key */
  readonly name: string;
  /** Human description shown in /status and logs */
  readonly description?: string;

  /** Called once after core boot. Use for DB migrations, cron registration, etc. */
  onBoot?(ctx: PluginContext): Promise<void>;

  /**
   * Called for every inbound partner message.
   * Runs in parallel with the core context-window pipeline (non-blocking).
   * msg.content is the raw (not yet anonymized) message text.
   */
  onMessage?(msg: RawMessage, ctx: PluginContext): Promise<void>;

  /** Called before process exits. Use to flush state, close connections. */
  onShutdown?(): Promise<void>;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

class PluginRegistry {
  private plugins: ArgosPlugin[] = [];

  register(plugin: ArgosPlugin): void {
    this.plugins.push(plugin);
    log.info(
      `Plugin registered: ${plugin.name}${plugin.description ? ` — ${plugin.description}` : ''}`,
    );
  }

  async emitBoot(ctx: PluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      if (!plugin.onBoot) continue;
      try {
        await plugin.onBoot(ctx);
        log.debug(`${plugin.name}: onBoot OK`);
      } catch (e) {
        log.error(`${plugin.name}: onBoot failed`, e);
      }
    }
  }

  /**
   * Fire onMessage for all plugins — non-blocking (Promise.allSettled).
   * Returns immediately; errors are logged but never propagate to the core.
   */
  emitMessage(msg: RawMessage, ctx: PluginContext): void {
    const active = this.plugins.filter((p) => p.onMessage);
    if (active.length === 0) return;

    Promise.allSettled(active.map((p) => p.onMessage!(msg, ctx))).then((results) => {
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          log.warn(
            `${active[i].name}: onMessage error`,
            (results[i] as PromiseRejectedResult).reason,
          );
        }
      }
    });
  }

  async emitShutdown(): Promise<void> {
    for (const plugin of this.plugins) {
      if (!plugin.onShutdown) continue;
      try {
        await plugin.onShutdown();
        log.debug(`${plugin.name}: onShutdown OK`);
      } catch (e) {
        log.warn(`${plugin.name}: onShutdown failed`, e);
      }
    }
  }

  list(): Array<{ name: string; description?: string }> {
    return this.plugins.map((p) => ({ name: p.name, description: p.description }));
  }
}

// Singleton — imported by index.ts and plugins that self-register
export const pluginRegistry = new PluginRegistry();
