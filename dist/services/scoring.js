const WEIGHTS = { critical: 3, moderate: 2, minimal: 1 };
export function issueWeight(importance) {
    if (importance === 'critical' || importance === 'moderate' || importance === 'minimal') {
        return WEIGHTS[importance];
    }
    return WEIGHTS.moderate;
}
export function clamp(min, max, value) {
    return Math.max(min, Math.min(max, value));
}
export function paramScore(penalty) {
    if (penalty === 0)
        return 100;
    return clamp(0, 100, Math.round(100 - penalty * 5));
}
export function computeParamScores(compileParams, suggestions) {
    const issueCounts = {};
    const issuePenalty = {};
    const paramScores = {};
    for (const p of compileParams) {
        issueCounts[p] = { critical: 0, moderate: 0, minimal: 0 };
        issuePenalty[p] = 0;
    }
    for (const s of suggestions) {
        if (s.type !== 'compile-time')
            continue;
        const p = s.parameter ?? 'unknown';
        if (!issueCounts[p]) {
            issueCounts[p] = { critical: 0, moderate: 0, minimal: 0 };
            issuePenalty[p] = 0;
        }
        const imp = s.importance ?? 'moderate';
        issueCounts[p][imp] = (issueCounts[p][imp] ?? 0) + 1;
        issuePenalty[p] += issueWeight(imp);
    }
    const audited = compileParams.length > 0 ? compileParams : Object.keys(issueCounts);
    for (const p of audited) {
        paramScores[p] = paramScore(issuePenalty[p] ?? 0);
    }
    return { paramScores, issueCounts, issuePenalty };
}
export function moduleHealthScore(paramScores, compileParams) {
    const keys = compileParams.length > 0 ? compileParams : Object.keys(paramScores);
    if (keys.length === 0)
        return null;
    const scores = keys.map((k) => paramScores[k]).filter((s) => typeof s === 'number');
    if (scores.length === 0)
        return null;
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}
export function rateLcp(ms) {
    if (ms == null)
        return null;
    if (ms <= 2500)
        return 'good';
    if (ms <= 4000)
        return 'needs-improvement';
    return 'poor';
}
export function rateInp(ms) {
    if (ms == null)
        return null;
    if (ms <= 200)
        return 'good';
    if (ms <= 500)
        return 'needs-improvement';
    return 'poor';
}
export function rateCls(cls) {
    if (cls == null)
        return null;
    if (cls <= 0.1)
        return 'good';
    if (cls <= 0.25)
        return 'needs-improvement';
    return 'poor';
}
function ratingScore(rating) {
    if (rating === 'good')
        return 100;
    if (rating === 'needs-improvement')
        return 60;
    if (rating === 'poor')
        return 20;
    return null;
}
export function pageHealthScore(rawMetrics, runtimeSuggestions, hasCwv) {
    const runtimePenalty = runtimeSuggestions.reduce((sum, s) => sum + issueWeight(s.importance), 0);
    if (hasCwv) {
        const lcpR = rateLcp(rawMetrics.lcpMs);
        const inpR = rateInp(rawMetrics.inpMs);
        const clsR = rateCls(rawMetrics.cls);
        const parts = [];
        if (lcpR) {
            const s = ratingScore(lcpR);
            if (s != null)
                parts.push({ w: 0.5, s });
        }
        if (inpR) {
            const s = ratingScore(inpR);
            if (s != null)
                parts.push({ w: 0.3, s });
        }
        if (clsR) {
            const s = ratingScore(clsR);
            if (s != null)
                parts.push({ w: 0.2, s });
        }
        if (parts.length === 0) {
            return clamp(0, 100, Math.round(100 - runtimePenalty * 5));
        }
        const activeWeight = parts.reduce((a, p) => a + p.w, 0);
        const cwvScore = parts.reduce((a, p) => a + p.w * p.s, 0) / activeWeight;
        const issueDeduction = Math.min(40, runtimePenalty * 4);
        return clamp(0, 100, Math.round(cwvScore - issueDeduction));
    }
    return clamp(0, 100, Math.round(100 - runtimePenalty * 5));
}
export function repoHealthScore(moduleScores, pageScores) {
    const modules = moduleScores.filter((s) => s != null);
    const pages = pageScores.filter((s) => s != null);
    if (pages.length === 0 && modules.length === 0)
        return null;
    if (pages.length === 0)
        return Math.round(modules.reduce((a, b) => a + b, 0) / modules.length);
    if (modules.length === 0)
        return Math.round(pages.reduce((a, b) => a + b, 0) / pages.length);
    const mAvg = modules.reduce((a, b) => a + b, 0) / modules.length;
    const pAvg = pages.reduce((a, b) => a + b, 0) / pages.length;
    return Math.round(0.4 * mAvg + 0.6 * pAvg);
}
