/**
 * Calendar worker — Google Calendar read+write.
 * Reads are always allowed.
 * Writes only execute in non-read-only mode.
 */

import { createLogger } from '../logger.js';
import type { Config } from '../config/schema.js';
import type { WorkerResult } from './index.js';

const log = createLogger('calendar-worker');

export class CalendarWorker {
  constructor(private config: Config) {}

  private async getClient() {
    const calCfg = this.config.calendar;
    if (!calCfg) throw new Error('Calendar not configured');

    const { google } = await import('googleapis');
    const auth = new google.auth.OAuth2(
      calCfg.credentials.clientId,
      calCfg.credentials.clientSecret,
    );
    auth.setCredentials({ refresh_token: calCfg.credentials.refreshToken });
    return google.calendar({ version: 'v3', auth });
  }

  async listUpcoming(maxResults = 10): Promise<WorkerResult> {
    try {
      const calendar = await this.getClient();
      const calId = this.config.calendar!.calendarId;

      const response = await calendar.events.list({
        calendarId: calId,
        timeMin: new Date().toISOString(),
        maxResults,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = response.data.items ?? [];
      const output = events
        .map((e) => {
          const start = e.start?.dateTime ?? e.start?.date ?? '';
          return `• ${e.summary} @ ${new Date(start).toLocaleString('fr-FR')}`;
        })
        .join('\n');

      return {
        success: true,
        dryRun: false,
        output: output || '(no upcoming events)',
        data: events,
      };
    } catch (e) {
      log.error('Calendar list failed', e);
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  async createEvent(input: Record<string, unknown>): Promise<WorkerResult> {
    if (this.config.readOnly) {
      const preview = [
        `📅 Would create: *${input.title}*`,
        `⏰ ${input.start_time} → ${input.end_time}`,
        input.description ? `📝 ${input.description}` : null,
        input.attendees ? `👥 ${(input.attendees as string[]).join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n');

      return {
        success: true,
        dryRun: true,
        output: preview,
        data: input,
      };
    }

    try {
      const calendar = await this.getClient();
      const calId = this.config.calendar!.calendarId;

      const event = await calendar.events.insert({
        calendarId: calId,
        requestBody: {
          summary: input.title as string,
          description: (input.description as string | undefined) ?? '',
          start: { dateTime: input.start_time as string },
          end: { dateTime: input.end_time as string },
          attendees: (input.attendees as string[] | undefined)?.map((email) => ({ email })),
        },
      });

      log.info(`Calendar event created: ${event.data.id}`);
      return {
        success: true,
        dryRun: false,
        output: `Event created: ${input.title} — ${event.data.htmlLink}`,
        data: event.data,
      };
    } catch (e) {
      log.error('Calendar create failed', e);
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  async findFreeSlots(
    durationMin: number,
    from: Date,
    to: Date,
  ): Promise<Array<{ start: Date; end: Date }>> {
    const calendar = await this.getClient();
    const calId = this.config.calendar!.calendarId;

    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: [{ id: calId }],
      },
    });

    const busy = (response.data.calendars?.[calId]?.busy ?? []) as Array<{
      start?: string;
      end?: string;
    }>;
    const slots: Array<{ start: Date; end: Date }> = [];

    let cursor = from.getTime();
    const toMs = to.getTime();
    const durationMs = durationMin * 60 * 1000;

    for (const block of busy) {
      const blockStart = new Date(block.start!).getTime();
      if (cursor + durationMs <= blockStart) {
        slots.push({ start: new Date(cursor), end: new Date(cursor + durationMs) });
      }
      cursor = Math.max(cursor, new Date(block.end!).getTime());
    }

    if (cursor + durationMs <= toMs) {
      slots.push({ start: new Date(cursor), end: new Date(cursor + durationMs) });
    }

    return slots.slice(0, 3);
  }
}
