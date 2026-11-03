import * as vscode from 'vscode';
import type { GitHubClient, RepoRef } from '../github/GitHubClient';
import type { JiraClient } from '../jira/types';
import { prReviewGate } from '../review/activeReview';
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

  const { signal, generation } = prReviewGate.begin();
  const isCurrent = (): boolean => prReviewGate.isCurrent(generation);
  let panel: ReviewPanel | undefined;
  let outcome: 'complete' | 'failed' | 'canceled' | undefined;
  try {
    panel = ReviewPanel.show(context.extensionUri, `Review PR #${prNumber}`);
    const publish = (status: string): void => {
      if (isCurrent()) {
        panel?.setStatus(status);
      }
    };

    publish('Fetching PR metadata and comments from GitHub…');
    const detail = await github.getPullRequestDetail(ref, prNumber);
    if (!isCurrent()) {
      return;
    }

    publish('Fetching pull request diff…');
    const diff = await github.getPullRequestDiff(ref, prNumber);
    if (!isCurrent()) {
      return;
    }

    const config = vscode.workspace.getConfiguration('prHelper');
    const projectKeys = parseProjectKeys(config.get<string>('jiraProjectKeys') ?? '');
    const jiraKey = pickPrimaryJiraKeyFromTexts([detail.headRef, detail.title, detail.body], projectKeys);
    let jiraContext;
    if (!jiraKey) {
      publish('No Jira issue key found in branch, title, or PR body. Continuing with GitHub context only…');
    } else if (!(await jira.isConnected())) {
      if (!isCurrent()) {
        return;
      }
      publish(`Jira key ${jiraKey} found, but Jira is not connected. Continuing with GitHub context only…`);
    } else {
      publish(`Fetching Jira issue ${jiraKey}…`);
      jiraContext = await jira.getIssue(jiraKey);
      if (!isCurrent()) {
        return;
      }
      if (!jiraContext) {
        publish(`Jira context unavailable for ${jiraKey}. Continuing with GitHub context only…`);
      }
    }

    publish('Building review prompt…');
    const prompt = buildReviewPrompt({
      pr: detail,
      diff,
      jira: jiraContext,
      repoFullName: `${ref.owner}/${ref.repo}`,
    });

    publish(`Starting ${provider.label} review…`);
    await provider.review(
      creds.apiKey,
      creds.model,
      prompt,
      (chunk) => {
        if (isCurrent()) {
          panel?.appendMarkdown(chunk);
        }
      },
      signal,
      (status) => publish(status)
    );
    if (!isCurrent()) {
      return;
    }
    outcome = 'complete';
  } catch (err) {
    if (!isCurrent()) {
      return;
    }
    if (isAbortError(err)) {
      outcome = 'canceled';
      return;
    }
    outcome = 'failed';
    if (err instanceof ProviderError && err.code === 'invalid_key') {
      panel?.setFailed('Review failed: invalid API key.');
      const choice = await vscode.window.showErrorMessage(`PR Helper: ${err.message}`, 'Reconfigure');
      if (choice === 'Reconfigure' && isCurrent()) {
        await configureProvider(setup);
      }
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    panel?.setFailed(`Review failed: ${msg}`);
    vscode.window.showErrorMessage(`Run PR failed: ${msg}`);
  } finally {
    if (isCurrent() && panel) {
      if (outcome === 'complete') {
        panel.setComplete();
      } else if (outcome !== 'failed') {
        panel.setCanceled();
      }
    }
    prReviewGate.end(generation);
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
