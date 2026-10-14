import Fastify, { FastifyInstance } from 'fastify';
import { openDb } from './db/open.js';
import { registerAuth } from './plugins/auth.js';
import { registerProjectScope } from './plugins/projectScope.js';
import { registerErrorHandler } from './plugins/errors.js';
import { registerStatic } from './plugins/static.js';
import { systemRoutes } from './routes/system.js';
import { jiraRoutes } from './routes/jira.js';
import { graphRoutes } from './routes/graph.js';
import { moduleRoutes } from './routes/modules.js';
import { ownerRoutes } from './routes/owners.js';
import { groupRoutes } from './routes/groups.js';
import { relationRoutes } from './routes/relations.js';
import { issueRoutes } from './routes/issues.js';
import { sprintRoutes } from './routes/sprints.js';
import { projectRoutes } from './routes/projects.js';
import { jiraImportRoutes } from './routes/jiraImport.js';
import { jiraExportRoutes } from './routes/jiraExport.js';
import { projectTransferRoutes } from './routes/projectTransfer.js';

export { lanAddress } from './routes/system.js';

export function buildApp(dbPath: string = process.env.DB_PATH ?? './data/pjplanner.db'): FastifyInstance {
  const db = openDb(dbPath);
  const app = Fastify();
  app.addHook('onClose', async () => { db.close(); });

  registerAuth(app);
  registerProjectScope(app, db);
  registerErrorHandler(app);

  systemRoutes(app);
  jiraRoutes(app);
  graphRoutes(app, db);
  moduleRoutes(app, db);
  ownerRoutes(app, db);
  groupRoutes(app, db);
  relationRoutes(app, db);
  issueRoutes(app, db);
  sprintRoutes(app, db);
  projectRoutes(app, db);
  projectTransferRoutes(app, db);
  jiraImportRoutes(app, db);
  jiraExportRoutes(app, db);

  registerStatic(app);
  return app;
}
