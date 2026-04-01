/**
 * Browser action worker — Puppeteer automation with credential injection.
 *
 * SECURITY MODEL:
 *   - The planner proposes actions with a credential_ref (name only, no value)
 *   - The owner approves the proposal
 *   - This worker resolves the credential at execution time via credentials.ts
 *   - The actual secret values are NEVER logged, never stored, never sent to LLM
 *
 * Supported actions:
 *   navigate      → go to URL
 *   fill          → fill a form field (selector + value or credential field)
 *   click         → click an element
 *   screenshot    → capture and save to ~/.argos/context/
 *   wait          → wait for selector or delay
 *   extract       → extract text from selector (returned as output)
 *   submit        → submit a form
 *
 * Read-only mode:
 *   Returns a dry-run description of what would happen — no browser launched.
 *
 * Requires: @modelcontextprotocol/server-puppeteer OR puppeteer installed.
 */

import path from 'path';
import { createLogger } from '../logger.js';
import { resolveCredential, redactCredential } from './credentials.js';
import type { Config } from '../config/schema.js';
import type { WorkerResult } from './index.js';

const log = createLogger('browser-action');

// ─── Action types ─────────────────────────────────────────────────────────────

export interface BrowserStep {
  action:   'navigate' | 'fill' | 'click' | 'screenshot' | 'wait' | 'extract' | 'submit';
  selector?: string;
  /** Static value to fill — use credential_field instead for secrets */
  value?:    string;
  /** Which field from the resolved credential to use: username | password | token | cardNumber | cardExpiry | cardCvv | value */
  credential_field?: keyof import('./credentials.js').ResolvedCredential;
  url?:      string;
  /** ms or CSS selector to wait for */
  wait_for?: string | number;
  /** Screenshot filename (saved to ~/.argos/context/) */
  filename?: string;
}

// ─── Browser action worker ────────────────────────────────────────────────────

export class BrowserActionWorker {
  constructor(private config: Config) {}

  async execute(input: Record<string, unknown>): Promise<WorkerResult> {
    const steps        = (input.steps as BrowserStep[]) ?? [];
    const credentialRef = input.credential_ref as string | undefined;
    const description  = String(input.description ?? 'browser automation');

    if (!steps.length) {
      return { success: false, dryRun: false, output: 'browser_action: steps array is required' };
    }

    // ── Draft mode ─────────────────────────────────────────────────────────────
    if (this.config.readOnly) {
      const preview = steps.map((s, i) => {
        const cred = s.credential_field ? ` [${s.credential_field}: ***]` : '';
        const val  = s.value ? ` "${s.value.slice(0, 30)}"` : '';
        return `  ${i + 1}. ${s.action}${s.selector ? ` → ${s.selector}` : ''}${s.url ? ` → ${s.url}` : ''}${val}${cred}`;
      }).join('\n');

      return {
        success: true,
        dryRun:  true,
        output:  `🌐 [DRAFT] ${description}\n${preview}${credentialRef ? `\n  Credential: ${credentialRef}` : ''}`,
      };
    }

    // ── Resolve credential if referenced ──────────────────────────────────────
    let credential: Awaited<ReturnType<typeof resolveCredential>> | null = null;
    if (credentialRef) {
      try {
        credential = await resolveCredential(credentialRef, this.config.secrets ?? {});
        log.info(`Credential resolved for browser action: ${JSON.stringify(redactCredential(credential))}`);
      } catch (e) {
        return { success: false, dryRun: false, output: `Credential error: ${(e as Error).message}` };
      }
    }

    // ── Launch Puppeteer ───────────────────────────────────────────────────────
    // puppeteer is optional — not in package.json. Install separately if needed.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore optional peer dependency
    const puppeteer = await import('puppeteer').catch(() => null) as null | {
      launch: (opts: unknown) => Promise<{ newPage: () => Promise<unknown>; close: () => Promise<void> }>;
    };
    if (!puppeteer) {
      return { success: false, dryRun: false, output: 'puppeteer not installed. Run: npm install puppeteer' };
    }

    const browser = await puppeteer.launch({ headless: true });
    const page    = await browser.newPage();
    const outputs: string[] = [];

    try {
      for (const step of steps) {
        await this.executeStep(page, step, credential, outputs);
      }

      await browser.close();
      log.info(`Browser action completed: ${description} (${steps.length} steps)`);

      return {
        success: true,
        dryRun:  false,
        output:  `✅ ${description}\n${outputs.join('\n')}`,
        data:    { steps: steps.length, outputs },
      };
    } catch (e) {
      await browser.close().catch(() => {});
      log.error('Browser action failed', e);
      return { success: false, dryRun: false, output: `❌ Browser action failed: ${(e as Error).message}` };
    }
  }

  // ─── Execute a single step ─────────────────────────────────────────────────

  private async executeStep(
    page: unknown,
    step: BrowserStep,
    credential: Awaited<ReturnType<typeof resolveCredential>> | null,
    outputs: string[],
  ): Promise<void> {
    const p = page as {
      goto:       (url: string, opts?: unknown) => Promise<unknown>;
      waitForSelector: (sel: string, opts?: unknown) => Promise<unknown>;
      click:      (sel: string) => Promise<void>;
      type:       (sel: string, text: string) => Promise<void>;
      screenshot: (opts: unknown) => Promise<Buffer>;
      evaluate:   (fn: (sel: string) => string, sel: string) => Promise<string>;
      waitForTimeout: (ms: number) => Promise<void>;
    };

    switch (step.action) {
      case 'navigate':
        if (!step.url) throw new Error('navigate: url is required');
        await p.goto(step.url, { waitUntil: 'networkidle2', timeout: 30_000 });
        outputs.push(`→ navigated to ${step.url}`);
        break;

      case 'fill': {
        if (!step.selector) throw new Error('fill: selector is required');
        await p.waitForSelector(step.selector, { timeout: 10_000 });

        // Resolve value: static or from credential
        let fillValue: string;
        if (step.credential_field && credential) {
          const val = credential[step.credential_field];
          if (!val) throw new Error(`fill: credential field "${step.credential_field}" not found in resolved credential`);
          fillValue = val;
        } else if (step.value !== undefined) {
          fillValue = step.value;
        } else {
          throw new Error('fill: provide value or credential_field');
        }

        await p.type(step.selector, fillValue);
        // Log with credential values redacted
        const logVal = step.credential_field ? '***' : step.value?.slice(0, 20);
        outputs.push(`→ filled ${step.selector} = ${logVal}`);
        break;
      }

      case 'click':
        if (!step.selector) throw new Error('click: selector is required');
        await p.waitForSelector(step.selector, { timeout: 10_000 });
        await p.click(step.selector);
        outputs.push(`→ clicked ${step.selector}`);
        break;

      case 'submit':
        if (!step.selector) throw new Error('submit: selector is required');
        await p.click(step.selector);
        outputs.push(`→ submitted ${step.selector}`);
        break;

      case 'wait': {
        if (typeof step.wait_for === 'number') {
          await p.waitForTimeout(step.wait_for);
          outputs.push(`→ waited ${step.wait_for}ms`);
        } else if (step.wait_for) {
          await p.waitForSelector(step.wait_for, { timeout: 15_000 });
          outputs.push(`→ waited for ${step.wait_for}`);
        }
        break;
      }

      case 'screenshot': {
        const { getDataDir } = await import('../config/index.js');
        const filename = step.filename ?? `screenshot_${Date.now()}.png`;
        const filePath = path.join(getDataDir(), 'context', filename);
        await p.screenshot({ path: filePath, fullPage: false });
        outputs.push(`→ screenshot saved: context/${filename}`);
        break;
      }

      case 'extract': {
        if (!step.selector) throw new Error('extract: selector is required');
        await p.waitForSelector(step.selector, { timeout: 10_000 });
        // page.evaluate runs inside the browser — document exists there, not in Node.
        // We pass a serialized function string to avoid TS DOM lib requirement.
        const evalFn = `(sel) => { const el = document.querySelector(sel); return el ? (el.textContent || '').trim() : ''; }`;
        const text = await (p as unknown as { evaluate: (fn: string, sel: string) => Promise<string> })
          .evaluate(evalFn, step.selector);
        outputs.push(`→ extracted from ${step.selector}: "${text.slice(0, 200)}"`);
        break;
      }

      default:
        throw new Error(`Unknown browser action: ${(step as BrowserStep).action}`);
    }
  }
}
