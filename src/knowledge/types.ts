/**
 * Knowledge layer types.
 *
 * KnowledgeDocument — the output of a connector fetch.
 * KnowledgeConnector — interface any connector implements.
 */

export interface KnowledgeDocument {
  /** Unique stable key — used to upsert in the memory store */
  key: string;
  /** Human-readable name (shown in logs, memory tags) */
  name: string;
  /** Extracted text, truncated if large (safe for direct LLM injection) */
  content: string;
  /** Categorisation tags */
  tags: string[];
  /** Full text — only set when content was truncated; used for vector indexing */
  fullText?: string;
}

export interface KnowledgeConnector {
  name: string;
  enabled: boolean;
  fetch(): Promise<KnowledgeDocument[]>;
}
