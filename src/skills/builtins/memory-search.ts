/**
 * memory_search skill — FTS search in Argos memory + vector search in knowledge docs.
 *
 * Combines two sources:
 *   1. FTS5 memories (past conversations, summaries, tasks)
 *   2. Vector/semantic search in indexed knowledge docs (GitHub files, URLs, Notion pages)
 *
 * This is the primary way the planner retrieves specific data like addresses,
 * token names, contract references, etc. stored in knowledge sources.
 */

import { registerSkill } from '../registry.js';
import { search } from '../../memory/store.js';

registerSkill({
  name: 'memory_search',
  description:
    'Search Argos memory and knowledge sources for past context, addresses, docs, and stored information',
  tool: {
    name: 'memory_search',
    description:
      'Search Argos memory (FTS5) AND indexed knowledge docs (semantic vector search) for relevant context, addresses, partner interactions, or stored notes. Use this to find specific data like contract addresses, token names, past decisions.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — keywords or phrases to find in memory and knowledge docs',
        },
        partner_name: {
          type: 'string',
          description: 'Filter memories by partner name (optional)',
        },
        category: {
          type: 'string',
          description: 'Filter by category: context, task, partner, deal, tx_review (optional)',
        },
        limit: {
          type: 'string',
          description: 'Max results per source (default: 10)',
        },
      },
      required: ['query'],
    },
  },
  handler: async (input, _cfg) => {
    const query = String(input.query ?? '').trim();
    if (!query) return { success: false, output: 'query is required' };

    const limit = Math.min(Number(input.limit ?? 10), 25);
    const partnerName = input.partner_name ? String(input.partner_name) : undefined;

    // ── 1. FTS memory search ──────────────────────────────────────────────────
    const memResults = search({ query, partnerName, limit });

    const categoryFilter = input.category ? String(input.category) : null;
    const filtered = categoryFilter
      ? memResults.filter((m) => m.category === categoryFilter)
      : memResults;

    const memLines = filtered.map((m) => {
      const date = new Date(m.createdAt).toLocaleDateString('en-GB');
      const partner = m.partnerName ? ` | Partner: ${m.partnerName}` : '';
      const cat = m.category ? ` | [${m.category}]` : '';
      const imp = m.importance ? ` | importance: ${m.importance}/10` : '';
      return `**[${date}${partner}${cat}${imp}]**\n${m.content}`;
    });

    // ── 2. Semantic vector search — knowledge docs + vectorized memories ────
    let knowledgeLines: string[] = [];
    let vecMemLines: string[] = [];
    try {
      const { loadConfig } = await import('../../config/index.js');
      const fullConfig = loadConfig();
      const embCfg = (
        fullConfig as unknown as { embeddings?: import('../../config/schema.js').EmbeddingsConfig }
      ).embeddings;
      if (embCfg?.enabled) {
        const { hybridSearch } = await import('../../vector/store.js');

        // Search knowledge docs (github:, doc:, url:) — minSimilarity lowered so
        // keyword hits always surface even when semantic score is weak
        const knowledgeResults = await hybridSearch(query, embCfg, { topK: 5, minSimilarity: 0.2 });
        const docResults = knowledgeResults.filter((r) => !r.chunk.sourceRef.startsWith('memory:'));
        const memVecResults = knowledgeResults.filter((r) =>
          r.chunk.sourceRef.startsWith('memory:'),
        );

        knowledgeLines = docResults.map((r) => {
          const src = r.chunk.sourceRef ?? 'unknown';
          const score = r.similarity.toFixed(2);
          return `**[${src} | score: ${score}]**\n${r.chunk.content}`;
        });

        // Semantic memories complement FTS5 (different ranking — semantic beats keyword here)
        vecMemLines = memVecResults.map((r) => {
          const partner = r.chunk.field2 ? ` | Partner: ${r.chunk.field2}` : '';
          const cat = r.chunk.field3 ? ` | [${r.chunk.field3}]` : '';
          return `**[semantic memory${partner}${cat}]**\n${r.chunk.content}`;
        });
      }
    } catch {
      // Vector store optional — silently skip if unavailable
    }

    // ── Combine and return ────────────────────────────────────────────────────
    const hasMem = memLines.length > 0 || vecMemLines.length > 0;
    const hasKnow = knowledgeLines.length > 0;

    if (!hasMem && !hasKnow) {
      return {
        success: true,
        output: `No results found for: "${query}"`,
      };
    }

    const allMemLines = [...memLines, ...vecMemLines];
    const sections: string[] = [];
    if (allMemLines.length > 0)
      sections.push(`## Memory (${allMemLines.length} entry(ies))\n\n${allMemLines.join('\n\n')}`);
    if (hasKnow)
      sections.push(
        `## Knowledge docs (${knowledgeLines.length} chunk(s))\n\n${knowledgeLines.join('\n\n')}`,
      );

    return {
      success: true,
      output: sections.join('\n\n---\n\n'),
      data: { memories: filtered, knowledge: knowledgeLines },
    };
  },
});
