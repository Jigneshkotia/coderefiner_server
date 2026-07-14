import { Router } from 'express';
import {
  RuntimeApp,
  RuntimePageSnapshot,
  RuntimeRun,
  RuntimeSuggestion,
} from '../models/index.js';
import { requireAdminKey } from '../middleware/requireAdminKey.js';

const router = Router();

router.get('/apps', async (_req, res) => {
  const apps = await RuntimeApp.find().sort({ lastIngestedAt: -1 }).lean();
  res.json(apps.map((a) => ({
    appKey: a.appKey,
    displayName: a.displayName,
    baseUrl: a.baseUrl,
    routerType: a.routerType,
    totalRuns: a.totalRuns,
    lastIngestedAt: a.lastIngestedAt,
  })));
});

router.get('/apps/:appKey/overview', async (req, res) => {
  const appKey = decodeURIComponent(req.params.appKey);
  const app = await RuntimeApp.findOne({ appKey }).lean();
  if (!app) {
    res.status(404).json({ error: 'App not found' });
    return;
  }
  const runs = await RuntimeRun.find({ appKey }).sort({ completedAt: -1 }).limit(20).lean();
  const latest = runs[0] ?? null;
  res.json({
    app: {
      appKey: app.appKey,
      displayName: app.displayName,
      baseUrl: app.baseUrl,
      routerType: app.routerType,
      totalRuns: app.totalRuns,
      lastIngestedAt: app.lastIngestedAt,
    },
    latestRun: latest,
    runHistory: runs.map((r) => ({
      runId: r.runId,
      completedAt: r.completedAt,
      summary: r.summary,
      aiRan: r.aiRan,
    })),
  });
});

/** Latest run's pages — powers the sidebar route tree of the scheduled mode. */
router.get('/apps/:appKey/tree', async (req, res) => {
  const appKey = decodeURIComponent(req.params.appKey);
  const latestRun = await RuntimeRun.findOne({ appKey }).sort({ completedAt: -1 }).lean();
  if (!latestRun) {
    res.json({ appKey, runId: null, completedAt: null, pages: [] });
    return;
  }
  const pages = await RuntimePageSnapshot.find({ appKey, runId: latestRun.runId }).lean();
  pages.sort((a, b) => String(a.route ?? a.url).localeCompare(String(b.route ?? b.url)));
  res.json({
    appKey,
    runId: latestRun.runId,
    completedAt: latestRun.completedAt,
    pages: pages.map((p) => ({
      url: p.url,
      route: p.route,
      urlHash: p.urlHash,
      status: p.status,
      severity: p.severity,
      healthScore: p.healthScore,
      violationCounts: p.violationCounts,
      suggestionCount: p.suggestionCount,
      webVitals: p.webVitals,
      cwvRatings: p.cwvRatings,
    })),
  });
});

/** Full dashboard data for one page (latest snapshot + AI suggestions + history). */
router.get('/apps/:appKey/pages/:urlHash', async (req, res) => {
  const appKey = decodeURIComponent(req.params.appKey);
  const urlHash = req.params.urlHash;
  const history = await RuntimePageSnapshot.find({ appKey, urlHash })
    .sort({ ingestedAt: -1 })
    .limit(20)
    .lean();
  const latest = history[0];
  if (!latest) {
    res.status(404).json({ error: 'Page not found' });
    return;
  }
  const suggestions = await RuntimeSuggestion.find({ appKey, runId: latest.runId, urlHash }).lean();
  const appWide = await RuntimeSuggestion.find({
    appKey,
    runId: latest.runId,
    $or: [{ urlHash: { $exists: false } }, { urlHash: null }],
  }).lean();
  res.json({
    urlHash,
    snapshot: latest,
    suggestions,
    appWideSuggestions: appWide,
    history: history.map((h) => ({
      runId: h.runId,
      ingestedAt: h.ingestedAt,
      healthScore: h.healthScore,
      status: h.status,
      severity: h.severity,
      violationCounts: h.violationCounts,
      suggestionCount: h.suggestionCount,
    })),
  });
});

/**
 * Clear analysis data (admin-key protected, same key as daily mode).
 * Body: { adminKey, urlHash? } — with urlHash only that page's snapshots and
 * suggestions are removed; without it every run/snapshot/suggestion of the
 * app is cleared while the app entry itself is kept.
 */
router.delete('/apps/:appKey/analytics', requireAdminKey, async (req, res) => {
  try {
    const appKey = decodeURIComponent(String(req.params.appKey));
    const app = await RuntimeApp.findOne({ appKey });
    if (!app) {
      res.status(404).json({ error: 'App not found' });
      return;
    }
    const urlHash = typeof req.body?.urlHash === 'string' && req.body.urlHash ? req.body.urlHash : undefined;

    if (urlHash) {
      const [snapshots, suggestions] = await Promise.all([
        RuntimePageSnapshot.deleteMany({ appKey, urlHash }),
        RuntimeSuggestion.deleteMany({ appKey, urlHash }),
      ]);
      res.json({ deleted: { runs: 0, pageSnapshots: snapshots.deletedCount, suggestions: suggestions.deletedCount } });
      return;
    }

    const [runs, snapshots, suggestions] = await Promise.all([
      RuntimeRun.deleteMany({ appKey }),
      RuntimePageSnapshot.deleteMany({ appKey }),
      RuntimeSuggestion.deleteMany({ appKey }),
    ]);
    await RuntimeApp.updateOne({ appKey }, { $set: { totalRuns: 0 } });
    res.json({
      deleted: {
        runs: runs.deletedCount,
        pageSnapshots: snapshots.deletedCount,
        suggestions: suggestions.deletedCount,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to clear analytics' });
  }
});

/** Delete an app and every piece of its runtime data (admin-key protected). */
router.delete('/apps/:appKey', requireAdminKey, async (req, res) => {
  try {
    const appKey = decodeURIComponent(String(req.params.appKey));
    const app = await RuntimeApp.findOne({ appKey });
    if (!app) {
      res.status(404).json({ error: 'App not found' });
      return;
    }
    await Promise.all([
      RuntimeRun.deleteMany({ appKey }),
      RuntimePageSnapshot.deleteMany({ appKey }),
      RuntimeSuggestion.deleteMany({ appKey }),
      RuntimeApp.deleteOne({ appKey }),
    ]);
    res.status(204).send();
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to delete app' });
  }
});

export default router;
