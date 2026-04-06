import { createLogger } from '../logger.js';
import type { LLMConfig } from '../llm/index.js';

const log = createLogger('kg-extractor');

export interface ExtractedEntity {
  type: 'person' | 'company' | 'project' | 'contract' | 'amount' | 'address';
  name: string; // anonymized (already processed by anonymizer)
  properties: Record<string, unknown>;
}

export interface ExtractedRelation {
  from: string; // entity name
  to: string;
  relation: string; // e.g. 'works_for', 'owns', 'mentioned_with', 'counterparty'
  context: string; // short anonymized snippet
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

export async function extractEntities(
  anonText: string,
  llmConfig: LLMConfig,
): Promise<ExtractionResult> {
  const { llmCall, extractJson } = await import('../llm/index.js');

  const prompt = `Extract named entities and relations from this anonymized text.
Return ONLY valid JSON (no markdown):
{
  "entities": [{ "type": "person|company|project|contract|amount|address", "name": "...", "properties": {} }],
  "relations": [{ "from": "entity_name", "to": "entity_name", "relation": "relation_type", "context": "short snippet" }]
}

Rules:
- Only extract entities that are explicitly mentioned
- Use anonymized names as-is (e.g. [PERSON_1], Acme Corp)
- Relation types: works_for, owns, counterparty, mentioned_with, manages, reports_to, sent_to, requested_by
- If nothing relevant, return {"entities":[],"relations":[]}

Text:
${anonText.slice(0, 1500)}`;

  try {
    const response = await llmCall({ ...llmConfig, temperature: 0, maxTokens: 512 }, [
      { role: 'user', content: prompt },
    ]);
    const result = extractJson<ExtractionResult>(response.content);
    return {
      entities: (result.entities ?? []).slice(0, 20),
      relations: (result.relations ?? []).slice(0, 30),
    };
  } catch (e) {
    log.warn(`Entity extraction failed: ${(e as Error).message}`);
    return { entities: [], relations: [] };
  }
}
