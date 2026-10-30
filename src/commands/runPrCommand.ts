import * as vscode from 'vscode';
import type { GitHubClient, RepoRef } from '../github/GitHubClient';
import type { JiraClient } from '../jira/types';
import { buildReviewPrompt } from '../review/buildPrompt';
import { ReviewPanel } from '../review/ReviewPanel';
import { getProvider } from '../llm/registry';
import { configureProvider, ensureLlmSetup, type SetupContext } from '../commands/providerCommands';
import { isAbortError, ProviderError } from '../llm/errors';
import { parseProjectKeys, pickPrimaryJiraKeyFromTexts } from '../util/jiraKey';

export async function runPrReview(
  context: vscode.ExtensionContext,
  setup: SetupContext,
  github: GitHubClient,
  jira: JiraClient,
  ref: RepoRef,
  prNumber: number
): Promise<void> {
  const creds = await ensureLlmSetup(setup);
  if (!creds) {
    return;
  }
  const provider = getProvider(creds.providerId);
  await promptForJiraAuthorization(jira);

  const panel = ReviewPanel.show(context.extensionUri, `Review PR #${prNumber}`);
  try {
    panel.setStatus('Fetching PR metadata and comments from GitHub…');
    const detail = await github.getPullRequestDetail(ref, prNumber);

    panel.setStatus('Fetching pull request diff…');
    const diff = await github.getPullRequestDiff(ref, prNumber);

    const config = vscode.workspace.getConfiguration('prHelper');
    const projectKeys = parseProjectKeys(config.get<string>('jiraProjectKeys') ?? '');
    const jiraKey = pickPrimaryJiraKeyFromTexts([detail.headRef, detail.title, detail.body], projectKeys);
    let jiraContext;
    if (!jiraKey) {
      panel.setStatus('No Jira issue key found in branch, title, or PR body. Continuing with GitHub context only…');
    } else if (!(await jira.isConnected())) {
      panel.setStatus(`Jira key ${jiraKey} found, but Jira is not connected. Continuing with GitHub context only…`);
    } else {
      panel.setStatus(`Fetching Jira issue ${jiraKey}…`);
      jiraContext = await jira.getIssue(jiraKey);
      if (!jiraContext) {
        panel.setStatus(`Jira context unavailable for ${jiraKey}. Continuing with GitHub context only…`);
      }
    }

    panel.setStatus('Building review prompt…');
    const prompt = buildReviewPrompt({
      pr: detail,
      diff,
      jira: jiraContext,
      repoFullName: `${ref.owner}/${ref.repo}`,
    });

    panel.setStatus(`Starting ${provider.label} review…`);
    await provider.review(
      creds.apiKey,
      creds.model,
      prompt,
      (chunk) => panel.appendMarkdown(chunk),
      undefined,
      (status) => panel.setStatus(status)
    );
    panel.setComplete();
  } catch (err) {
    if (isAbortError(err)) {
      panel.setStatus('Review canceled.');
      return;
    }
    if (err instanceof ProviderError && err.code === 'invalid_key') {
      panel.setStatus('Review failed: invalid API key.');
      const choice = await vscode.window.showErrorMessage(`PR Helper: ${err.message}`, 'Reconfigure');
      if (choice === 'Reconfigure') {
        await configureProvider(setup);
      }
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    panel.setStatus(`Review failed: ${msg}`);
    vscode.window.showErrorMessage(`Run PR failed: ${msg}`);
  }
}

async function promptForJiraAuthorization(jira: JiraClient): Promise<void> {
  if (await jira.isConnected()) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    'Jira MCP is not connected. Authorize Jira for better review results?',
    'Authorize Jira',
    'Continue without Jira'
  );
  if (choice !== 'Authorize Jira') {
    return;
  }
  try {
    await jira.signIn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Jira sign-in failed: ${msg}`);
  }
}
