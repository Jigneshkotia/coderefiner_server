import path from 'path';
import { AnalysisRun, ModuleSnapshot, PageSnapshot, PathAnalysisHistory, PathStatus, Repo, Suggestion, WorkflowEvent, } from '../../models/index.js';
import { getAncestorPaths, refreshFolderAggregate } from '../pathStatus.js';
import { normalizePath } from '../pathScoring.js';
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function pathInSubtree(candidate, target, pathType) {
    const normalized = normalizePath(candidate);
    const fp = normalizePath(target);
    if (pathType === 'file') {
        return normalized === fp;
    }
    if (fp === '.') {
        return true;
    }
    return normalized === fp || normalized.startsWith(`${fp}/`);
}
function buildPathMatchQuery(repoKey, targetPath, pathType) {
    const fp = normalizePath(targetPath);
    if (pathType === 'file') {
        return { repoKey, path: fp };
    }
    if (fp === '.') {
        return { repoKey };
    }
    const escaped = escapeRegex(fp);
    return {
        repoKey,
        $or: [
            { path: fp },
            { path: { $regex: `^${escaped}/` } },
        ],
    };
}
function buildSuggestionMatchQuery(repoKey, targetPath, pathType) {
    const fp = normalizePath(targetPath);
    if (pathType === 'file') {
        return {
            repoKey,
            $or: [
                { filePath: fp },
                { location: fp },
            ],
        };
    }
    if (fp === '.') {
        return { repoKey };
    }
    const escaped = escapeRegex(fp);
    const prefixRegex = `^${escaped}(?:/|$)`;
    return {
        repoKey,
        $or: [
            { filePath: { $regex: prefixRegex } },
            { location: { $regex: prefixRegex } },
            { modulePath: { $regex: prefixRegex } },
        ],
    };
}
function buildModuleSnapshotMatchQuery(repoKey, targetPath, pathType) {
    const fp = normalizePath(targetPath);
    if (pathType === 'file') {
        return {
            repoKey,
            $or: [
                { modulePath: path.posix.dirname(fp) || '.' },
                { primaryFile: fp },
                { files: fp },
            ],
        };
    }
    if (fp === '.') {
        return { repoKey };
    }
    const escaped = escapeRegex(fp);
    const prefixRegex = `^${escaped}(?:/|$)`;
    return {
        repoKey,
        $or: [
            { modulePath: { $regex: prefixRegex } },
            { primaryFile: { $regex: prefixRegex } },
            { files: { $regex: prefixRegex } },
        ],
    };
}
function collectAncestorsForTarget(targetPath, pathType) {
    const fp = normalizePath(targetPath);
    if (pathType === 'file') {
        return getAncestorPaths(fp);
    }
    const ancestors = new Set(['.']);
    if (fp !== '.') {
        let dir = fp;
        while (dir && dir !== '.') {
            ancestors.add(dir);
            const parent = path.posix.dirname(dir);
            dir = parent === dir ? '.' : parent;
        }
        ancestors.add('.');
    }
    return [...ancestors];
}
export async function removePathAnalytics(input) {
    const { repoKey, targetPath, pathType } = input;
    const fp = normalizePath(targetPath);
    const repo = await Repo.findOne({ repoKey });
    if (!repo) {
        throw new Error('Repo not found');
    }
    const allRuns = await AnalysisRun.find({ repoKey }).lean();
    const affectedRunIds = allRuns
        .filter((run) => (run.targetFiles ?? []).some((file) => pathInSubtree(file, fp, pathType)))
        .map((run) => run.runId);
    const pathQuery = buildPathMatchQuery(repoKey, fp, pathType);
    const suggestionQuery = buildSuggestionMatchQuery(repoKey, fp, pathType);
    const moduleQuery = buildModuleSnapshotMatchQuery(repoKey, fp, pathType);
    const [pathStatusResult, historyResult, suggestionResult, moduleResult, pageResult, workflowResult, runResult,] = await Promise.all([
        PathStatus.deleteMany(pathQuery),
        PathAnalysisHistory.deleteMany(pathQuery),
        Suggestion.deleteMany(suggestionQuery),
        ModuleSnapshot.deleteMany(moduleQuery),
        affectedRunIds.length > 0
            ? PageSnapshot.deleteMany({ repoKey, runId: { $in: affectedRunIds } })
            : Promise.resolve({ deletedCount: 0 }),
        affectedRunIds.length > 0
            ? WorkflowEvent.deleteMany({ repoKey, runId: { $in: affectedRunIds } })
            : Promise.resolve({ deletedCount: 0 }),
        affectedRunIds.length > 0
            ? AnalysisRun.deleteMany({ repoKey, runId: { $in: affectedRunIds } })
            : Promise.resolve({ deletedCount: 0 }),
    ]);
    const ancestors = collectAncestorsForTarget(fp, pathType);
    for (const ancestor of ancestors) {
        await refreshFolderAggregate(repoKey, ancestor);
    }
    const deletedRunCount = runResult.deletedCount ?? 0;
    if (deletedRunCount > 0) {
        const latestRun = await AnalysisRun.findOne({ repoKey }).sort({ completedAt: -1 }).lean();
        await Repo.updateOne({ repoKey }, {
            $inc: { totalRuns: -deletedRunCount },
            $set: { lastIngestedAt: latestRun?.completedAt ?? null },
        });
    }
    return {
        deleted: {
            pathStatuses: pathStatusResult.deletedCount ?? 0,
            history: historyResult.deletedCount ?? 0,
            suggestions: suggestionResult.deletedCount ?? 0,
            runs: deletedRunCount,
            moduleSnapshots: moduleResult.deletedCount ?? 0,
            pageSnapshots: pageResult.deletedCount ?? 0,
            workflowEvents: workflowResult.deletedCount ?? 0,
        },
    };
}
