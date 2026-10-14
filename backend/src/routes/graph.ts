import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { moduleStore } from './modules.js';
import { ownerStore } from './owners.js';
import { groupStore } from './groups.js';
import { relationStore } from './relations.js';
export function graphRoutes(app: FastifyInstance, db: Database.Database) {
  const { modules } = moduleStore(db);
  const { ownerList } = ownerStore(db);
  const { groupList } = groupStore(db);
  const { relList } = relationStore(db);
  app.get('/api/graph', async () => ({
    modules: modules(),
    owners: ownerList(),
    relations: relList(),
    groups: groupList(),
  }));
}
