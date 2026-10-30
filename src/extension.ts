import * as vscode from 'vscode';
import { KeyStore } from './auth/keyStore';
import { GitHubClient } from './github/GitHubClient';
import { PrTreeProvider } from './views/PrTreeProvider';
import { PrDetailPanel } from './views/PrDetailPanel';
import {
  clearStoredKey,
  configureProvider,
  ensureLlmSetup,
  isLlmSetupComplete,
  selectModel,
  type SetupContext,
} from './commands/providerCommands';
import { runPrReview } from './commands/runPrCommand';
import { getWorkspaceRepo } from './util/vscodeHelpers';
import { logPrHelper } from './util/prHelperLog';
import type { JiraClient } from './jira/types';

let refreshTimer: ReturnType<typeof setInterval> | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const github = new GitHubClient();
  const jira = await createJiraClient(context);
  const setupCtx: SetupContext = { keyStore: new KeyStore(context.secrets) };

  const getRepo = () => getWorkspaceRepo();

  const treeProvider = new PrTreeProvider(github, getRepo);
  const treeView = vscode.window.createTreeView('prHelper.prs', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  let setupStartedForView = false;
  treeView.onDidChangeVisibility((e) => {
    if (!e.visible || setupStartedForView) {
      return;
    }
    void (async () => {
      if (await isLlmSetupComplete(setupCtx)) {
        return;
      }
      setupStartedForView = true;
      await ensureLlmSetup(setupCtx);
    })();
  });

  const refresh = () => treeProvider.refresh();
  refresh();

  context.subscriptions.push(
    vscode.commands.registerCommand('prHelper.refresh', refresh),
    vscode.commands.registerCommand('prHelper.configureProvider', () => configureProvider(setupCtx)),
    vscode.commands.registerCommand('prHelper.selectModel', () => selectModel(setupCtx)),
    vscode.commands.registerCommand('prHelper.clearKey', () => clearStoredKey(setupCtx)),
    vscode.commands.registerCommand('prHelper.connectJira', () => jira.connectInteractive(context)),
    vscode.commands.registerCommand('prHelper.runPr', async (prNumber?: number) => {
      const ref = getRepo();
      if (!ref) {
        vscode.window.showErrorMessage('Could not detect GitHub repository from workspace.');
        return;
      }
      let num = prNumber;
      if (typeof num !== 'number') {
        const pr = treeProvider.getPullRequest(
          Number(await vscode.window.showInputBox({ prompt: 'PR number' }))
        );
        num = pr?.number;
      }
      if (typeof num !== 'number' || Number.isNaN(num)) {
        vscode.window.showWarningMessage('Select a pull request to run.');
        return;
      }
      await runPrReview(context, setupCtx, github, jira, ref, num);
    }),
    vscode.commands.registerCommand('prHelper.openPr', async (prNumber?: number) => {
      const ref = getRepo();
      if (!ref) {
        vscode.window.showErrorMessage('Could not detect GitHub repository.');
        return;
      }
      if (typeof prNumber !== 'number') {
        vscode.window.showWarningMessage('Select a pull request to open.');
        return;
      }
      await PrDetailPanel.show(context.extensionUri, github, ref, prNumber, (n) => {
        void runPrReview(context, setupCtx, github, jira, ref, n);
      });
    })
  );

  const config = vscode.workspace.getConfiguration('prHelper');
  const intervalMin = config.get<number>('refreshIntervalMinutes') ?? 0;
  if (intervalMin > 0) {
    refreshTimer = setInterval(refresh, intervalMin * 60_000);
    context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('prHelper.refreshIntervalMinutes')) {
        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = undefined;
        }
        const mins = vscode.workspace.getConfiguration('prHelper').get<number>('refreshIntervalMinutes') ?? 0;
        if (mins > 0) {
          refreshTimer = setInterval(refresh, mins * 60_000);
        }
      }
    })
  );
}

export function deactivate(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
}

async function createJiraClient(context: vscode.ExtensionContext): Promise<JiraClient> {
  try {
    const jiraModule = await import('./jira/JiraMcpClient.js');
    return new jiraModule.JiraMcpClient(context.secrets);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logPrHelper(`Jira module failed to initialize: ${msg}`);
    void vscode.window.showWarningMessage(
      'PR Helper: Jira integration is temporarily unavailable. PR list will still work.'
    );
    return {
      async isConnected() {
        return false;
      },
      async getIssue() {
        return undefined;
      },
      async signIn() {
        throw new Error('Jira integration is unavailable in this session.');
      },
      async connectInteractive() {
        throw new Error('Jira integration is unavailable in this session.');
      },
    };
  }
}
