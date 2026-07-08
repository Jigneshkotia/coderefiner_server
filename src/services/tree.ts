import { PathStatus, RepoTree } from '../models/index.js';
import { normalizePath } from './pathScoring.js';
import { bubbleFolderStatuses, worstStatus, type AnalysisStatus } from './pathStatus.js';

export async function getRepoTreeData(repoKey: string) {
  const tree = await RepoTree.findOne({ repoKey }).lean();
  const statuses = await PathStatus.find({ repoKey, pathType: 'file' }).lean();

  const pathStatuses: Record<string, {
    analysisStatus: AnalysisStatus;
    compileAnalysisStatus: AnalysisStatus;
    runtimeAnalysisStatus: AnalysisStatus;
    healthScore?: number;
    compileHealthScore?: number;
    runtimeHealthScore?: number | null;
    issueCounts?: Record<string, number>;
    compileIssueCounts?: Record<string, number>;
    runtimeIssueCounts?: Record<string, number>;
    lastAnalyzedAt?: Date;
    lastRunId?: string;
  }> = {};

  const fileStatusMap: Record<string, AnalysisStatus> = {};
  for (const s of statuses) {
    const compileStatus = (s.compileAnalysisStatus ?? s.analysisStatus) as AnalysisStatus;
    const runtimeStatus = (s.runtimeAnalysisStatus ?? 'none') as AnalysisStatus;
    const combined = worstStatus(compileStatus, runtimeStatus);

    pathStatuses[s.path] = {
      analysisStatus: combined,
      compileAnalysisStatus: compileStatus,
      runtimeAnalysisStatus: runtimeStatus,
      healthScore: s.compileHealthScore ?? s.healthScore ?? undefined,
      compileHealthScore: s.compileHealthScore ?? s.healthScore ?? undefined,
      runtimeHealthScore: s.runtimeHealthScore ?? null,
      issueCounts: s.compileIssueCounts as Record<string, number> | undefined ?? s.issueCounts as Record<string, number> | undefined,
      compileIssueCounts: s.compileIssueCounts as Record<string, number> | undefined,
      runtimeIssueCounts: s.runtimeIssueCounts as Record<string, number> | undefined,
      lastAnalyzedAt: s.lastAnalyzedAt ?? undefined,
      lastRunId: s.lastRunId ?? undefined,
    };
    fileStatusMap[s.path] = combined;
  }

  const statusPaths = statuses.map((s) => s.path);
  const files = tree
    ? [...new Set([...tree.files.map(normalizePath), ...statusPaths])].sort()
    : statusPaths;
  const directories = tree?.directories ?? deriveDirectoriesFromFiles(files);
  const folderStatuses = bubbleFolderStatuses(files, directories, fileStatusMap);

  return {
    repoKey,
    files,
    directories,
    fileCount: files.length,
    syncedAt: tree?.syncedAt,
    partial: tree?.partial ?? !tree,
    pathStatuses,
    folderStatuses,
  };
}

function deriveDirectoriesFromFiles(files: string[]): string[] {
  const dirs = new Set<string>(['.']);
  for (const f of files) {
    let dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
    while (dir && dir !== '') {
      dirs.add(dir || '.');
      if (dir === '.') break;
      const idx = dir.lastIndexOf('/');
      dir = idx === -1 ? '.' : dir.slice(0, idx);
    }
  }
  return [...dirs].sort();
}

export async function saveRepoTree(
  repoKey: string,
  files: string[],
  directories: string[],
  partial = false,
): Promise<void> {
  await RepoTree.findOneAndUpdate(
    { repoKey },
    {
      $set: {
        repoKey,
        files,
        directories,
        fileCount: files.length,
        syncedAt: new Date(),
        partial,
      },
    },
    { upsert: true },
  );
}

export async function mergeRepoTreePaths(repoKey: string, newFiles: string[]): Promise<void> {
  const normalized = [...new Set(
    newFiles.map(normalizePath).filter((p) => p && p !== '.'),
  )];
  if (!normalized.length) return;

  const existing = await RepoTree.findOne({ repoKey });
  const currentFiles = existing?.files ?? [];
  const fileSet = new Set([...currentFiles.map(normalizePath), ...normalized]);
  const files = [...fileSet].sort();
  const directories = deriveDirectoriesFromFiles(files);
  await saveRepoTree(repoKey, files, directories, existing?.partial ?? true);
}
