#!/usr/bin/env node
/**
 * Anonymization test CLI — evaluate and tune the privacy pipeline offline.
 *
 * Usage:
 *   # From stdin
 *   echo "Send 50k USDC from Alice Johnson's vault" | npx tsx src/scripts/anon-test.ts
 *
 *   # From file
 *   npx tsx src/scripts/anon-test.ts --file sample.txt
 *
 *   # With LLM second pass (local model via Ollama)
 *   npx tsx src/scripts/anon-test.ts --file sample.txt --llm
 *   npx tsx src/scripts/anon-test.ts --file sample.txt --llm --model llama3.2 --base-url http://localhost:11434/v1
 *
 *   # With cloud LLM
 *   npx tsx src/scripts/anon-test.ts --file sample.txt --llm --provider anthropic --model claude-haiku-4-5-20251001
 *
 *   # Export patterns suggested by LLM to add to config
 *   npx tsx src/scripts/anon-test.ts --file sample.txt --llm --export-patterns ./new-patterns.json
 *
 *   # JSON output (for scripting)
 *   npx tsx src/scripts/anon-test.ts --file sample.txt --json
 *
 * This script does NOT require a running Argos instance or database.
 * It only reads the config file for anonymizer settings.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { Anonymizer } from '../privacy/anonymizer.js';
import { enhanceWithLlm, type LlmFinding } from '../privacy/llm-anonymizer.js';
import type { LLMConfig } from '../llm/index.js';

// ─── CLI args ─────────────────────────────────────────────────────────────────

interface CliArgs {
  file?: string;
  llm: boolean;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  minConfidence: 'high' | 'medium' | 'low';
  exportPatterns?: string;
  json: boolean;
  noColor: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    llm: false,
    provider: 'compatible',
    model: 'mistral',
    minConfidence: 'medium',
    json: false,
    noColor: !process.stdout.isTTY,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--file':
        args.file = argv[++i];
        break;
      case '--llm':
        args.llm = true;
        break;
      case '--provider':
        args.provider = argv[++i];
        break;
      case '--model':
        args.model = argv[++i];
        break;
      case '--base-url':
        args.baseUrl = argv[++i];
        break;
      case '--api-key':
        args.apiKey = argv[++i];
        break;
      case '--min-confidence':
        args.minConfidence = argv[++i] as CliArgs['minConfidence'];
        break;
      case '--export-patterns':
        args.exportPatterns = argv[++i];
        break;
      case '--json':
        args.json = true;
        break;
      case '--no-color':
        args.noColor = true;
        break;
    }
  }

  return args;
}

// ─── Console helpers ──────────────────────────────────────────────────────────

const c = {
  reset: (s: string, noColor: boolean) => (noColor ? s : `\x1b[0m${s}\x1b[0m`),
  bold: (s: string, noColor: boolean) => (noColor ? s : `\x1b[1m${s}\x1b[0m`),
  dim: (s: string, noColor: boolean) => (noColor ? s : `\x1b[2m${s}\x1b[0m`),
  green: (s: string, noColor: boolean) => (noColor ? s : `\x1b[32m${s}\x1b[0m`),
  yellow: (s: string, noColor: boolean) => (noColor ? s : `\x1b[33m${s}\x1b[0m`),
  red: (s: string, noColor: boolean) => (noColor ? s : `\x1b[31m${s}\x1b[0m`),
  cyan: (s: string, noColor: boolean) => (noColor ? s : `\x1b[36m${s}\x1b[0m`),
  magenta: (s: string, noColor: boolean) => (noColor ? s : `\x1b[35m${s}\x1b[0m`),
};

// ─── Read input ───────────────────────────────────────────────────────────────

async function readInput(file?: string): Promise<string> {
  if (file) {
    return readFileSync(file, 'utf-8');
  }

  // Read from stdin
  if (process.stdin.isTTY) {
    process.stderr.write('Paste text to anonymize (Ctrl+D when done):\n');
  }

  return new Promise((resolve) => {
    const rl = createInterface(process.stdin as never);
    const lines: string[] = [];
    rl.on('line', (line) => lines.push(line));
    rl.on('close', () => resolve(lines.join('\n')));
  });
}

// ─── Build anonymizer from env / defaults ─────────────────────────────────────

async function buildAnonymizer(): Promise<Anonymizer> {
  try {
    const { loadConfig } =
      (await import('../config/index.js')) as typeof import('../config/index.js');
    const config = loadConfig();
    return new Anonymizer(config.anonymizer);
  } catch {
    return new Anonymizer({
      mode: 'regex',
      knownPersons: [],
      bucketAmounts: true,
      anonymizeCryptoAddresses: false,
      customPatterns: [],
    });
  }
}

// ─── Diff display ─────────────────────────────────────────────────────────────

function showDiff(
  original: string,
  regexText: string,
  llmText: string | null,
  noColor: boolean,
): void {
  console.log(c.bold('\n── ORIGINAL ─────────────────────────────────────', noColor));
  console.log(original);

  console.log(c.bold('\n── REGEX PASS ───────────────────────────────────', noColor));
  console.log(c.yellow(regexText, noColor));

  if (llmText && llmText !== regexText) {
    console.log(c.bold('\n── LLM PASS (additional redactions) ────────────', noColor));
    console.log(c.green(llmText, noColor));
  } else if (llmText) {
    console.log(c.bold('\n── LLM PASS ─────────────────────────────────────', noColor));
    console.log(c.dim('(no additional redactions found)', noColor));
  }
}

// ─── Pattern export ───────────────────────────────────────────────────────────

function exportPatterns(findings: LlmFinding[], outputPath: string, noColor: boolean): void {
  // Convert LLM findings to custom pattern entries (literal string match)
  const patterns = findings
    .filter((f) => f.confidence !== 'low')
    .map((f) => ({
      pattern: f.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      replacement: `[${f.type.toUpperCase()}_CUSTOM]`,
      _comment: `LLM detected: ${f.reason ?? f.type}`,
    }));

  writeFileSync(outputPath, JSON.stringify(patterns, null, 2), 'utf-8');
  console.log(c.green(`\n✅ Exported ${patterns.length} pattern(s) to ${outputPath}`, noColor));
  console.log(c.dim('Add these to anonymizer.customPatterns in your .config.json', noColor));
}

// ─── Summary table ────────────────────────────────────────────────────────────

function showSummary(
  regexLookup: Record<string, string>,
  llmFindings?: LlmFinding[],
  tokensUsed?: number,
  noColor: boolean = false,
): void {
  console.log(c.bold('\n── REGEX REPLACEMENTS ───────────────────────────', noColor));

  if (Object.keys(regexLookup).length === 0) {
    console.log(c.dim('  (none)', noColor));
  } else {
    for (const [ph, original] of Object.entries(regexLookup)) {
      console.log(`  ${c.cyan(ph, noColor)} ← ${c.dim(original.slice(0, 60), noColor)}`);
    }
  }

  if (llmFindings) {
    console.log(c.bold('\n── LLM FINDINGS ─────────────────────────────────', noColor));

    if (llmFindings.length === 0) {
      console.log(c.dim('  (none — regex caught everything)', noColor));
    } else {
      const confColor = (conf: string) => {
        if (conf === 'high') return (s: string) => c.red(s, noColor);
        if (conf === 'medium') return (s: string) => c.yellow(s, noColor);
        return (s: string) => c.dim(s, noColor);
      };

      for (const f of llmFindings) {
        const col = confColor(f.confidence);
        const reason = f.reason ? c.dim(` — ${f.reason}`, noColor) : '';
        console.log(`  ${col(`[${f.type}]`)} "${f.text}"${reason}`);
      }
    }

    if (tokensUsed !== undefined) {
      console.log(c.dim(`\n  Tokens used: ${tokensUsed}`, noColor));
    }
  }

  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const noColor = args.noColor || args.json;

  const input = await readInput(args.file);

  if (!input.trim()) {
    process.stderr.write('No input provided.\n');
    process.exit(1);
  }

  // Regex pass
  const anonymizer = await buildAnonymizer();
  const regexResult = anonymizer.anonymize(input);

  // LLM pass (optional)
  let llmResult = null;

  if (args.llm) {
    const llmConfig: LLMConfig = {
      provider: args.provider as LLMConfig['provider'],
      model: args.model,
      apiKey: args.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? '',
      baseUrl:
        args.baseUrl ?? (args.provider === 'compatible' ? 'http://localhost:11434/v1' : undefined),
      maxTokens: 1024,
      temperature: 0,
    };

    if (!noColor && !args.json) {
      process.stderr.write(`\nRunning LLM pass with ${llmConfig.model}…\n`);
    }

    llmResult = await enhanceWithLlm(regexResult, llmConfig, {
      minConfidence: args.minConfidence,
    });
  }

  // JSON output mode (for scripting / CI)
  if (args.json) {
    const output = {
      original: input,
      regexText: regexResult.text,
      regexLookup: regexResult.lookup,
      regexReplacements: Object.keys(regexResult.lookup).length,
      ...(llmResult
        ? {
            llmText: llmResult.text,
            llmFindings: llmResult.llmFindings,
            llmApplied: llmResult.llmApplied,
            tokensUsed: llmResult.tokensUsed,
          }
        : {}),
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }

  // Human-readable output
  showDiff(input, regexResult.text, llmResult?.text ?? null, noColor);

  showSummary(regexResult.lookup, llmResult?.llmFindings, llmResult?.tokensUsed, noColor);

  // Export patterns if requested
  if (args.exportPatterns && llmResult) {
    exportPatterns(llmResult.llmFindings, args.exportPatterns, noColor);
  }
}

// Suppress "config not loaded" errors when running standalone
process.env.CONFIG_PATH = process.env.CONFIG_PATH ?? '~/.argos/.config.json';

main().catch((e) => {
  process.stderr.write(`Error: ${e.message ?? e}\n`);
  process.exit(1);
});
