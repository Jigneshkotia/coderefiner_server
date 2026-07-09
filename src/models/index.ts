import mongoose, { Schema, type InferSchemaType } from 'mongoose';

const repoSchema = new Schema({
  repoKey: { type: String, required: true, unique: true },
  gitlabHost: String,
  owner: String,
  repo: String,
  displayName: { type: String, required: true },
  totalRuns: { type: Number, default: 0 },
  lastIngestedAt: Date,
  createdAt: { type: Date, default: Date.now },
});

const analysisRunSchema = new Schema({
  runId: { type: String, required: true, unique: true },
  repoKey: { type: String, required: true, index: true },
  status: { type: String, enum: ['completed', 'failed'], required: true },
  scopeType: { type: String, required: true },
  scopeLabel: { type: String, required: true },
  targetFiles: [String],
  targetFileCount: Number,
  compileParams: [String],
  runtimeParams: [String],
  runtimeUrls: [String],
  auditMode: String,
  model: String,
  chatId: String,
  startedAt: Date,
  completedAt: { type: Date, index: true },
  durationMs: Number,
  tokenUsage: Schema.Types.Mixed,
  mrIids: [Number],
  reportPath: String,
  suggestionsPath: String,
  summary: Schema.Types.Mixed,
});

const moduleSnapshotSchema = new Schema({
  runId: { type: String, required: true, index: true },
  repoKey: { type: String, required: true, index: true },
  modulePath: { type: String, required: true },
  moduleScope: { type: String, enum: ['file', 'directory'] },
  primaryFile: String,
  fileCount: Number,
  files: [String],
  compileParamsAudited: [String],
  issueCounts: Schema.Types.Mixed,
  issuePenalty: Schema.Types.Mixed,
  paramScores: Schema.Types.Mixed,
  healthScore: Number,
  suggestionIds: [String],
  blockedParams: [String],
  ingestedAt: { type: Date, default: Date.now },
});

const pageSnapshotSchema = new Schema({
  runId: { type: String, required: true, index: true },
  repoKey: { type: String, required: true, index: true },
  url: { type: String, required: true },
  urlPath: String,
  urlHash: String,
  runtimeParamsAudited: [String],
  rawMetrics: Schema.Types.Mixed,
  cwvRatings: Schema.Types.Mixed,
  issueCounts: Schema.Types.Mixed,
  healthScore: Number,
  suggestionIds: [String],
  blockedParams: [String],
  ingestedAt: { type: Date, default: Date.now },
});

const suggestionSchema = new Schema({
  runId: { type: String, required: true, index: true },
  repoKey: { type: String, required: true, index: true },
  externalId: { type: String, required: true },
  type: { type: String, enum: ['compile-time', 'runtime'] },
  parameter: String,
  importance: { type: String, enum: ['critical', 'moderate', 'minimal'] },
  title: String,
  problem: String,
  why: String,
  suggestion: String,
  location: String,
  filePath: String,
  line: Number,
  action: String,
  beforeCode: String,
  afterCode: String,
  verification: Schema.Types.Mixed,
  diagram: Schema.Types.Mixed,
  extractedMetrics: Schema.Types.Mixed,
  modulePath: String,
  pageUrl: String,
  status: { type: String, default: 'open' },
  ingestedAt: { type: Date, default: Date.now },
});

const workflowEventSchema = new Schema({
  runId: String,
  repoKey: { type: String, required: true, index: true },
  stage: String,
  metadata: Schema.Types.Mixed,
  tokenUsage: Schema.Types.Mixed,
  durationMs: Number,
  ingestedAt: { type: Date, default: Date.now },
});

analysisRunSchema.index({ repoKey: 1, completedAt: -1 });
moduleSnapshotSchema.index({ repoKey: 1, modulePath: 1 });
pageSnapshotSchema.index({ repoKey: 1, url: 1 });

export const Repo = mongoose.model('Repo', repoSchema);
export const AnalysisRun = mongoose.model('AnalysisRun', analysisRunSchema);
export const ModuleSnapshot = mongoose.model('ModuleSnapshot', moduleSnapshotSchema);
export const PageSnapshot = mongoose.model('PageSnapshot', pageSnapshotSchema);
export const Suggestion = mongoose.model('Suggestion', suggestionSchema);
export const WorkflowEvent = mongoose.model('WorkflowEvent', workflowEventSchema);

export type IngestSuggestion = {
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
  diagram?: unknown;
  extractedMetrics?: Record<string, unknown>;
  modulePath?: string;
  pageUrl?: string;
};

const repoTreeSchema = new Schema({
  repoKey: { type: String, required: true, unique: true },
  files: [String],
  directories: [String],
  fileCount: Number,
  syncedAt: { type: Date, default: Date.now },
  partial: { type: Boolean, default: false },
});

const issueCountsShape = {
  critical: { type: Number, default: 0 },
  moderate: { type: Number, default: 0 },
  minimal: { type: Number, default: 0 },
};

const pathStatusSchema = new Schema({
  repoKey: { type: String, required: true, index: true },
  path: { type: String, required: true },
  pathType: { type: String, enum: ['file', 'directory'], required: true },
  analysisStatus: { type: String, enum: ['none', 'clean', 'moderate', 'critical'], default: 'none' },
  healthScore: Number,
  issueCounts: Schema.Types.Mixed,
  compileIssueCounts: Schema.Types.Mixed,
  runtimeIssueCounts: Schema.Types.Mixed,
  compileHealthScore: Number,
  runtimeHealthScore: { type: Number, default: null },
  compileAnalysisStatus: { type: String, enum: ['none', 'clean', 'moderate', 'critical'], default: 'none' },
  runtimeAnalysisStatus: { type: String, enum: ['none', 'clean', 'moderate', 'critical'], default: 'none' },
  lastRunId: String,
  lastAnalyzedAt: Date,
  compileParams: [String],
  runtimeParams: [String],
  lineCount: Number,
  subtreeFileCount: Number,
});

pathStatusSchema.index({ repoKey: 1, path: 1 }, { unique: true });

const pathAnalysisHistorySchema = new Schema({
  repoKey: { type: String, required: true, index: true },
  path: { type: String, required: true },
  pathType: { type: String, enum: ['file', 'directory'], required: true },
  runId: { type: String, required: true },
  analyzedAt: { type: Date, required: true, index: true },
  analysisScope: { type: String, enum: ['file', 'folder-full', 'partial'], required: true },
  compile: {
    issueCounts: issueCountsShape,
    healthScore: Number,
    suggestionCount: Number,
    lineCount: Number,
    subtreeFileCount: Number,
  },
  runtime: {
    issueCounts: issueCountsShape,
    healthScore: Number,
    suggestionCount: Number,
    lineCount: Number,
    subtreeFileCount: Number,
  },
  compileParams: [String],
  runtimeParams: [String],
});

pathAnalysisHistorySchema.index({ repoKey: 1, path: 1, runId: 1 }, { unique: true });
pathAnalysisHistorySchema.index({ repoKey: 1, path: 1, analyzedAt: 1 });

export const RepoTree = mongoose.model('RepoTree', repoTreeSchema);
export const PathStatus = mongoose.model('PathStatus', pathStatusSchema);
export const PathAnalysisHistory = mongoose.model('PathAnalysisHistory', pathAnalysisHistorySchema);
