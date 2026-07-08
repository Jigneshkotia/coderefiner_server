import { PathAnalysisHistory } from '../models/index.js';
import { deriveModeMetrics, fileSizeFactor, folderSizeFactor, getSubtreeFileCount, normalizePath, resolveFileLineCount, } from './pathScoring.js';
export async function appendPathHistory(repoKey, runId, analyzedAt, analysisScope, targetPath, pathType, suggestions, compileParams, runtimeParams, pathLineCounts = {}) {
    const fp = normalizePath(targetPath);
    let sizeFactor = 1;
    let lineCount;
    let subtreeFileCount;
    if (pathType === 'file') {
        lineCount = resolveFileLineCount(pathLineCounts[fp] ?? pathLineCounts[targetPath]);
        sizeFactor = fileSizeFactor(lineCount);
    }
    else {
        subtreeFileCount = await getSubtreeFileCount(repoKey, fp);
        sizeFactor = folderSizeFactor(subtreeFileCount);
    }
    const compile = deriveModeMetrics(suggestions, fp, pathType, 'compile', true, sizeFactor);
    const runtime = deriveModeMetrics(suggestions, fp, pathType, 'runtime', runtimeParams.length > 0, sizeFactor);
    await PathAnalysisHistory.findOneAndUpdate({ repoKey, path: fp, runId }, {
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
    }, { upsert: true });
}
export async function getPathHistory(repoKey, targetPath, pathType, mode) {
    const fp = normalizePath(targetPath);
    const query = { repoKey, path: fp, pathType };
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
            const block = r[key];
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
