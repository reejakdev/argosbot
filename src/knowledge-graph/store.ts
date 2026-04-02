import { monotonicFactory } from 'ulid';
import { createLogger } from '../logger.js';
import { getDb } from '../db/index.js';

const ulid = monotonicFactory();
const log  = createLogger('kg-store');

export interface GraphQueryResult {
  entity: { id: string; type: string; name: string; properties: Record<string, unknown> };
  related: Array<{
    relation: string;
    direction: 'outbound' | 'inbound';
    entity: { id: string; type: string; name: string };
    context?: string;
  }>;
}

export function upsertEntity(
  entity: { type: string; name: string; properties: Record<string, unknown> },
  sourceRef: string,
  channel?: string,
  chatId?: string,
): string {
  const db  = getDb();
  const now = Date.now();

  const existing = db.prepare('SELECT id FROM entities WHERE name = ? AND type = ?')
    .get(entity.name, entity.type) as { id: string } | undefined;

  if (existing) {
    db.prepare('UPDATE entities SET last_seen = ?, properties = ?, source_ref = ? WHERE id = ?')
      .run(now, JSON.stringify(entity.properties), sourceRef, existing.id);
    return existing.id;
  }

  const id = ulid();
  db.prepare(
    'INSERT INTO entities (id, type, name, properties, first_seen, last_seen, source_ref, channel, chat_id) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, entity.type, entity.name, JSON.stringify(entity.properties), now, now, sourceRef, channel ?? null, chatId ?? null);

  log.debug(`New entity stored: type=${entity.type}`);
  return id;
}

export function addRelation(
  fromId: string, toId: string, relation: string, context: string, sourceRef: string,
): void {
  const db = getDb();
  // Dedup: skip if same from+to+relation already exists
  const exists = db.prepare('SELECT id FROM entity_relations WHERE from_id=? AND to_id=? AND relation=?')
    .get(fromId, toId, relation);
  if (exists) return;

  db.prepare(
    'INSERT INTO entity_relations (id, from_id, to_id, relation, context, source_ref, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(ulid(), fromId, toId, relation, context, sourceRef, Date.now());
}

export function queryGraph(entityName: string): GraphQueryResult | null {
  const db = getDb();

  const entity = db.prepare('SELECT id, type, name, properties FROM entities WHERE name = ? LIMIT 1')
    .get(entityName) as { id: string; type: string; name: string; properties: string } | undefined;
  if (!entity) return null;

  // Outbound relations
  const outbound = db.prepare(`
    SELECT er.relation, er.context, e.id, e.type, e.name
    FROM entity_relations er
    JOIN entities e ON e.id = er.to_id
    WHERE er.from_id = ?
    LIMIT 30
  `).all(entity.id) as Array<{ relation: string; context: string; id: string; type: string; name: string }>;

  // Inbound relations
  const inbound = db.prepare(`
    SELECT er.relation, er.context, e.id, e.type, e.name
    FROM entity_relations er
    JOIN entities e ON e.id = er.from_id
    WHERE er.to_id = ?
    LIMIT 30
  `).all(entity.id) as Array<{ relation: string; context: string; id: string; type: string; name: string }>;

  return {
    entity: { id: entity.id, type: entity.type, name: entity.name, properties: JSON.parse(entity.properties ?? '{}') },
    related: [
      ...outbound.map(r => ({ relation: r.relation, direction: 'outbound' as const, entity: { id: r.id, type: r.type, name: r.name }, context: r.context })),
      ...inbound.map(r => ({ relation: r.relation, direction: 'inbound' as const, entity: { id: r.id, type: r.type, name: r.name }, context: r.context })),
    ],
  };
}
