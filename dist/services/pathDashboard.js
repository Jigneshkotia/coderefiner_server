import { AnalysisRun, PathStatus, Suggestion } from '../models/index.js';
import { deriveModeMetrics, fileSizeFactor, filterSuggestionsForPath, folderSizeFactor, getSubtreeFileCount, normalizePath, resolveFileLineCount, } from './pathScoring.js';
function parseMode(raw) {
    return raw === 'runtime' ? 'runtime' : 'compile';
}
function modeFields(mode) {
    if (mode === 'runtime') {
        return {
            issueCountsKey: 'runtimeIssueCounts',
            healthScoreKey: 'runtimeHealthScore',
            statusKey: 'runtimeAnalysisStatus',
            paramsKey: 'runtimeParams',
            suggestionType: 'runtime',
        };
    }
    return {
        issueCountsKey: 'compileIssueCounts',
        healthScoreKey: 'compileHealthScore',
        statusKey: 'compileAnalysisStatus',
        paramsKey: 'compileParams',
        suggestionType: 'compile-time',
    };
}
function toIngestSuggestion(s) {
    return {
        id: String(s.externalId ?? s.id ?? ''),
        type: s.type,
        parameter: s.parameter,
        importance: s.importance,
        title: String(s.title ?? ''),
        problem: String(s.problem ?? ''),
        why: String(s.why ?? ''),
        suggestion: String(s.suggestion ?? ''),
        location: String(s.location ?? ''),
        action: String(s.action ?? ''),
        pageUrl: s.pageUrl,
        modulePath: s.modulePath,
    };
}
async function fetchSuggestionsForPath(repoKey, targetPath, pathType, mode) {
    const fp = normalizePath(targetPath);
    const prefix = fp === '.' ? '' : `${fp}/`;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const type = mode === 'compile' ? 'compile-time' : 'runtime';
    const query = { repoKey, type };
    if (pathType === 'file') {
        query.location = { $regex: fp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
    }
    else if (fp !== '.') {
        query.location = { $regex: `^${escaped}` };
    }
    const rows = await Suggestion.find(query).sort({ ingestedAt: -1 }).limit(100).lean();
    const ingest = rows.map((r) => toIngestSuggestion(r));
    return filterSuggestionsForPath(ingest, fp, pathType, mode);
}
export async function getFileDashboard(repoKey, filePath, modeRaw) {
    const mode = parseMode(modeRaw);
    const fields = modeFields(mode);
    const fp = normalizePath(filePath);
    const status = await PathStatus.findOne({ repoKey, path: fp }).lean();
    const suggestions = await fetchSuggestionsForPath(repoKey, fp, 'file', mode);
    const latestRun = status?.lastRunId
        ? await AnalysisRun.findOne({ runId: status.lastRunId }).lean()
        : null;
    let issueCounts = status?.[fields.issueCountsKey] ?? null;
    let healthScore = status?.[fields.healthScoreKey] ?? null;
    let analysisStatus = status?.[fields.statusKey] ?? null;
    if (!issueCounts && suggestions.length > 0) {
        const lineCount = resolveFileLineCount(status?.lineCount);
        const derived = deriveModeMetrics(suggestions, fp, 'file', mode, true, fileSizeFactor(lineCount));
        issueCounts = derived.issueCounts;
        healthScore = derived.healthScore;
        analysisStatus = derived.analysisStatus;
    }
    else {
        issueCounts = issueCounts ?? { critical: 0, moderate: 0, minimal: 0 };
        analysisStatus = analysisStatus ?? status?.analysisStatus ?? 'none';
        healthScore = healthScore ?? (mode === 'compile' ? status?.healthScore ?? null : null);
    }
    const params = status?.[fields.paramsKey] ?? (mode === 'compile' ? latestRun?.compileParams : latestRun?.runtimeParams) ?? [];
    return {
        path: fp,
        pathType: 'file',
        mode,
        analysisStatus,
        healthScore,
        issueCounts,
        lineCount: status?.lineCount,
        lastAnalyzedAt: status?.lastAnalyzedAt,
        lastRunId: status?.lastRunId,
        params,
        suggestions,
        latestRun,
    };
}
export async function getFolderDashboard(repoKey, folderPath, modeRaw) {
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
        analysisStatus: s[fields.statusKey] ?? 'none',
        healthScore: s[fields.healthScoreKey] ?? undefined,
        issueCounts: s[fields.issueCountsKey] ?? { critical: 0, moderate: 0, minimal: 0 },
        lastAnalyzedAt: s.lastAnalyzedAt,
    }));
    const subtreeFileCount = folderStatus?.subtreeFileCount
        ?? await getSubtreeFileCount(repoKey, fp);
    const issueCounts = folderStatus?.[fields.issueCountsKey]
        ?? deriveModeMetrics(suggestions, fp, 'directory', mode, suggestions.length > 0, folderSizeFactor(subtreeFileCount)).issueCounts;
    const healthScore = folderStatus?.[fields.healthScoreKey] ?? null;
    const analysisStatus = folderStatus?.[fields.statusKey] ?? 'none';
    return {
        path: fp,
        pathType: 'directory',
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
