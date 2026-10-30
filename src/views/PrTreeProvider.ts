import * as vscode from 'vscode';
import type { GitHubClient, PullRequestSummary, RepoRef } from '../github/GitHubClient';

export type TreeItemKind =
  | 'group'
  | 'prRoot'
  | 'prMeta'
  | 'prActionRun'
  | 'loading'
  | 'error';

/** Red: needs rebase / cannot merge. Green: approved. Yellow: waiting on review. */
function prIcon(pr: PullRequestSummary): vscode.ThemeIcon {
  let color = 'charts.yellow';
  if (pr.needsRebase) {
    color = 'charts.red';
  } else if (pr.reviewStatus === 'approved') {
    color = 'charts.green';
  }
  return new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor(color));
}

export class PrTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: TreeItemKind,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly prNumber?: number,
    public readonly summary?: PullRequestSummary,
    public readonly groupDraft?: boolean
  ) {
    super(label, collapsibleState);
    if (kind === 'group') {
      this.contextValue = 'prGroup';
      this.iconPath = new vscode.ThemeIcon(groupDraft ? 'edit' : 'eye');
    }
    if (kind === 'prRoot' && summary) {
      this.description = `@${summary.author}`;
      this.tooltip = `${summary.title}\n${summary.headRef} → ${summary.baseRef}`;
      this.contextValue = 'prRoot';
      this.iconPath = prIcon(summary);
      this.label = `\u2002${label}`;
      this.command = {
        command: 'prHelper.openPr',
        title: 'Open PR Details',
        arguments: [summary.number],
      };
    }
    if (kind === 'loading') {
      this.iconPath = new vscode.ThemeIcon('loading~spin');
    }
    if (kind === 'prActionRun') {
      this.contextValue = 'prActionRun';
      this.iconPath = new vscode.ThemeIcon('play');
      this.command = {
        command: 'prHelper.runPr',
        title: 'Run PR',
        arguments: [prNumber],
      };
    }
  }
}

export class PrTreeProvider implements vscode.TreeDataProvider<PrTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PrTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private prs: PullRequestSummary[] = [];
  private loadError: string | undefined;
  private loading = false;

  constructor(
    private readonly github: GitHubClient,
    private readonly getRepo: () => RepoRef | undefined
  ) {}

  refresh(): void {
    void this.loadPullRequests();
  }

  getPullRequest(number: number): PullRequestSummary | undefined {
    return this.prs.find((p) => p.number === number);
  }

  async loadPullRequests(): Promise<void> {
    const ref = this.getRepo();
    if (!ref) {
      this.loadError = 'Open a folder with a GitHub origin remote.';
      this.prs = [];
      this._onDidChangeTreeData.fire(undefined);
      return;
    }
    this.loading = true;
    this.loadError = undefined;
    this._onDidChangeTreeData.fire(undefined);
    try {
      this.prs = await vscode.window.withProgress(
        { location: { viewId: 'prHelper.prs' } },
        () => this.github.listOpenPullRequests(ref)
      );
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
      this.prs = [];
    } finally {
      this.loading = false;
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  getTreeItem(element: PrTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PrTreeItem): Thenable<PrTreeItem[]> {
    if (!element) {
      if (this.loading) {
        return Promise.resolve([
          new PrTreeItem('loading', 'Loading pull requests…', vscode.TreeItemCollapsibleState.None),
        ]);
      }
      if (this.loadError) {
        return Promise.resolve([
          new PrTreeItem('error', this.loadError, vscode.TreeItemCollapsibleState.None),
        ]);
      }
      if (this.prs.length === 0) {
        return Promise.resolve([
          new PrTreeItem('prMeta', 'No open pull requests', vscode.TreeItemCollapsibleState.None),
        ]);
      }
      const groups: PrTreeItem[] = [];
      const ready = this.prs.filter((p) => !p.draft).length;
      const drafts = this.prs.length - ready;
      if (ready > 0) {
        groups.push(
          new PrTreeItem(
            'group',
            `Ready for review (${ready})`,
            vscode.TreeItemCollapsibleState.Expanded,
            undefined,
            undefined,
            false
          )
        );
      }
      if (drafts > 0) {
        groups.push(
          new PrTreeItem(
            'group',
            `Draft (${drafts})`,
            vscode.TreeItemCollapsibleState.Expanded,
            undefined,
            undefined,
            true
          )
        );
      }
      return Promise.resolve(groups);
    }

    if (element.kind === 'group') {
      return Promise.resolve(
        this.prs
          .filter((pr) => pr.draft === element.groupDraft)
          .map(
            (pr) =>
              new PrTreeItem(
                'prRoot',
                pr.title,
                vscode.TreeItemCollapsibleState.None,
                pr.number,
                pr
              )
          )
      );
    }

    return Promise.resolve([]);
  }
}
