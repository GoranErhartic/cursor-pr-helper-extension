import * as vscode from 'vscode';
import type { GitHubClient, PullRequestSummary, RepoRef } from '../github/GitHubClient';
import { ciStatusIcon } from '../util/vscodeHelpers';
import { pickPrimaryJiraKey, parseProjectKeys } from '../util/jiraKey';

export type TreeItemKind =
  | 'prRoot'
  | 'prMeta'
  | 'prActionRun'
  | 'loading'
  | 'error';

export class PrTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: TreeItemKind,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly prNumber?: number,
    public readonly summary?: PullRequestSummary
  ) {
    super(label, collapsibleState);
    if (kind === 'prRoot' && summary) {
      this.description = `#${summary.number} ${summary.draft ? '(draft)' : ''} ${ciStatusIcon(summary.ciState)}`;
      this.tooltip = `${summary.title}\n${summary.headRef} → ${summary.baseRef}`;
      this.contextValue = 'prRoot';
      this.iconPath = new vscode.ThemeIcon('git-pull-request');
      this.command = {
        command: 'prHelper.openPr',
        title: 'Open PR Details',
        arguments: [summary.number],
      };
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
      this.prs = await this.github.listOpenPullRequests(ref);
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
      return Promise.resolve(
        this.prs.map(
          (pr) =>
            new PrTreeItem(
              'prRoot',
              pr.title,
              vscode.TreeItemCollapsibleState.Collapsed,
              pr.number,
              pr
            )
        )
      );
    }

    if (element.kind === 'prRoot' && element.summary) {
      const pr = element.summary;
      const config = vscode.workspace.getConfiguration('prHelper');
      const projectKeys = parseProjectKeys(config.get<string>('jiraProjectKeys') ?? '');
      const jiraKey = pickPrimaryJiraKey(pr.headRef, pr.title, projectKeys);
      const children: PrTreeItem[] = [
        new PrTreeItem(
          'prMeta',
          `CI: ${pr.ciState ?? 'unknown'} ${ciStatusIcon(pr.ciState)}`,
          vscode.TreeItemCollapsibleState.None,
          pr.number,
          pr
        ),
        new PrTreeItem(
          'prMeta',
          `Author: @${pr.author}`,
          vscode.TreeItemCollapsibleState.None,
          pr.number,
          pr
        ),
        new PrTreeItem(
          'prMeta',
          `Branch: ${pr.headRef} → ${pr.baseRef}`,
          vscode.TreeItemCollapsibleState.None,
          pr.number,
          pr
        ),
      ];
      if (pr.labels.length) {
        children.push(
          new PrTreeItem(
            'prMeta',
            `Labels: ${pr.labels.join(', ')}`,
            vscode.TreeItemCollapsibleState.None,
            pr.number,
            pr
          )
        );
      }
      if (pr.reviewers.length) {
        children.push(
          new PrTreeItem(
            'prMeta',
            `Reviewers: ${pr.reviewers.join(', ')}`,
            vscode.TreeItemCollapsibleState.None,
            pr.number,
            pr
          )
        );
      }
      if (jiraKey) {
        children.push(
          new PrTreeItem(
            'prMeta',
            `Jira: ${jiraKey}`,
            vscode.TreeItemCollapsibleState.None,
            pr.number,
            pr
          )
        );
      }
      children.push(
        new PrTreeItem('prActionRun', 'Run PR (AI review)', vscode.TreeItemCollapsibleState.None, pr.number, pr)
      );
      return Promise.resolve(children);
    }

    return Promise.resolve([]);
  }
}
