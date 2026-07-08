import { AnalysisRun, ModuleSnapshot, PageSnapshot, Suggestion, } from '../models/index.js';
import { repoHealthScore } from './scoring.js';
export async function getOverview(repoKey) {
    const runs = await AnalysisRun.find({ repoKey, status: 'completed' })
        .sort({ completedAt: -1 })
        .limit(10)
        .lean();
    const latestModules = await ModuleSnapshot.aggregate([
        { $match: { repoKey } },
        { $sort: { ingestedAt: -1 } },
        { $group: { _id: '$modulePath', doc: { $first: '$$ROOT' } } },
    ]);
    const latestPages = await PageSnapshot.aggregate([
        { $match: { repoKey } },
        { $sort: { ingestedAt: -1 } },
        { $group: { _id: '$url', doc: { $first: '$$ROOT' } } },
    ]);
    const moduleScores = latestModules.map((m) => m.doc.healthScore);
    const pageScores = latestPages.map((p) => p.doc.healthScore);
    const health = repoHealthScore(moduleScores, pageScores);
    const latestRun = runs[0];
    const summary = latestRun?.summary ?? {
        byImportance: { critical: 0, moderate: 0, minimal: 0 },
        suggestionCount: 0,
    };
    const hotspots = [
        ...latestModules
            .map((m) => ({ type: 'module', path: m._id, healthScore: m.doc.healthScore }))
            .filter((h) => h.healthScore != null)
            .sort((a, b) => (a.healthScore ?? 100) - (b.healthScore ?? 100))
            .slice(0, 5),
        ...latestPages
            .map((p) => ({ type: 'page', path: p._id, healthScore: p.doc.healthScore }))
            .filter((h) => h.healthScore != null)
            .sort((a, b) => (a.healthScore ?? 100) - (b.healthScore ?? 100))
            .slice(0, 5),
    ];
    const hasRuntime = latestPages.length > 0;
    const auditMode = latestRun?.auditMode ?? 'unknown';
    return {
        repoKey,
        health,
        hasRuntime,
        auditMode,
        totalRuns: await AnalysisRun.countDocuments({ repoKey }),
        summary,
        recentRuns: runs.map((r) => ({
            runId: r.runId,
            scopeType: r.scopeType,
            scopeLabel: r.scopeLabel,
            auditMode: r.auditMode,
            completedAt: r.completedAt,
            summary: r.summary,
        })),
        hotspots,
        avgLcp: average(latestPages.map((p) => p.doc.rawMetrics?.lcpMs).filter(isNum)),
        avgInp: average(latestPages.map((p) => p.doc.rawMetrics?.inpMs).filter(isNum)),
        avgCls: average(latestPages.map((p) => p.doc.rawMetrics?.cls).filter(isNum)),
    };
}
function isNum(v) { return typeof v === 'number'; }
function average(nums) {
    if (nums.length === 0)
        return null;
    return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}
export async function getInsights(repoKey) {
    const criticalOpen = await Suggestion.countDocuments({
        repoKey,
        importance: 'critical',
        status: 'open',
    });
    const modules = await ModuleSnapshot.find({ repoKey }).sort({ ingestedAt: -1 }).lean();
    const regressions = [];
    const byModule = new Map();
    for (const m of modules) {
        const list = byModule.get(m.modulePath) ?? [];
        list.push(m);
        byModule.set(m.modulePath, list);
    }
    for (const [modulePath, snaps] of byModule) {
        if (snaps.length >= 2 && snaps[0].healthScore != null && snaps[1].healthScore != null) {
            const delta = snaps[0].healthScore - snaps[1].healthScore;
            if (delta <= -10)
                regressions.push({ type: 'module', path: modulePath, delta });
        }
    }
    return { criticalOpen, regressions, remediationRate: null };
}
