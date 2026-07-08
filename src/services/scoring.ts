import type { IngestSuggestion } from '../models/index.js';

type Importance = 'critical' | 'moderate' | 'minimal';

const WEIGHTS: Record<Importance, number> = { critical: 3, moderate: 2, minimal: 1 };

export function issueWeight(importance?: string): number {
  if (importance === 'critical' || importance === 'moderate' || importance === 'minimal') {
    return WEIGHTS[importance];
  }
  return WEIGHTS.moderate;
}

export function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

export function paramScore(penalty: number): number {
  if (penalty === 0) return 100;
  return clamp(0, 100, Math.round(100 - penalty * 5));
}

export function computeParamScores(
  compileParams: string[],
  suggestions: IngestSuggestion[],
): { paramScores: Record<string, number>; issueCounts: Record<string, Record<string, number>>; issuePenalty: Record<string, number> } {
  const issueCounts: Record<string, Record<string, number>> = {};
  const issuePenalty: Record<string, number> = {};
  const paramScores: Record<string, number> = {};

  for (const p of compileParams) {
    issueCounts[p] = { critical: 0, moderate: 0, minimal: 0 };
    issuePenalty[p] = 0;
  }

  for (const s of suggestions) {
    if (s.type !== 'compile-time') continue;
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

export function moduleHealthScore(paramScores: Record<string, number>, compileParams: string[]): number | null {
  const keys = compileParams.length > 0 ? compileParams : Object.keys(paramScores);
  if (keys.length === 0) return null;
  const scores = keys.map((k) => paramScores[k]).filter((s) => typeof s === 'number');
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

export type CwvRating = 'good' | 'needs-improvement' | 'poor' | null;

export function rateLcp(ms?: number): CwvRating {
  if (ms == null) return null;
  if (ms <= 2500) return 'good';
  if (ms <= 4000) return 'needs-improvement';
  return 'poor';
}

export function rateInp(ms?: number): CwvRating {
  if (ms == null) return null;
  if (ms <= 200) return 'good';
  if (ms <= 500) return 'needs-improvement';
  return 'poor';
}

export function rateCls(cls?: number): CwvRating {
  if (cls == null) return null;
  if (cls <= 0.1) return 'good';
  if (cls <= 0.25) return 'needs-improvement';
  return 'poor';
}

function ratingScore(rating: CwvRating): number | null {
  if (rating === 'good') return 100;
  if (rating === 'needs-improvement') return 60;
  if (rating === 'poor') return 20;
  return null;
}

export function pageHealthScore(
  rawMetrics: Record<string, number | boolean | undefined>,
  runtimeSuggestions: IngestSuggestion[],
  hasCwv: boolean,
): number | null {
  const runtimePenalty = runtimeSuggestions.reduce((sum, s) => sum + issueWeight(s.importance), 0);

  if (hasCwv) {
    const lcpR = rateLcp(rawMetrics.lcpMs as number | undefined);
    const inpR = rateInp(rawMetrics.inpMs as number | undefined);
    const clsR = rateCls(rawMetrics.cls as number | undefined);
    const parts: { w: number; s: number }[] = [];
    if (lcpR) { const s = ratingScore(lcpR); if (s != null) parts.push({ w: 0.5, s }); }
    if (inpR) { const s = ratingScore(inpR); if (s != null) parts.push({ w: 0.3, s }); }
    if (clsR) { const s = ratingScore(clsR); if (s != null) parts.push({ w: 0.2, s }); }
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

export function repoHealthScore(moduleScores: (number | null)[], pageScores: (number | null)[]): number | null {
  const modules = moduleScores.filter((s): s is number => s != null);
  const pages = pageScores.filter((s): s is number => s != null);
  if (pages.length === 0 && modules.length === 0) return null;
  if (pages.length === 0) return Math.round(modules.reduce((a, b) => a + b, 0) / modules.length);
  if (modules.length === 0) return Math.round(pages.reduce((a, b) => a + b, 0) / pages.length);
  const mAvg = modules.reduce((a, b) => a + b, 0) / modules.length;
  const pAvg = pages.reduce((a, b) => a + b, 0) / pages.length;
  return Math.round(0.4 * mAvg + 0.6 * pAvg);
}
