import {
  RuntimeApp,
  RuntimePageSnapshot,
  RuntimeRun,
  RuntimeSuggestion,
} from '../models/index.js';
import { urlHash } from './metrics.js';
import { clamp, rateCls, rateInp, rateLcp, type CwvRating } from './scoring.js';

export type RuntimeViolation = {
  id: string;
  severity: 'Critical' | 'Moderate' | 'Minimal';
  metric?: string;
  actual?: unknown;
  threshold?: unknown;
  message?: string;
};

export type RuntimeIngestSuggestion = {
  id: string;
  type: 'compile-time' | 'runtime';
  parameter?: string;
  importance: 'critical' | 'moderate' | 'minimal';
  title: string;
  problem: string;
  why: string;
  suggestion: string;
  location: string;
  filePath?: string;
  line?: number;
  action: string;
  beforeCode?: string;
  afterCode?: string;
  verification?: { method: string; finding: string };
  pageUrl?: string;
  expectedImpact?: string;
  confidence?: string;
};

export type RuntimeIngestPage = {
  url: string;
  route?: string;
  source?: string;
  status: 'healthy' | 'flagged';
  severity?: 'Critical' | 'Moderate' | 'Minimal';
  violations: RuntimeViolation[];
  lighthouse?: {
    scores?: Record<string, number | null>;
    metrics?: Record<string, number | null>;
  } | null;
  runtime?: Record<string, unknown> | null;
  scanError?: string;
  durationMs?: number;
};

export type RuntimeIngestPayload = {
  appKey: string;
  appPath?: string;
  baseUrl?: string;
  routerType?: string;
  run: {
    runId: string;
    startedAt?: string;
    completedAt?: string;
    formFactor?: string;
    summary?: Record<string, unknown>;
    aiRan?: boolean;
    aiSummary?: string;
    blockedAudits?: unknown[];
    skippedRoutes?: unknown[];
  };
  pages: RuntimeIngestPage[];
  suggestions: RuntimeIngestSuggestion[];
};

const SEVERITY_WEIGHT: Record<string, number> = { Critical: 3, Moderate: 2, Minimal: 1 };
const IMPORTANCE_WEIGHT: Record<string, number> = { critical: 3, moderate: 2, minimal: 1 };

function violationCounts(violations: RuntimeViolation[]) {
  const counts = { critical: 0, moderate: 0, minimal: 0 };
  for (const v of violations) {
    if (v.severity === 'Critical') counts.critical++;
    else if (v.severity === 'Moderate') counts.moderate++;
    else counts.minimal++;
  }
  return counts;
}

function ratingScore(rating: CwvRating): number | null {
  if (rating === 'good') return 100;
  if (rating === 'needs-improvement') return 60;
  if (rating === 'poor') return 20;
  return null;
}

/**
 * Health score for a scanned page: weighted Core Web Vitals baseline (falling
 * back to the Lighthouse performance score) minus a deduction per violation
 * and per AI suggestion, mirroring the extension's pageHealthScore shape.
 */
function runtimePageHealthScore(
  page: RuntimeIngestPage,
  pageSuggestions: RuntimeIngestSuggestion[],
): number | null {
  const metrics = page.lighthouse?.metrics ?? {};
  const scores = page.lighthouse?.scores ?? {};

  const penalty =
    page.violations.reduce((sum, v) => sum + (SEVERITY_WEIGHT[v.severity] ?? 2), 0) +
    pageSuggestions.reduce((sum, s) => sum + (IMPORTANCE_WEIGHT[s.importance] ?? 2), 0);

  const parts: { w: number; s: number }[] = [];
  const lcp = ratingScore(rateLcp(metrics.lcpMs ?? undefined));
  if (lcp != null) parts.push({ w: 0.5, s: lcp });
  const cls = ratingScore(rateCls(metrics.cls ?? undefined));
  if (cls != null) parts.push({ w: 0.2, s: cls });
  const inp = ratingScore(rateInp(metrics.inpMs ?? undefined));
  if (inp != null) parts.push({ w: 0.3, s: inp });

  let base: number | null = null;
  if (parts.length > 0) {
    const activeWeight = parts.reduce((a, p) => a + p.w, 0);
    base = parts.reduce((a, p) => a + p.w * p.s, 0) / activeWeight;
  } else if (typeof scores.performance === 'number') {
    base = scores.performance;
  }

  if (base == null) {
    return clamp(0, 100, Math.round(100 - penalty * 5));
  }
  return clamp(0, 100, Math.round(base - Math.min(40, penalty * 3)));
}

export async function ingestRuntimeAnalysis(payload: RuntimeIngestPayload): Promise<{ runId: string }> {
  const { appKey, run, pages, suggestions } = payload;

  await RuntimeApp.findOneAndUpdate(
    { appKey },
    {
      $set: {
        appKey,
        displayName: appKey,
        appPath: payload.appPath,
        baseUrl: payload.baseUrl,
        routerType: payload.routerType,
        lastIngestedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
      $inc: { totalRuns: 1 },
    },
    { upsert: true },
  );

  await RuntimeRun.create({
    runId: run.runId,
    appKey,
    baseUrl: payload.baseUrl,
    routerType: payload.routerType,
    formFactor: run.formFactor,
    startedAt: run.startedAt ? new Date(run.startedAt) : undefined,
    completedAt: run.completedAt ? new Date(run.completedAt) : new Date(),
    summary: run.summary,
    aiRan: run.aiRan ?? false,
    aiSummary: run.aiSummary,
    blockedAudits: run.blockedAudits ?? [],
    skippedRoutes: run.skippedRoutes ?? [],
  });

  const suggestionsForUrl = (url: string) =>
    suggestions.filter((s) => s.pageUrl === url);

  if (pages.length > 0) {
    await RuntimePageSnapshot.insertMany(
      pages.map((p) => {
        const pageSuggestions = suggestionsForUrl(p.url);
        const metrics = p.lighthouse?.metrics ?? {};
        return {
          runId: run.runId,
          appKey,
          url: p.url,
          route: p.route,
          urlHash: urlHash(p.url),
          source: p.source,
          status: p.status,
          severity: p.severity ?? null,
          violations: p.violations,
          violationCounts: violationCounts(p.violations),
          suggestionCount: pageSuggestions.length,
          webVitals: p.lighthouse ?? null,
          cwvRatings: {
            lcp: rateLcp(metrics.lcpMs ?? undefined),
            inp: rateInp(metrics.inpMs ?? undefined),
            cls: rateCls(metrics.cls ?? undefined),
          },
          runtime: p.runtime ?? null,
          healthScore: runtimePageHealthScore(p, pageSuggestions),
          scanError: p.scanError,
          durationMs: p.durationMs,
        };
      }),
    );
  }

  if (suggestions.length > 0) {
    await RuntimeSuggestion.insertMany(
      suggestions.map((s) => ({
        runId: run.runId,
        appKey,
        externalId: s.id,
        type: s.type,
        parameter: s.parameter,
        importance: s.importance,
        title: s.title,
        problem: s.problem,
        why: s.why,
        suggestion: s.suggestion,
        location: s.location,
        filePath: s.filePath,
        line: s.line,
        action: s.action,
        beforeCode: s.beforeCode?.slice(0, 2000),
        afterCode: s.afterCode?.slice(0, 2000),
        verification: s.verification,
        pageUrl: s.pageUrl,
        urlHash: s.pageUrl ? urlHash(s.pageUrl) : undefined,
        expectedImpact: s.expectedImpact,
        confidence: s.confidence,
        status: 'open',
      })),
    );
  }

  return { runId: run.runId };
}
