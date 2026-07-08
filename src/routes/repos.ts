import { Router } from 'express';
import {
  AnalysisRun,
  ModuleSnapshot,
  PageSnapshot,
  Repo,
  Suggestion,
} from '../models/index.js';
import { getRepoTreeData } from '../services/tree.js';
import { getFileDashboard, getFolderDashboard } from '../services/pathDashboard.js';
import { getPathHistory } from '../services/pathHistory.js';
import { getOverview, getInsights } from '../services/insights.js';

const router = Router();

router.get('/', async (_req, res) => {
  const repos = await Repo.find().sort({ lastIngestedAt: -1 }).lean();
  res.json(repos.map((r) => ({
    repoKey: r.repoKey,
    displayName: r.displayName,
    totalRuns: r.totalRuns,
    lastIngestedAt: r.lastIngestedAt,
  })));
});


router.get('/:repoKey/exists', async (req, res) => {
  const repoKey = decodeURIComponent(req.params.repoKey);
  const repo = await Repo.findOne({ repoKey }).lean();
  res.json({ exists: !!repo, repoKey });
});

router.get('/:repoKey/tree', async (req, res) => {
  const repoKey = decodeURIComponent(req.params.repoKey);
  const repo = await Repo.findOne({ repoKey });
  if (!repo) {
    res.status(404).json({ error: 'Repo not found' });
    return;
  }
  res.json(await getRepoTreeData(repoKey));
});

router.get('/:repoKey/dashboard/file', async (req, res) => {
  const repoKey = decodeURIComponent(req.params.repoKey);
  const filePath = String(req.query.path ?? '');
  const mode = String(req.query.mode ?? 'compile');
  if (!filePath) {
    res.status(400).json({ error: 'path query required' });
    return;
  }
  res.json(await getFileDashboard(repoKey, filePath, mode));
});

router.get('/:repoKey/dashboard/folder', async (req, res) => {
  const repoKey = decodeURIComponent(req.params.repoKey);
  const folderPath = String(req.query.path ?? '.');
  const mode = String(req.query.mode ?? 'compile');
  res.json(await getFolderDashboard(repoKey, folderPath, mode));
});

router.get('/:repoKey/history/file', async (req, res) => {
  const repoKey = decodeURIComponent(req.params.repoKey);
  const filePath = String(req.query.path ?? '');
  const mode = String(req.query.mode ?? 'compile');
  if (!filePath) {
    res.status(400).json({ error: 'path query required' });
    return;
  }
  res.json(await getPathHistory(repoKey, filePath, 'file', mode === 'runtime' ? 'runtime' : 'compile'));
});

router.get('/:repoKey/history/folder', async (req, res) => {
  const repoKey = decodeURIComponent(req.params.repoKey);
  const folderPath = String(req.query.path ?? '.');
  const mode = String(req.query.mode ?? 'compile');
  res.json(await getPathHistory(repoKey, folderPath, 'directory', mode === 'runtime' ? 'runtime' : 'compile'));
});

router.get('/:repoKey/overview', async (req, res) => {
  const repoKey = decodeURIComponent(req.params.repoKey);
  const repo = await Repo.findOne({ repoKey });
  if (!repo) {
    res.status(404).json({ error: 'Repo not found' });
    return;
  }
  res.json(await getOverview(repoKey));
});

router.get('/:repoKey/modules', async (req, res) => {
  const repoKey = decodeURIComponent(req.params.repoKey);
  const modules = await ModuleSnapshot.aggregate([
    { $match: { repoKey } },
    { $sort: { ingestedAt: -1 } },
    { $group: {
      _id: '$modulePath',
      healthScore: { $first: '$healthScore' },
      fileCount: { $first: '$fileCount' },
      paramScores: { $first: '$paramScores' },
      moduleScope: { $first: '$moduleScope' },
      primaryFile: { $first: '$primaryFile' },
      lastAudited: { $first: '$ingestedAt' },
      runId: { $first: '$runId' },
    }},
    { $sort: { healthScore: 1 } },
  ]);
  res.json(modules.map((m) => ({
    modulePath: m._id,
    healthScore: m.healthScore,
    fileCount: m.fileCount,
    paramScores: m.paramScores,
    moduleScope: m.moduleScope,
    primaryFile: m.primaryFile,
    lastAudited: m.lastAudited,
    runId: m.runId,
  })));
});

router.get('/:repoKey/modules/:modulePath', async (req, res) => {
  const repoKey = decodeURIComponent(req.params.repoKey);
  const modulePath = decodeURIComponent(req.params.modulePath);
  const history = await ModuleSnapshot.find({ repoKey, modulePath }).sort({ ingestedAt: -1 }).limit(20).lean();
  const latest = history[0];
  const suggestions = latest
    ? await Suggestion.find({ repoKey, runId: latest.runId, type: 'compile-time' }).lean()
    : [];
  res.json({ modulePath, history, latest, suggestions });
});

router.get('/:repoKey/pages', async (req, res) => {
  const repoKey = decodeURIComponent(req.params.repoKey);
  const pages = await PageSnapshot.aggregate([
    { $match: { repoKey } },
    { $sort: { ingestedAt: -1 } },
    { $group: {
      _id: '$url',
      healthScore: { $first: '$healthScore' },
      rawMetrics: { $first: '$rawMetrics' },
      cwvRatings: { $first: '$cwvRatings' },
      urlPath: { $first: '$urlPath' },
      urlHash: { $first: '$urlHash' },
      lastTraced: { $first: '$ingestedAt' },
    }},
    { $sort: { healthScore: 1 } },
  ]);
  res.json(pages.map((p) => ({
    url: p._id,
    urlPath: p.urlPath,
    urlHash: p.urlHash,
    healthScore: p.healthScore,
    rawMetrics: p.rawMetrics,
    cwvRatings: p.cwvRatings,
    lastTraced: p.lastTraced,
  })));
});

router.get('/:repoKey/pages/:urlHash', async (req, res) => {
  const repoKey = decodeURIComponent(req.params.repoKey);
  const urlHash = req.params.urlHash;
  const history = await PageSnapshot.find({ repoKey, urlHash }).sort({ ingestedAt: -1 }).limit(20).lean();
  const latest = history[0];
  const suggestions = latest
    ? await Suggestion.find({ repoKey, runId: latest.runId, type: 'runtime' }).lean()
    : [];
  res.json({ urlHash, history, latest, suggestions });
});

router.get('/:repoKey/runs', async (req, res) => {
  const repoKey = decodeURIComponent(req.params.repoKey);
  const runs = await AnalysisRun.find({ repoKey }).sort({ completedAt: -1 }).limit(50).lean();
  res.json(runs);
});

router.get('/:repoKey/runs/:runId', async (req, res) => {
  const repoKey = decodeURIComponent(req.params.repoKey);
  const run = await AnalysisRun.findOne({ repoKey, runId: req.params.runId }).lean();
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const [modules, pages, suggestions] = await Promise.all([
    ModuleSnapshot.find({ runId: run.runId }).lean(),
    PageSnapshot.find({ runId: run.runId }).lean(),
    Suggestion.find({ runId: run.runId }).lean(),
  ]);
  res.json({ run, modules, pages, suggestions });
});

router.get('/:repoKey/insights', async (req, res) => {
  const repoKey = decodeURIComponent(req.params.repoKey);
  res.json(await getInsights(repoKey));
});

export default router;
