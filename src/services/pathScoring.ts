import { RepoTree } from '../models/index.js';
import type { IngestSuggestion } from '../models/index.js';
import type { AnalysisStatus } from './pathStatus.js';

export type IssueCounts = { critical: number; moderate: number; minimal: number };
export type DashboardMode = 'compile' | 'runtime';

const WEIGHTS = { critical: 3, moderate: 2, minimal: 1 } as const;

export const REFERENCE_LOC = 200;
export const MIN_FILE_FACTOR = 0.25;
export const REFERENCE_FILE_COUNT = 10;
export const MIN_FOLDER_FACTOR = 0.3;
export const PENALTY_MULTIPLIER = 5;

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '') || '.';
}

export function emptyCounts(): IssueCounts {
  return { critical: 0, moderate: 0, minimal: 0 };
}

export function countIssues(suggestions: IngestSuggestion[]): IssueCounts {
  const counts = emptyCounts();
  for (const s of suggestions) {
    counts[s.importance] = (counts[s.importance] ?? 0) + 1;
  }
  return counts;
}

export function sumCounts(list: IssueCounts[]): IssueCounts {
  const total = emptyCounts();
  for (const c of list) {
    total.critical += c.critical;
    total.moderate += c.moderate;
    total.minimal += c.minimal;
  }
  return total;
}

export function penaltyFromCounts(counts: IssueCounts): number {
  return WEIGHTS.critical * counts.critical + WEIGHTS.moderate * counts.moderate + WEIGHTS.minimal * counts.minimal;
}

export function fileSizeFactor(lineCount: number): number {
  const loc = lineCount > 0 ? lineCount : REFERENCE_LOC;
  return Math.max(loc / REFERENCE_LOC, MIN_FILE_FACTOR);
}

export function folderSizeFactor(fileCount: number): number {
  const count = fileCount > 0 ? fileCount : REFERENCE_FILE_COUNT;
  return Math.max(count / REFERENCE_FILE_COUNT, MIN_FOLDER_FACTOR);
}

export function scoreFromCounts(counts: IssueCounts, sizeFactor = 1): number {
  const penalty = penaltyFromCounts(counts);
  if (penalty === 0) return 100;
  const effectivePenalty = penalty / Math.max(sizeFactor, 0.01);
  return Math.max(0, Math.min(100, Math.round(100 - effectivePenalty * PENALTY_MULTIPLIER)));
}

export function resolveFileLineCount(lineCount?: number | null): number {
  return lineCount != null && lineCount > 0 ? lineCount : REFERENCE_LOC;
}

export async function getSubtreeFileCount(repoKey: string, folderPath: string): Promise<number> {
  const fp = normalizePath(folderPath);
  const tree = await RepoTree.findOne({ repoKey }).lean();
  if (!tree?.files?.length) return REFERENCE_FILE_COUNT;

  if (fp === '.') return tree.files.length;

  const prefix = `${fp}/`;
  return tree.files.filter((f) => f === fp || f.startsWith(prefix)).length || REFERENCE_FILE_COUNT;
}

export function statusFromCounts(counts: IssueCounts, wasAnalyzed: boolean): AnalysisStatus {
  if (!wasAnalyzed && penaltyFromCounts(counts) === 0) return 'none';
  if (counts.critical > 0) return 'critical';
  if (counts.moderate > 0) return 'moderate';
  return 'clean';
}

function suggestionTypeForMode(mode: DashboardMode): 'compile-time' | 'runtime' {
  return mode === 'compile' ? 'compile-time' : 'runtime';
}

function locationMatchesPath(location: string, targetPath: string, pathType: 'file' | 'directory'): boolean {
  const loc = normalizePath(location);
  const tp = normalizePath(targetPath);
  if (pathType === 'file') {
    return loc === tp || loc.endsWith(`/${tp}`) || tp.endsWith(loc);
  }
  if (tp === '.') return true;
  return loc === tp || loc.startsWith(`${tp}/`);
}

export function filterSuggestionsForPath(
  suggestions: IngestSuggestion[],
  targetPath: string,
  pathType: 'file' | 'directory',
  mode: DashboardMode,
): IngestSuggestion[] {
  const type = suggestionTypeForMode(mode);
  return suggestions.filter((s) => {
    if (s.type !== type) return false;
    return locationMatchesPath(s.location ?? '', targetPath, pathType);
  });
}

export function deriveModeMetrics(
  suggestions: IngestSuggestion[],
  targetPath: string,
  pathType: 'file' | 'directory',
  mode: DashboardMode,
  wasAnalyzed: boolean,
  sizeFactor = 1,
) {
  const filtered = filterSuggestionsForPath(suggestions, targetPath, pathType, mode);
  const issueCounts = countIssues(filtered);
  const healthScore = scoreFromCounts(issueCounts, sizeFactor);
  const analysisStatus = statusFromCounts(issueCounts, wasAnalyzed || filtered.length > 0);
  return { issueCounts, healthScore, analysisStatus, suggestionCount: filtered.length };
}
