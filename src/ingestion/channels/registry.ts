/**
 * Channel registry — NanoClaw-inspired pattern.
 * Channels self-register here. The main bot polls all registered channels.
 *
 * Adding a new channel (e.g. WhatsApp, Slack, Discord):
 *   1. Create src/ingestion/channels/whatsapp.ts
 *   2. Implement the Channel interface
 *   3. Register it in src/index.ts
 *
 * Current channels:
 *   - telegram (active)
 *   - whatsapp (stub — register when Baileys is configured)
 */

import type { RawMessage } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('channel-registry');

export interface Channel {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  // Called by the channel when a new message arrives
  onMessage: (handler: (msg: RawMessage) => Promise<void>) => void;
}

const channels = new Map<string, Channel>();

export function registerChannel(channel: Channel): void {
  channels.set(channel.name, channel);
  log.info(`Channel registered: ${channel.name}`);
}

export async function startAllChannels(
  onMessage: (msg: RawMessage) => Promise<void>,
): Promise<void> {
  for (const channel of channels.values()) {
    channel.onMessage(onMessage);
    await channel.start();
    log.info(`Channel started: ${channel.name}`);
  }
}

export async function stopAllChannels(): Promise<void> {
  for (const channel of channels.values()) {
    await channel.stop();
  }
}

export function getChannel(name: string): Channel | undefined {
  return channels.get(name);
}
