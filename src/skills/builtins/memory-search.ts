/**
 * memory_search skill — explicit FTS search in Argos memory.
 * Useful when Claude needs to retrieve past context on demand.
 */

import { registerSkill } from '../registry.js';
import { search } from '../../memory/store.js';

registerSkill({
  name: 'memory_search',
  description: 'Search Argos memory for past context, conversations, and stored information',
  tool: {
    name: 'memory_search',
    description: 'Search Argos memory (FTS5) for relevant past context, partner interactions, tasks, or stored notes.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — keywords or phrases to find in memory',
        },
        partner_name: {
          type: 'string',
          description: 'Filter by partner name (optional)',
        },
        category: {
          type: 'string',
          description: 'Filter by category: context, task, partner, deal, tx_review (optional)',
        },
        limit: {
          type: 'string',
          description: 'Max results (default: 10)',
        },
      },
      required: ['query'],
    },
  },
  handler: async (input) => {
    const query = String(input.query ?? '').trim();
    if (!query) return { success: false, output: 'query is required' };

    const limit = Math.min(Number(input.limit ?? 10), 25);
    const partnerName = input.partner_name ? String(input.partner_name) : undefined;

    const results = search({ query, partnerName, limit });

    if (results.length === 0) {
      return {
        success: true,
        output: `No memories found for: "${query}"`,
      };
    }

    // Filter by category if requested
    const categoryFilter = input.category ? String(input.category) : null;
    const filtered = categoryFilter
      ? results.filter(m => m.category === categoryFilter)
      : results;

    if (filtered.length === 0) {
      return {
        success: true,
        output: `No memories in category "${categoryFilter}" for: "${query}"`,
      };
    }

    const lines = filtered.map(m => {
      const date = new Date(m.createdAt).toLocaleDateString('en-GB');
      const partner = m.partnerName ? ` | Partner: ${m.partnerName}` : '';
      const cat = m.category ? ` | [${m.category}]` : '';
      const imp = m.importance ? ` | importance: ${m.importance}/10` : '';
      return `**[${date}${partner}${cat}${imp}]**\n${m.content}`;
    });

    return {
      success: true,
      output: `Found ${filtered.length} memory entry(ies):\n\n${lines.join('\n\n')}`,
      data: filtered,
    };
  },
});
