import path from 'path';
import { PathStatus } from '../models/index.js';
import { deriveModeMetrics, fileSizeFactor, filterSuggestionsForPath, folderSizeFactor, getSubtreeFileCount, normalizePath, resolveFileLineCount, scoreFromCounts, statusFromCounts, sumCounts, } from './pathScoring.js';
const STATUS_RANK = {
    none: 0, clean: 1, moderate: 2, critical: 3,
};
export function worstStatus(a, b) {
    return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}
export function getAncestorPaths(filePath) {
    const ancestors = ['.'];
    let dir = path.posix.dirname(normalizePath(filePath));
    while (dir && dir !== '.') {
        ancestors.push(dir);
        const parent = path.posix.dirname(dir);
        dir = parent === dir ? '.' : parent;
    }
    return [...new Set(ancestors)];
}
export function deriveAnalysisScope(moduleBuckets) {
    const bucket = moduleBuckets[0];
    if (!bucket)
        return 'partial';
    if (bucket.moduleScope === 'directory')
        return 'folder-full';
    return 'file';
}
function fileMetricsFromRun(filePath, suggestions, compileParams, runtimeParams, lineCount) {
    const loc = resolveFileLineCount(lineCount);
    const sizeFactor = fileSizeFactor(loc);
    const compile = deriveModeMetrics(suggestions, filePath, 'file', 'compile', true, sizeFactor);
    const runtime = deriveModeMetrics(suggestions, filePath, 'file', 'runtime', runtimeParams.length > 0, sizeFactor);
    return {
        compileIssueCounts: compile.issueCounts,
        runtimeIssueCounts: runtime.issueCounts,
        compileHealthScore: compile.healthScore,
        runtimeHealthScore: runtimeParams.length > 0 ? runtime.healthScore : null,
        compileAnalysisStatus: compile.analysisStatus,
        runtimeAnalysisStatus: runtime.analysisStatus,
        analysisStatus: worstStatus(compile.analysisStatus, runtime.analysisStatus),
        healthScore: compile.healthScore,
        compileParams,
        runtimeParams,
        lineCount: loc,
    };
}
async function aggregateFolderFromFiles(repoKey, folderPath) {
    const fp = normalizePath(folderPath);
    const prefix = fp === '.' ? '' : `${fp}/`;
    const regex = fp === '.' ? /.*/ : new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    const files = await PathStatus.find({ repoKey, pathType: 'file', path: regex }).lean();
    const compileList = files.map((f) => f.compileIssueCounts ?? { critical: 0, moderate: 0, minimal: 0 });
    const runtimeList = files.map((f) => f.runtimeIssueCounts ?? { critical: 0, moderate: 0, minimal: 0 });
    const compileIssueCounts = sumCounts(compileList);
    const runtimeIssueCounts = sumCounts(runtimeList);
    const hasAnalyzedChild = files.some((f) => f.lastAnalyzedAt != null);
    const subtreeFileCount = await getSubtreeFileCount(repoKey, fp);
    const sizeFactor = folderSizeFactor(subtreeFileCount);
    const compileHealthScore = scoreFromCounts(compileIssueCounts, sizeFactor);
    const runtimeHealthScore = files.some((f) => f.runtimeHealthScore != null)
        ? scoreFromCounts(runtimeIssueCounts, sizeFactor)
        : null;
    const compileAnalysisStatus = statusFromCounts(compileIssueCounts, hasAnalyzedChild);
    const runtimeAnalysisStatus = statusFromCounts(runtimeIssueCounts, files.some((f) => f.runtimeIssueCounts?.critical > 0 || f.runtimeIssueCounts?.moderate > 0 || f.runtimeIssueCounts?.minimal > 0));
    return {
        compileIssueCounts,
        runtimeIssueCounts,
        compileHealthScore,
        runtimeHealthScore,
        compileAnalysisStatus,
        runtimeAnalysisStatus,
        analysisStatus: worstStatus(compileAnalysisStatus, runtimeAnalysisStatus),
        healthScore: compileHealthScore,
        subtreeFileCount,
    };
}
export async function refreshFolderAggregate(repoKey, folderPath) {
    const metrics = await aggregateFolderFromFiles(repoKey, folderPath);
    const fp = normalizePath(folderPath);
    const hasData = metrics.analysisStatus !== 'none';
    if (!hasData) {
        if (fp !== '.') {
            await PathStatus.deleteOne({ repoKey, path: fp, pathType: 'directory' });
        }
        return;
    }
    await PathStatus.findOneAndUpdate({ repoKey, path: fp }, {
        $set: {
            repoKey,
            path: fp,
            pathType: 'directory',
            ...metrics,
        },
    }, { upsert: true });
}
export async function upsertPathStatuses(repoKey, runId, analyzedPaths, suggestions, compileParams, runtimeParams, pathLineCounts = {}) {
    const now = new Date();
    const ancestors = new Set();
    for (const rawPath of analyzedPaths) {
        const filePath = normalizePath(rawPath);
        const lineCount = pathLineCounts[filePath] ?? pathLineCounts[rawPath];
        const metrics = fileMetricsFromRun(filePath, suggestions, compileParams, runtimeParams, lineCount);
        await PathStatus.findOneAndUpdate({ repoKey, path: filePath }, {
            $set: {
                repoKey,
                path: filePath,
                pathType: 'file',
                ...metrics,
                lastRunId: runId,
                lastAnalyzedAt: now,
            },
        }, { upsert: true });
        for (const a of getAncestorPaths(filePath))
            ancestors.add(a);
    }
    for (const folderPath of ancestors) {
        await refreshFolderAggregate(repoKey, folderPath);
    }
    return [...ancestors];
}
export function bubbleFolderStatuses(files, directories, fileStatuses) {
    const folderStatuses = {};
    for (const dir of directories)
        folderStatuses[normalizePath(dir)] = 'none';
    for (const file of files) {
        const fp = normalizePath(file);
        const status = fileStatuses[fp] ?? 'none';
        if (status === 'none')
            continue;
        let dir = path.posix.dirname(fp);
        while (dir && dir !== '.') {
            folderStatuses[dir] = worstStatus(folderStatuses[dir] ?? 'none', status);
            const parent = path.posix.dirname(dir);
            dir = parent === dir ? '.' : parent;
        }
        folderStatuses['.'] = worstStatus(folderStatuses['.'] ?? 'none', status);
    }
    return folderStatuses;
}
export { filterSuggestionsForPath, deriveModeMetrics, normalizePath };
