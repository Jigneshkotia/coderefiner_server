import {
  AnalysisRun,
  ModuleSnapshot,
  PageSnapshot,
  PathAnalysisHistory,
  PathStatus,
  Repo,
  RepoTree,
  Suggestion,
  WorkflowEvent,
} from '../../models/index.js';

export async function deleteRepo(repoKey: string): Promise<void> {
  const repo = await Repo.findOne({ repoKey });
  if (!repo) {
    throw new Error('Repo not found');
  }

  await Promise.all([
    AnalysisRun.deleteMany({ repoKey }),
    Suggestion.deleteMany({ repoKey }),
    ModuleSnapshot.deleteMany({ repoKey }),
    PageSnapshot.deleteMany({ repoKey }),
    WorkflowEvent.deleteMany({ repoKey }),
    PathStatus.deleteMany({ repoKey }),
    PathAnalysisHistory.deleteMany({ repoKey }),
    RepoTree.deleteOne({ repoKey }),
    Repo.deleteOne({ repoKey }),
  ]);
}
