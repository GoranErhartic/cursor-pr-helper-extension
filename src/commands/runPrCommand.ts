import * as vscode from 'vscode';
import type { GitHubClient, RepoRef } from '../github/GitHubClient';
import type { JiraMcpClient } from '../jira/JiraMcpClient';
import { buildReviewPrompt } from '../review/buildPrompt';
import { ReviewPanel } from '../review/ReviewPanel';
import { getProvider } from '../llm/registry';
import { configureProvider, ensureLlmSetup, type SetupContext } from '../commands/providerCommands';
import { isAbortError, ProviderError } from '../llm/errors';
import { pickPrimaryJiraKey, parseProjectKeys } from '../util/jiraKey';

export async function runPrReview(
  context: vscode.ExtensionContext,
  setup: SetupContext,
  github: GitHubClient,
  jira: JiraMcpClient,
  ref: RepoRef,
  prNumber: number
): Promise<void> {
  const creds = await ensureLlmSetup(setup);
  if (!creds) {
    return;
  }
  const provider = getProvider(creds.providerId);

  const controller = new AbortController();
  const cancel = vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Running AI review for PR #${prNumber}`,
      cancellable: true,
    },
    async (progress, token) => {
      token.onCancellationRequested(() => controller.abort());
      const detail = await github.getPullRequestDetail(ref, prNumber);
      const diff = await github.getPullRequestDiff(ref, prNumber);
      const config = vscode.workspace.getConfiguration('prHelper');
      const projectKeys = parseProjectKeys(config.get<string>('jiraProjectKeys') ?? '');
      const jiraKey = pickPrimaryJiraKey(detail.headRef, detail.title, projectKeys);
      let jiraContext;
      if (jiraKey && (await jira.isConnected())) {
        jiraContext = await jira.getIssue(jiraKey);
      } else if (jiraKey && !(await jira.isConnected())) {
        vscode.window.showWarningMessage(`Jira key ${jiraKey} detected but Jira is not connected.`);
      }
      const prompt = buildReviewPrompt({
        pr: detail,
        diff,
        jira: jiraContext,
        repoFullName: `${ref.owner}/${ref.repo}`,
      });
      const panel = ReviewPanel.show(context.extensionUri, `Review PR #${prNumber}`);
      await provider.review(
        creds.apiKey,
        creds.model,
        prompt,
        (chunk) => panel.appendMarkdown(chunk),
        controller.signal,
        (status) => progress.report({ message: status })
      );
      panel.setComplete();
    }
  );
  try {
    await cancel;
  } catch (err) {
    if (isAbortError(err)) {
      return;
    }
    if (err instanceof ProviderError && err.code === 'invalid_key') {
      const choice = await vscode.window.showErrorMessage(`PR Helper: ${err.message}`, 'Reconfigure');
      if (choice === 'Reconfigure') {
        await configureProvider(setup);
      }
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Run PR failed: ${msg}`);
  }
}
