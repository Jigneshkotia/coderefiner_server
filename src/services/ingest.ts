import path from 'path';
import {
  AnalysisRun,
  ModuleSnapshot,
  PageSnapshot,
  Repo,
  Suggestion,
  type IngestSuggestion,
} from '../models/index.js';
import { extractFromSuggestion, urlHash } from './metrics.js';
import { appendPathHistory } from './pathHistory.js';
import { deriveAnalysisScope, upsertPathStatuses } from './pathStatus.js';
import { normalizePath } from './pathScoring.js';
import { parseSuggestionLocation, suggestionFilePath } from '../utils/parseSuggestionLocation.js';
import {
  computeParamScores,
  moduleHealthScore,
  pageHealthScore,
  rateCls,
  rateInp,
  rateLcp,
} from './scoring.js';
import { mergeRepoTreePaths, saveRepoTree } from './tree.js';

export type ModuleBucket = {
  modulePath: string;
  moduleScope: 'file' | 'directory';
  primaryFile?: string;
  files: string[];
  compileParamsAudited: string[];
};

export type RepoTreePayload = {
  files: string[];
  directories: string[];
};

export type IngestPayload = {
  repoKey: string;
  gitlabHost?: string;
  isInitialRepoSync?: boolean;
  repoTree?: RepoTreePayload;
  analyzedPaths?: string[];
  pathLineCounts?: Record<string, number>;
  run: {
    runId: string;
    status: 'completed' | 'failed';
    scopeType: string;
    scopeLabel: string;
    targetFiles: string[];
    compileParams: string[];
    runtimeParams: string[];
    runtimeUrls: string[];
    auditMode?: string;
    model?: string;
    chatId?: string;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    tokenUsage?: Record<string, number>;
    mrIids?: number[];
    reportPath?: string;
    suggestionsPath?: string;
  };
  moduleBuckets: ModuleBucket[];
  pageBuckets: { url: string; runtimeParamsAudited: string[] }[];
  suggestions: IngestSuggestion[];
};

function deriveAuditMode(compileParams: string[], runtimeParams: string[]): string {
  if (compileParams.length > 0 && runtimeParams.length === 0) return 'compile-only';
  if (compileParams.length === 0 && runtimeParams.length > 0) return 'runtime-only';
  if (compileParams.length > 0 && runtimeParams.length > 0) return 'hybrid';
  return 'unknown';
}

function buildSummary(suggestions: IngestSuggestion[], moduleCount: number, pageCount: number) {
  const byType: Record<string, number> = {};
  const byImportance: Record<string, number> = {};
  const byParameter: Record<string, number> = {};
  for (const s of suggestions) {
    byType[s.type] = (byType[s.type] ?? 0) + 1;
    byImportance[s.importance] = (byImportance[s.importance] ?? 0) + 1;
    const p = s.parameter ?? 'unknown';
    byParameter[p] = (byParameter[p] ?? 0) + 1;
  }
  return {
    suggestionCount: suggestions.length,
    byType,
    byImportance,
    byParameter,
    moduleSnapshotCount: moduleCount,
    pageSnapshotCount: pageCount,
    hasNumericMetrics: suggestions.some((s) => Object.keys(s.extractedMetrics ?? {}).length > 0),
  };
}

function suggestionsForModule(suggestions: IngestSuggestion[], modulePath: string, files: string[]): IngestSuggestion[] {
  return suggestions.filter((s) => {
    if (s.type !== 'compile-time') return false;
    const filePath = suggestionFilePath(s.location, s.filePath);
    if (!filePath) return false;
    const dir = path.posix.dirname(filePath) || '.';
    if (dir === modulePath) return true;
    return files.some((f) => filePath === f || filePath.endsWith(`/${f}`) || f.endsWith(filePath));
  });
}

function suggestionsForUrl(suggestions: IngestSuggestion[], url: string): IngestSuggestion[] {
  return suggestions.filter((s) => s.type === 'runtime' && (s.pageUrl === url || !s.pageUrl));
}

function collectIngestFilePaths(payload: IngestPayload): string[] {
  const paths = new Set<string>();
  const add = (p?: string) => { if (p) paths.add(normalizePath(p)); };

  for (const p of payload.analyzedPaths ?? []) add(p);
  for (const p of payload.run?.targetFiles ?? []) add(p);
  for (const p of Object.keys(payload.pathLineCounts ?? {})) add(p);
  for (const bucket of payload.moduleBuckets ?? []) {
    for (const f of bucket.files) add(f);
  }
  for (const s of payload.suggestions ?? []) {
    const filePath = suggestionFilePath(s.location, s.filePath);
    if (filePath) add(filePath);
  }

  return [...paths].filter((p) => p !== '.');
}

export async function ingestAnalysis(payload: IngestPayload): Promise<{ runId: string }> {
  const { repoKey, run, suggestions } = payload;
  const parts = repoKey.split('/');
  const repo = parts.pop() ?? repoKey;
  const owner = parts.join('/') || repo;

  await Repo.findOneAndUpdate(
    { repoKey },
    {
      $set: {
        repoKey,
        displayName: repoKey,
        owner,
        repo,
        gitlabHost: payload.gitlabHost,
        lastIngestedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
      $inc: { totalRuns: 1 },
    },
    { upsert: true },
  );

  const treeFilePaths = collectIngestFilePaths(payload);

  if (payload.isInitialRepoSync && payload.repoTree) {
    await saveRepoTree(
      repoKey,
      payload.repoTree.files,
      payload.repoTree.directories,
      payload.repoTree.files.length >= 10000,
    );
  }

  if (treeFilePaths.length > 0) {
    await mergeRepoTreePaths(repoKey, treeFilePaths);
  }

  const analyzedPaths = payload.analyzedPaths ?? run.targetFiles;
  const moduleBuckets = payload.moduleBuckets.length > 0
    ? payload.moduleBuckets
    : run.compileParams.length > 0
      ? [{
          modulePath: run.targetFiles.length === 1
            ? path.posix.dirname(run.targetFiles[0].replace(/\\/g, '/')) || '.'
            : '.',
          moduleScope: run.targetFiles.length === 1 ? 'file' as const : 'directory' as const,
          primaryFile: run.targetFiles.length === 1 ? run.targetFiles[0] : undefined,
          files: run.targetFiles,
          compileParamsAudited: run.compileParams,
        }]
      : [];

  const analysisScope = deriveAnalysisScope(moduleBuckets);
  const analyzedAt = run.completedAt ? new Date(run.completedAt) : new Date();

  const pathLineCounts = payload.pathLineCounts ?? {};

  if (analyzedPaths.length > 0) {
    await upsertPathStatuses(
      repoKey,
      run.runId,
      analyzedPaths,
      suggestions,
      run.compileParams,
      run.runtimeParams,
      pathLineCounts,
    );

    for (const rawPath of analyzedPaths) {
      await appendPathHistory(
        repoKey,
        run.runId,
        analyzedAt,
        'file',
        normalizePath(rawPath),
        'file',
        suggestions,
        run.compileParams,
        run.runtimeParams,
        pathLineCounts,
      );
    }

    if (analysisScope === 'folder-full' && moduleBuckets[0]) {
      await appendPathHistory(
        repoKey,
        run.runId,
        analyzedAt,
        analysisScope,
        normalizePath(moduleBuckets[0].modulePath),
        'directory',
        suggestions,
        run.compileParams,
        run.runtimeParams,
        pathLineCounts,
      );
    }
  }

  const auditMode = run.auditMode ?? deriveAuditMode(run.compileParams, run.runtimeParams);

  const pageBuckets = payload.pageBuckets.length > 0
    ? payload.pageBuckets
    : run.runtimeUrls.map((url) => ({ url, runtimeParamsAudited: run.runtimeParams }));

  const summary = buildSummary(suggestions, moduleBuckets.length, pageBuckets.length);

  await AnalysisRun.create({
    ...run,
    repoKey,
    auditMode,
    targetFileCount: run.targetFiles.length,
    completedAt: run.completedAt ? new Date(run.completedAt) : new Date(),
    startedAt: run.startedAt ? new Date(run.startedAt) : new Date(),
    summary,
  });

  if (suggestions.length > 0) {
    await Suggestion.insertMany(
      suggestions.map((s) => {
        const repoFilePath = suggestionFilePath(s.location, s.filePath);
        const parsedLine = s.line ?? parseSuggestionLocation(s.location)?.line;

        return {
          runId: run.runId,
          repoKey,
          externalId: s.id,
          type: s.type,
          parameter: s.parameter,
          importance: s.importance,
          title: s.title,
          problem: s.problem,
          why: s.why,
          suggestion: s.suggestion,
          location: repoFilePath ?? s.location,
          filePath: repoFilePath,
          line: parsedLine,
          action: s.action,
          beforeCode: s.beforeCode?.slice(0, 2000),
          afterCode: s.afterCode?.slice(0, 2000),
          verification: s.verification,
          diagram: s.diagram,
          extractedMetrics: s.extractedMetrics ?? extractFromSuggestion(s as Parameters<typeof extractFromSuggestion>[0]),
          modulePath: (s.modulePath
            ?? (repoFilePath ? path.posix.dirname(repoFilePath) || undefined : undefined)),
          pageUrl: s.pageUrl,
          status: 'open',
        };
      }),
    );
  }

  for (const bucket of moduleBuckets) {
    const modSuggestions = suggestionsForModule(suggestions, bucket.modulePath, bucket.files);
    const { paramScores, issueCounts, issuePenalty } = computeParamScores(
      bucket.compileParamsAudited,
      modSuggestions,
    );
    await ModuleSnapshot.create({
      runId: run.runId,
      repoKey,
      modulePath: bucket.modulePath,
      moduleScope: bucket.moduleScope,
      primaryFile: bucket.primaryFile,
      fileCount: bucket.files.length,
      files: bucket.files,
      compileParamsAudited: bucket.compileParamsAudited,
      issueCounts,
      issuePenalty,
      paramScores,
      healthScore: moduleHealthScore(paramScores, bucket.compileParamsAudited),
      suggestionIds: modSuggestions.map((s) => s.id),
      blockedParams: [],
    });
  }

  for (const bucket of pageBuckets) {
    const pageSuggestions = suggestionsForUrl(suggestions, bucket.url);
    const rawMetrics: Record<string, number | boolean> = {};
    for (const s of pageSuggestions) {
      Object.assign(rawMetrics, s.extractedMetrics ?? extractFromSuggestion(s as Parameters<typeof extractFromSuggestion>[0]));
    }
    const hasCwv = bucket.runtimeParamsAudited.includes('core_web_vitals');
    const health = pageHealthScore(rawMetrics, pageSuggestions, hasCwv);
    let urlPath = '/';
    try { urlPath = new URL(bucket.url).pathname; } catch { /* keep / */ }

    await PageSnapshot.create({
      runId: run.runId,
      repoKey,
      url: bucket.url,
      urlPath,
      urlHash: urlHash(bucket.url),
      runtimeParamsAudited: bucket.runtimeParamsAudited,
      rawMetrics,
      cwvRatings: {
        lcp: rateLcp(rawMetrics.lcpMs as number | undefined),
        inp: rateInp(rawMetrics.inpMs as number | undefined),
        cls: rateCls(rawMetrics.cls as number | undefined),
      },
      issueCounts: {},
      healthScore: health,
      suggestionIds: pageSuggestions.map((s) => s.id),
      blockedParams: [],
    });
  }

  return { runId: run.runId };
}
