import { Octokit } from '@octokit/rest';
import * as vscode from 'vscode';

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  author: string;
  draft: boolean;
  htmlUrl: string;
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  reviewers: string[];
  ciState?: 'success' | 'failure' | 'pending' | 'unknown';
  /** 'approved' | 'changes_requested' | 'pending' (waiting on review) */
  reviewStatus?: 'approved' | 'changes_requested' | 'pending';
  /** True when the branch conflicts with / is behind base and cannot merge cleanly. */
  needsRebase?: boolean;
}

export interface CheckRunInfo {
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string | null;
}

export interface CommentInfo {
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string;
  mergeableState: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: CheckRunInfo[];
  issueComments: CommentInfo[];
  reviewComments: CommentInfo[];
  reviews: { author: string; state: string; body: string }[];
}

export class GitHubClient {
  private octokit: Octokit | undefined;

  async ensureAuth(): Promise<Octokit> {
    if (this.octokit) {
      return this.octokit;
    }
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
    this.octokit = new Octokit({ auth: session.accessToken });
    return this.octokit;
  }

  reset(): void {
    this.octokit = undefined;
  }

  async listOpenPullRequests(ref: RepoRef): Promise<PullRequestSummary[]> {
    const octokit = await this.ensureAuth();
    const prs = await octokit.paginate(octokit.pulls.list, {
      owner: ref.owner,
      repo: ref.repo,
      state: 'open',
      per_page: 50,
    });

    return Promise.all(
      prs.map(async (pr): Promise<PullRequestSummary> => {
      const [ciState, reviewStatus, needsRebase] = await Promise.all([
        this.getCombinedCiState(ref, pr.head.sha),
        this.getReviewStatus(ref, pr.number),
        this.getNeedsRebase(ref, pr.number),
      ]);
      return {
        number: pr.number,
        title: pr.title,
        author: pr.user?.login ?? 'unknown',
        draft: pr.draft ?? false,
        htmlUrl: pr.html_url,
        headRef: pr.head.ref,
        baseRef: pr.base.ref,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        labels: (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean),
        reviewers: (pr.requested_reviewers ?? []).map((r) => r.login ?? '').filter(Boolean),
        ciState,
        reviewStatus,
        needsRebase,
      };
      })
    );
  }

  private async getReviewStatus(ref: RepoRef, number: number): Promise<'approved' | 'changes_requested' | 'pending'> {
    try {
      const reviews = await this.listReviews(ref, number);
      const latest = new Map<string, string>();
      for (const r of reviews) {
        if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED') {
          latest.set(r.author, r.state);
        }
      }
      const states = [...latest.values()];
      if (states.includes('CHANGES_REQUESTED')) {
        return 'changes_requested';
      }
      return states.includes('APPROVED') ? 'approved' : 'pending';
    } catch {
      return 'pending';
    }
  }

  private async getNeedsRebase(ref: RepoRef, number: number): Promise<boolean> {
    try {
      const octokit = await this.ensureAuth();
      // mergeable is computed lazily; retry briefly while null.
      for (let i = 0; i < 3; i++) {
        const { data } = await octokit.pulls.get({ owner: ref.owner, repo: ref.repo, pull_number: number });
        if (data.mergeable !== null && data.mergeable !== undefined) {
          return data.mergeable === false || data.mergeable_state === 'dirty';
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      return false;
    } catch {
      return false;
    }
  }

  async getCombinedCiState(ref: RepoRef, sha: string): Promise<PullRequestSummary['ciState']> {
    try {
      const octokit = await this.ensureAuth();
      const { data } = await octokit.repos.getCombinedStatusForRef({
        owner: ref.owner,
        repo: ref.repo,
        ref: sha,
      });
      if (data.state === 'success') {
        return 'success';
      }
      if (data.state === 'failure') {
        return 'failure';
      }
      if (data.state === 'pending') {
        return 'pending';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async getPullRequestDetail(ref: RepoRef, number: number): Promise<PullRequestDetail> {
    const octokit = await this.ensureAuth();
    const { data: pr } = await octokit.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: number,
    });

    const [checks, issueComments, reviewComments, reviews] = await Promise.all([
      this.listCheckRuns(ref, pr.head.sha),
      this.listIssueComments(ref, number),
      this.listReviewComments(ref, number),
      this.listReviews(ref, number),
    ]);

    const ciState = await this.getCombinedCiState(ref, pr.head.sha);

    return {
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? 'unknown',
      draft: pr.draft ?? false,
      htmlUrl: pr.html_url,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      labels: (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean),
      reviewers: (pr.requested_reviewers ?? []).map((r) => r.login ?? '').filter(Boolean),
      ciState,
      body: pr.body ?? '',
      mergeableState: pr.mergeable_state ?? 'unknown',
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changedFiles: pr.changed_files ?? 0,
      checks,
      issueComments,
      reviewComments,
      reviews,
    };
  }

  async getPullRequestDiff(ref: RepoRef, number: number): Promise<string> {
    const octokit = await this.ensureAuth();
    const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: number,
      headers: {
        accept: 'application/vnd.github.diff',
      },
    });
    return typeof response.data === 'string' ? response.data : '';
  }

  private async listCheckRuns(ref: RepoRef, sha: string): Promise<CheckRunInfo[]> {
    try {
      const octokit = await this.ensureAuth();
      const runs = await octokit.paginate(octokit.checks.listForRef, {
        owner: ref.owner,
        repo: ref.repo,
        ref: sha,
        per_page: 100,
      });
      return runs.map((r) => ({
        name: r.name ?? 'check',
        status: r.status ?? 'unknown',
        conclusion: r.conclusion,
        htmlUrl: r.html_url ?? null,
      }));
    } catch {
      return [];
    }
  }

  private async listIssueComments(ref: RepoRef, number: number): Promise<CommentInfo[]> {
    const octokit = await this.ensureAuth();
    const comments = await octokit.paginate(octokit.issues.listComments, {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: number,
      per_page: 100,
    });
    return comments.map((c) => ({
      author: c.user?.login ?? 'unknown',
      body: c.body ?? '',
      createdAt: c.created_at,
      url: c.html_url,
    }));
  }

  private async listReviewComments(ref: RepoRef, number: number): Promise<CommentInfo[]> {
    const octokit = await this.ensureAuth();
    const comments = await octokit.paginate(octokit.pulls.listReviewComments, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: number,
      per_page: 100,
    });
    return comments.map((c) => ({
      author: c.user?.login ?? 'unknown',
      body: c.body ?? '',
      createdAt: c.created_at,
      url: c.html_url,
    }));
  }

  private async listReviews(
    ref: RepoRef,
    number: number
  ): Promise<{ author: string; state: string; body: string }[]> {
    const octokit = await this.ensureAuth();
    const reviews = await octokit.paginate(octokit.pulls.listReviews, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: number,
      per_page: 100,
    });
    return reviews.map((r) => ({
      author: r.user?.login ?? 'unknown',
      state: r.state ?? '',
      body: r.body ?? '',
    }));
  }
}
