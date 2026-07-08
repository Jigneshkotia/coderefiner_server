import { AnalysisRun, PathStatus, Suggestion } from '../models/index.js';
import {
  deriveModeMetrics,
  fileSizeFactor,
  filterSuggestionsForPath,
  folderSizeFactor,
  getSubtreeFileCount,
  normalizePath,
  resolveFileLineCount,
  type DashboardMode,
} from './pathScoring.js';
import type { AnalysisStatus } from './pathStatus.js';
import type { IngestSuggestion } from '../models/index.js';

function parseMode(raw: string | undefined): DashboardMode {
  return raw === 'runtime' ? 'runtime' : 'compile';
}

function modeFields(mode: DashboardMode) {
  if (mode === 'runtime') {
    return {
      issueCountsKey: 'runtimeIssueCounts' as const,
      healthScoreKey: 'runtimeHealthScore' as const,
      statusKey: 'runtimeAnalysisStatus' as const,
      paramsKey: 'runtimeParams' as const,
      suggestionType: 'runtime' as const,
    };
  }
  return {
    issueCountsKey: 'compileIssueCounts' as const,
    healthScoreKey: 'compileHealthScore' as const,
    statusKey: 'compileAnalysisStatus' as const,
    paramsKey: 'compileParams' as const,
    suggestionType: 'compile-time' as const,
  };
}

function toIngestSuggestion(s: Record<string, unknown>): IngestSuggestion {
  return {
    id: String(s.externalId ?? s.id ?? ''),
    type: s.type as 'compile-time' | 'runtime',
    parameter: s.parameter as string | undefined,
    importance: s.importance as 'critical' | 'moderate' | 'minimal',
    title: String(s.title ?? ''),
    problem: String(s.problem ?? ''),
    why: String(s.why ?? ''),
    suggestion: String(s.suggestion ?? ''),
    location: String(s.location ?? ''),
    action: String(s.action ?? ''),
    pageUrl: s.pageUrl as string | undefined,
    modulePath: s.modulePath as string | undefined,
  };
}

async function fetchSuggestionsForPath(
  repoKey: string,
  targetPath: string,
  pathType: 'file' | 'directory',
  mode: DashboardMode,
) {
  const fp = normalizePath(targetPath);
  const prefix = fp === '.' ? '' : `${fp}/`;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const type = mode === 'compile' ? 'compile-time' : 'runtime';

  const query: Record<string, unknown> = { repoKey, type };
  if (pathType === 'file') {
    query.location = { $regex: fp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
  } else if (fp !== '.') {
    query.location = { $regex: `^${escaped}` };
  }

  const rows = await Suggestion.find(query).sort({ ingestedAt: -1 }).limit(100).lean();
  const ingest = rows.map((r) => toIngestSuggestion(r as Record<string, unknown>));
  return filterSuggestionsForPath(ingest, fp, pathType, mode);
}

export async function getFileDashboard(repoKey: string, filePath: string, modeRaw?: string) {
  const mode = parseMode(modeRaw);
  const fields = modeFields(mode);
  const fp = normalizePath(filePath);
  const status = await PathStatus.findOne({ repoKey, path: fp }).lean();

  const suggestions = await fetchSuggestionsForPath(repoKey, fp, 'file', mode);
  const latestRun = status?.lastRunId
    ? await AnalysisRun.findOne({ runId: status.lastRunId }).lean()
    : null;

  let issueCounts = (status?.[fields.issueCountsKey] as Record<string, number>) ?? null;
  let healthScore = (status?.[fields.healthScoreKey] as number | null | undefined) ?? null;
  let analysisStatus = (status?.[fields.statusKey] as AnalysisStatus) ?? null;

  if (!issueCounts && suggestions.length > 0) {
    const lineCount = resolveFileLineCount(status?.lineCount as number | undefined);
    const derived = deriveModeMetrics(suggestions, fp, 'file', mode, true, fileSizeFactor(lineCount));
    issueCounts = derived.issueCounts;
    healthScore = derived.healthScore;
    analysisStatus = derived.analysisStatus;
  } else {
    issueCounts = issueCounts ?? { critical: 0, moderate: 0, minimal: 0 };
    analysisStatus = analysisStatus ?? (status?.analysisStatus as AnalysisStatus) ?? 'none';
    healthScore = healthScore ?? (mode === 'compile' ? status?.healthScore ?? null : null);
  }
  const params = (status?.[fields.paramsKey] as string[]) ?? (mode === 'compile' ? latestRun?.compileParams : latestRun?.runtimeParams) ?? [];

  return {
    path: fp,
    pathType: 'file' as const,
    mode,
    analysisStatus,
    healthScore,
    issueCounts,
    lineCount: status?.lineCount as number | undefined,
    lastAnalyzedAt: status?.lastAnalyzedAt,
    lastRunId: status?.lastRunId,
    params,
    suggestions,
    latestRun,
  };
}

export async function getFolderDashboard(repoKey: string, folderPath: string, modeRaw?: string) {
  const mode = parseMode(modeRaw);
  const fields = modeFields(mode);
  const fp = normalizePath(folderPath);
  const prefix = fp === '.' ? '' : `${fp}/`;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const folderStatus = await PathStatus.findOne({ repoKey, path: fp, pathType: 'directory' }).lean();
  const fileStatuses = await PathStatus.find({
    repoKey,
    pathType: 'file',
    ...(fp === '.' ? {} : { path: { $regex: `^${escaped}` } }),
  }).lean();

  const suggestions = await fetchSuggestionsForPath(repoKey, fp, 'directory', mode);

  const childFiles = fileStatuses.map((s) => ({
    path: s.path,
    analysisStatus: (s[fields.statusKey] as AnalysisStatus) ?? 'none',
    healthScore: (s[fields.healthScoreKey] as number | null | undefined) ?? undefined,
    issueCounts: (s[fields.issueCountsKey] as Record<string, number>) ?? { critical: 0, moderate: 0, minimal: 0 },
    lastAnalyzedAt: s.lastAnalyzedAt,
  }));

  const subtreeFileCount = (folderStatus?.subtreeFileCount as number | undefined)
    ?? await getSubtreeFileCount(repoKey, fp);

  const issueCounts = (folderStatus?.[fields.issueCountsKey] as Record<string, number>)
    ?? deriveModeMetrics(
      suggestions,
      fp,
      'directory',
      mode,
      suggestions.length > 0,
      folderSizeFactor(subtreeFileCount),
    ).issueCounts;

  const healthScore = (folderStatus?.[fields.healthScoreKey] as number | null | undefined) ?? null;
  const analysisStatus = (folderStatus?.[fields.statusKey] as AnalysisStatus) ?? 'none';

  return {
    path: fp,
    pathType: 'directory' as const,
    mode,
    analysisStatus,
    healthScore,
    issueCounts,
    subtreeFileCount,
    fileCount: childFiles.length,
    childFiles,
    suggestions,
  };
}
