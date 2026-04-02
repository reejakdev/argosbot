/**
 * graph_search skill — query the knowledge graph for everything known about an entity.
 *
 * Returns related entities, relation types and directions, useful for the planner
 * to reason about who is connected to whom and in what context.
 */

import { registerSkill } from '../registry.js';
import { queryGraph } from '../../knowledge-graph/store.js';

registerSkill({
  name: 'graph_search',
  description: 'Search the knowledge graph for everything known about a person, company, or entity. Returns related entities and relationships.',
  tool: {
    name: 'graph_search',
    description: 'Search the knowledge graph for everything known about a person, company, or entity. Returns related entities and relationships.',
    input_schema: {
      type: 'object',
      properties: {
        entity: {
          type: 'string',
          description: 'Entity name to look up (e.g. "[PERSON_1]", "Acme Corp")',
        },
      },
      required: ['entity'],
    },
  },
  handler: async (input, _cfg) => {
    const entityName = String(input.entity ?? '').trim();
    if (!entityName) return { success: false, output: 'entity is required' };

    const result = queryGraph(entityName);

    if (!result) {
      return {
        success: true,
        output: `No entity found in the knowledge graph for: "${entityName}"`,
      };
    }

    const lines: string[] = [
      `## Entity: ${result.entity.name}`,
      `Type: ${result.entity.type}`,
    ];

    const props = result.entity.properties;
    if (props && Object.keys(props).length > 0) {
      lines.push(`Properties: ${JSON.stringify(props)}`);
    }

    if (result.related.length === 0) {
      lines.push('\nNo known relations.');
    } else {
      lines.push(`\n## Relations (${result.related.length})`);
      for (const rel of result.related) {
        const arrow = rel.direction === 'outbound' ? '-->' : '<--';
        const ctx = rel.context ? ` (context: "${rel.context}")` : '';
        lines.push(`• ${result.entity.name} ${arrow}[${rel.relation}]${arrow} ${rel.entity.name} [${rel.entity.type}]${ctx}`);
      }
    }

    return {
      success: true,
      output: lines.join('\n'),
      data: result,
    };
  },
});
