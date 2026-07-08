import { Router } from 'express';
import { z } from 'zod';
import { ingestAnalysis } from '../services/ingest.js';
import { AnalysisRun, WorkflowEvent } from '../models/index.js';

const router = Router();

const suggestionSchema = z.object({
  id: z.string(),
  type: z.enum(['compile-time', 'runtime']),
  parameter: z.string().optional(),
  importance: z.enum(['critical', 'moderate', 'minimal']),
  title: z.string(),
  problem: z.string(),
  why: z.string(),
  suggestion: z.string(),
  location: z.string(),
  action: z.string(),
  beforeCode: z.string().optional(),
  afterCode: z.string().optional(),
  verification: z.object({ method: z.string(), finding: z.string() }).optional(),
  diagram: z.unknown().optional(),
  extractedMetrics: z.record(z.unknown()).optional(),
  modulePath: z.string().optional(),
  pageUrl: z.string().optional(),
});

const ingestSchema = z.object({
  repoKey: z.string().min(1),
  gitlabHost: z.string().optional(),
  isInitialRepoSync: z.boolean().optional(),
  repoTree: z.object({
    files: z.array(z.string()),
    directories: z.array(z.string()),
  }).optional(),
  analyzedPaths: z.array(z.string()).optional(),
  pathLineCounts: z.record(z.number()).optional(),
  run: z.object({
    runId: z.string(),
    status: z.enum(['completed', 'failed']),
    scopeType: z.string(),
    scopeLabel: z.string(),
    targetFiles: z.array(z.string()),
    compileParams: z.array(z.string()),
    runtimeParams: z.array(z.string()),
    runtimeUrls: z.array(z.string()),
    auditMode: z.string().optional(),
    model: z.string().optional(),
    chatId: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    durationMs: z.number().optional(),
    tokenUsage: z.record(z.number()).optional(),
    mrIids: z.array(z.number()).optional(),
    reportPath: z.string().optional(),
    suggestionsPath: z.string().optional(),
  }),
  moduleBuckets: z.array(z.object({
    modulePath: z.string(),
    moduleScope: z.enum(['file', 'directory']),
    primaryFile: z.string().optional(),
    files: z.array(z.string()),
    compileParamsAudited: z.array(z.string()),
  })),
  pageBuckets: z.array(z.object({
    url: z.string(),
    runtimeParamsAudited: z.array(z.string()),
  })),
  suggestions: z.array(suggestionSchema),
});

router.post('/analysis', async (req, res) => {
  try {
    const payload = ingestSchema.parse(req.body);
    const existing = await AnalysisRun.findOne({ runId: payload.run.runId });
    if (existing) {
      res.status(409).json({ error: 'Duplicate runId' });
      return;
    }
    const result = await ingestAnalysis(payload);
    res.status(201).json(result);
  } catch (err) {
    console.error('Ingest error:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid payload' });
  }
});

router.post('/workflow', async (req, res) => {
  try {
    const { repoKey, runId, stage, metadata, tokenUsage, durationMs } = req.body;
    if (!repoKey || !stage) {
      res.status(400).json({ error: 'repoKey and stage required' });
      return;
    }
    await WorkflowEvent.create({ repoKey, runId, stage, metadata, tokenUsage, durationMs });
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid payload' });
  }
});

export default router;
