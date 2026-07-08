import { PathAnalysisHistory } from '../models/index.js';
import type { IngestSuggestion } from '../models/index.js';
import {
  deriveModeMetrics,
  fileSizeFactor,
  folderSizeFactor,
  getSubtreeFileCount,
  normalizePath,
  resolveFileLineCount,
  type DashboardMode,
} from './pathScoring.js';
import type { AnalysisScopeKind } from './pathStatus.js';

export async function appendPathHistory(
  repoKey: string,
  runId: string,
  analyzedAt: Date,
  analysisScope: AnalysisScopeKind,
  targetPath: string,
  pathType: 'file' | 'directory',
  suggestions: IngestSuggestion[],
  compileParams: string[],
  runtimeParams: string[],
  pathLineCounts: Record<string, number> = {},
): Promise<void> {
  const fp = normalizePath(targetPath);

  let sizeFactor = 1;
  let lineCount: number | undefined;
  let subtreeFileCount: number | undefined;

  if (pathType === 'file') {
    lineCount = resolveFileLineCount(pathLineCounts[fp] ?? pathLineCounts[targetPath]);
    sizeFactor = fileSizeFactor(lineCount);
  } else {
    subtreeFileCount = await getSubtreeFileCount(repoKey, fp);
    sizeFactor = folderSizeFactor(subtreeFileCount);
  }

  const compile = deriveModeMetrics(suggestions, fp, pathType, 'compile', true, sizeFactor);
  const runtime = deriveModeMetrics(suggestions, fp, pathType, 'runtime', runtimeParams.length > 0, sizeFactor);

  await PathAnalysisHistory.findOneAndUpdate(
    { repoKey, path: fp, runId },
    {
      $set: {
        repoKey,
        path: fp,
        pathType,
        runId,
        analyzedAt,
        analysisScope,
        compile: {
          issueCounts: compile.issueCounts,
          healthScore: compile.healthScore,
          suggestionCount: compile.suggestionCount,
          lineCount,
          subtreeFileCount,
        },
        runtime: {
          issueCounts: runtime.issueCounts,
          healthScore: runtime.healthScore,
          suggestionCount: runtime.suggestionCount,
          lineCount,
          subtreeFileCount,
        },
        compileParams,
        runtimeParams,
      },
    },
    { upsert: true },
  );
}

export async function getPathHistory(
  repoKey: string,
  targetPath: string,
  pathType: 'file' | 'directory',
  mode: DashboardMode,
) {
  const fp = normalizePath(targetPath);
  const query: Record<string, unknown> = { repoKey, path: fp, pathType };
  if (pathType === 'directory') {
    query.analysisScope = 'folder-full';
  }

  const rows = await PathAnalysisHistory.find(query).sort({ analyzedAt: 1 }).lean();
  const key = mode === 'compile' ? 'compile' : 'runtime';

  return {
    path: fp,
    pathType,
    mode,
    points: rows.map((r) => {
      const block = (r as Record<string, unknown>)[key] as {
        healthScore: number;
        issueCounts: Record<string, number>;
        lineCount?: number;
        subtreeFileCount?: number;
      };
      return {
        analyzedAt: r.analyzedAt,
        runId: r.runId,
        score: block?.healthScore ?? null,
        issueCounts: block?.issueCounts ?? { critical: 0, moderate: 0, minimal: 0 },
        analysisScope: r.analysisScope,
        lineCount: block?.lineCount,
        subtreeFileCount: block?.subtreeFileCount,
      };
    }),
  };
}
