/* ===== Bermuda Sort Station — boot: open DB -> load state -> start HTTP (PLAN.md §7) ===== */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { config } from './config.js';
import { openDb } from './db/migrate.js';
import { loadState } from './db/load.js';
import { createPersistence } from './db/persist.js';
import { createMutator } from './services/mutate.js';
import { createAuthService } from './services/authService.js';
import { createStationService } from './services/stationService.js';
import { createScanService } from './services/scanService.js';
import { createToteService } from './services/toteService.js';
import { createDumpService } from './services/dumpService.js';
import { createHandoverService } from './services/handoverService.js';
import { createExportService } from './services/exportService.js';
import { createAlertsService } from './services/alertsService.js';
import { createStatusService } from './services/statusService.js';
import { createLookupService } from './services/lookupService.js';
import { createSettingsService } from './services/settingsService.js';
import { createConsolidationService } from './services/consolidationService.js';
import { createSimReportService } from './services/simReportService.js';
import { createHandoverLogService } from './services/handoverLogService.js';
import { createRouteService } from './services/routeService.js';
import { createResetService } from './services/resetService.js';
import { registerRoutes } from './api/routes.js';
import { loadCerts, startPortMux } from './portMux.js';
import { scheduleNightlyBackup } from './jobs/nightlyBackup.js';

export function buildApp(dbPath = config.dbPath, { backupsDir } = {}) {
  const db = openDb(dbPath);
  const app = { st: loadState(db) };
  const persist = createPersistence(db);
  persist.saveSettings(app.st);
  const { runMutation, runStationAction } = createMutator(db, persist, app);

  const authService = createAuthService(db);
  const stationService = createStationService({ db, app, persist });
  const scanService = createScanService({ app, runStationAction, persist });
  const toteService = createToteService({ app, runStationAction, runMutation });
  const dumpService = createDumpService({ app, persist, db });
  const handoverService = createHandoverService({ app, runMutation });
  const exportService = createExportService({ app, db });
  const alertsService = createAlertsService({ db });
  const statusService = createStatusService({ app, db, persist });
  const lookupService = createLookupService({ app });
  const settingsService = createSettingsService({ app, persist });
  const consolidationService = createConsolidationService({ app, runMutation });
  const simReportService = createSimReportService({ db });
  const routeService = createRouteService({ app, persist, db, runMutation });
  const handoverLogService = createHandoverLogService({ db });
  const resetService = createResetService({ app, db, persist, dumpService, ...(backupsDir ? { backupsDir } : {}) });

  return {
    db, app, persist, runMutation, runStationAction,
    authService, stationService, scanService, toteService, dumpService,
    handoverService, exportService, alertsService, statusService, lookupService, settingsService,
    consolidationService, simReportService, routeService, resetService, handoverLogService,
  };
}

// Fastify's default bodyLimit is 1MB, far too small for a PID Hunter dump CSV (PLAN.md §10:
// ~54,000 rows) or a pilot backup JSON — raise it well above what either realistically needs.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB

export function buildServer(dbPath, { logger = true, backupsDir } = {}) {
  const ctx = buildApp(dbPath, { backupsDir });
  const fastify = Fastify({ logger, bodyLimit: MAX_UPLOAD_BYTES });

  fastify.register(fastifyStatic, { root: path.join(config.root, 'public') });
  fastify.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });
  registerRoutes(fastify, ctx);

  fastify.addHook('onClose', (_instance, done) => { ctx.db.close(); done(); });

  return { fastify, ...ctx };
}

// separate from buildServer() so tests (which build many short-lived servers) never spawn
// background timers — only the real, long-running process started via `npm start` does.
// No shift-end auto-finish: a tote now stays open across shift boundaries until an operator
// or admin closes/releases it, not on a fixed clock (PLAN.md §5.4's original rule removed).
export function startJobs(ctx, logger = console) {
  scheduleNightlyBackup(ctx.db, config.backupsDir, { logger });
}

async function main() {
  const { fastify, ...ctx } = buildServer();
  startJobs(ctx, fastify.log);
  try {
    const certs = loadCerts();
    if (certs) {
      // HTTP + HTTPS on config.port (phone camera needs HTTPS); the app itself sits on loopback behind it
      const innerPort = config.port + 1;
      await fastify.listen({ port: innerPort, host: '127.0.0.1' });
      await startPortMux({ certs, port: config.port, host: config.host, innerPort });
    } else {
      await fastify.listen({ port: config.port, host: config.host });
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
