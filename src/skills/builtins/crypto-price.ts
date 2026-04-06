/**
 * crypto_price skill — get token prices from CoinGecko.
 * Free tier, no API key required.
 */

import { registerSkill } from '../registry.js';

registerSkill({
  name: 'crypto_price',
  description: 'Get current cryptocurrency prices from CoinGecko',
  tool: {
    name: 'crypto_price',
    description: 'Get the current price and 24h change for one or more cryptocurrencies.',
    input_schema: {
      type: 'object',
      properties: {
        tokens: {
          type: 'string',
          description:
            'Comma-separated token IDs as used by CoinGecko (e.g. "bitcoin,ethereum,solana")',
        },
        vs_currency: {
          type: 'string',
          description: 'Quote currency (default: usd)',
        },
      },
      required: ['tokens'],
    },
  },
  handler: async (input) => {
    const tokens = String(input.tokens ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
      .join(',');

    if (!tokens) {
      return { success: false, output: 'No tokens specified' };
    }

    const vs = String(input.vs_currency ?? 'usd').toLowerCase();

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(tokens)}&vs_currencies=${vs}&include_24hr_change=true&include_market_cap=true`;

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { success: false, output: `CoinGecko error: ${res.status}` };
    }

    const data = (await res.json()) as Record<string, CoinGeckoEntry>;

    if (Object.keys(data).length === 0) {
      return {
        success: false,
        output: `No data found for: ${tokens}. Check the CoinGecko IDs (e.g. "bitcoin" not "BTC").`,
      };
    }

    const lines = Object.entries(data).map(([id, vals]) => {
      const price = vals[vs];
      const change = vals[`${vs}_24h_change`];
      const mcap = vals[`${vs}_market_cap`];

      const changeStr =
        change !== null && change !== undefined
          ? ` (${change >= 0 ? '+' : ''}${change.toFixed(2)}% 24h)`
          : '';

      const mcapStr =
        mcap !== null && mcap !== undefined ? ` | MCap: ${formatLargeNumber(mcap, vs)}` : '';

      return `**${id.toUpperCase()}**: ${formatPrice(price, vs)}${changeStr}${mcapStr}`;
    });

    return { success: true, output: lines.join('\n'), data };
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPrice(price: number | undefined, currency: string): string {
  if (price === null || price === undefined) return 'N/A';
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency.toUpperCase() + ' ';
  if (price >= 1000)
    return `${symbol}${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (price >= 1) return `${symbol}${price.toFixed(4)}`;
  return `${symbol}${price.toFixed(8)}`;
}

function formatLargeNumber(n: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency.toUpperCase() + ' ';
  if (n >= 1e12) return `${symbol}${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${symbol}${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${symbol}${(n / 1e6).toFixed(2)}M`;
  return `${symbol}${n.toLocaleString('en-US')}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  usd: '$',
  eur: '€',
  gbp: '£',
  btc: '₿',
  eth: 'Ξ',
};

interface CoinGeckoEntry {
  [key: string]: number;
}
