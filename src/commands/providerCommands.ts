import * as vscode from 'vscode';
import type { KeyStore } from '../auth/keyStore';
import { isAbortError, ProviderError } from '../llm/errors';
import { getProvider, listProviderIds } from '../llm/registry';
import { isProviderId, type ModelInfo, type ProviderId } from '../llm/types';

export type SetupContext = {
  keyStore: KeyStore;
};

export interface ReviewCredentials {
  providerId: ProviderId;
  apiKey: string;
  model: string;
}

const CONFIG_SECTION = 'prHelper';

export function getConfiguredProvider(): ProviderId {
  const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('provider', 'openai');
  return isProviderId(raw) ? raw : 'openai';
}

export function getConfiguredModel(): string {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('model', '').trim();
}

async function setConfiguredProvider(providerId: ProviderId): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update('provider', providerId, vscode.ConfigurationTarget.Global);
}

async function setConfiguredModel(model: string): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update('model', model, vscode.ConfigurationTarget.Global);
}

export async function isLlmSetupComplete(ctx: SetupContext): Promise<boolean> {
  return Boolean(getConfiguredModel()) && (await ctx.keyStore.hasKey(getConfiguredProvider()));
}

async function pickProvider(): Promise<ProviderId | undefined> {
  const picked = await vscode.window.showQuickPick(
    listProviderIds().map((p) => ({ label: p.label, description: p.id, id: p.id })),
    {
      title: 'PR Helper — Select provider',
      placeHolder: 'Choose an LLM provider',
      ignoreFocusOut: true,
    }
  );
  return picked?.id;
}

async function promptApiKey(providerLabel: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `PR Helper — ${providerLabel} API key`,
    prompt: 'Enter your API key (stored securely in Secret Storage)',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'API key is required'),
  });
}

async function reportProviderError(err: unknown, fallback: string): Promise<void> {
  if (err instanceof ProviderError) {
    await vscode.window.showErrorMessage(`PR Helper: ${err.message}`);
  } else {
    await vscode.window.showErrorMessage(`PR Helper: ${fallback}`);
  }
}

/** Validates the key against the provider (cancellable); stores it only on success. */
async function validateAndStoreKey(
  ctx: SetupContext,
  providerId: ProviderId,
  apiKey: string
): Promise<boolean> {
  const provider = getProvider(providerId);
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Validating ${provider.label} API key…`,
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        await provider.validateKey(apiKey, controller.signal);
      }
    );
  } catch (err) {
    if (isAbortError(err)) {
      return false;
    }
    await reportProviderError(err, 'Could not validate API key. Check your network connection.');
    return false;
  }

  await ctx.keyStore.setKey(providerId, apiKey);
  if (getConfiguredProvider() !== providerId) {
    // A model from another provider is not valid here; force a fresh pick.
    await setConfiguredModel('');
  }
  await setConfiguredProvider(providerId);
  // Do not await: the toast promise only resolves on dismissal and would block the model picker.
  void vscode.window.showInformationMessage(`PR Helper: ${provider.label} API key verified.`);
  return true;
}

async function pickModelForProvider(
  providerId: ProviderId,
  apiKey: string
): Promise<string | undefined> {
  const provider = getProvider(providerId);
  let models: ModelInfo[];
  try {
    models = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Loading models…',
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return provider.listModels(apiKey, controller.signal);
      }
    );
  } catch (err) {
    if (!isAbortError(err)) {
      await reportProviderError(err, 'Failed to load models.');
    }
    return undefined;
  }

  if (models.length === 0) {
    await vscode.window.showWarningMessage('PR Helper: No models returned by the provider.');
    return undefined;
  }

  const current = getConfiguredModel();
  const picked = await vscode.window.showQuickPick(
    models.map((m) => ({ label: m.label, description: m.id, id: m.id, picked: m.id === current })),
    {
      title: 'PR Helper — Select model',
      placeHolder: 'Choose a model for PR reviews',
      ignoreFocusOut: true,
    }
  );
  return picked?.id;
}

/** Provider → API key (validated) → model. */
export async function configureProvider(ctx: SetupContext): Promise<boolean> {
  const providerId = await pickProvider();
  if (!providerId) {
    return false;
  }
  const provider = getProvider(providerId);
  const apiKey = (await promptApiKey(provider.label))?.trim();
  if (!apiKey) {
    return false;
  }
  if (!(await validateAndStoreKey(ctx, providerId, apiKey))) {
    return false;
  }
  const model = await pickModelForProvider(providerId, apiKey);
  if (model) {
    await setConfiguredModel(model);
    void vscode.window.showInformationMessage(`PR Helper: Using model ${model}.`);
  }
  return true;
}

export async function selectModel(ctx: SetupContext): Promise<boolean> {
  const providerId = getConfiguredProvider();
  const apiKey = await ctx.keyStore.getKey(providerId);
  if (!apiKey) {
    return configureProvider(ctx);
  }
  const model = await pickModelForProvider(providerId, apiKey);
  if (!model) {
    return false;
  }
  await setConfiguredModel(model);
  void vscode.window.showInformationMessage(`PR Helper: Using model ${model}.`);
  return true;
}

/**
 * Returns credentials ready for a review, offering to run setup first when the
 * API key or model is missing.
 */
export async function ensureLlmSetup(ctx: SetupContext): Promise<ReviewCredentials | undefined> {
  if (!(await isLlmSetupComplete(ctx))) {
    const proceed = await vscode.window.showInformationMessage(
      'PR Helper needs an API key and model before running reviews.',
      'Configure',
      'Cancel'
    );
    if (proceed !== 'Configure') {
      return undefined;
    }
    const providerId = getConfiguredProvider();
    const ok = (await ctx.keyStore.hasKey(providerId))
      ? await selectModel(ctx)
      : await configureProvider(ctx);
    if (!ok) {
      return undefined;
    }
  }

  const providerId = getConfiguredProvider();
  const apiKey = await ctx.keyStore.getKey(providerId);
  const model = getConfiguredModel();
  if (!apiKey || !model) {
    return undefined;
  }
  return { providerId, apiKey, model };
}

export async function clearStoredKey(ctx: SetupContext): Promise<void> {
  const providerId = getConfiguredProvider();
  await ctx.keyStore.deleteKey(providerId);
  await setConfiguredModel('');
  await vscode.window.showInformationMessage(`PR Helper: Cleared stored API key for ${providerId}.`);
}
