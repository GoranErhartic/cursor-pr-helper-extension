import type { LlmProvider, ModelInfo, ProviderId, ReviewInput } from './types';
import { OpenAiProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { CursorProvider } from './cursor';

const openai = new OpenAiProvider();
const anthropic = new AnthropicProvider();
const cursor = new CursorProvider();

export function getProvider(id: ProviderId): LlmProvider {
  switch (id) {
    case 'openai':
      return openai;
    case 'anthropic':
      return anthropic;
    case 'cursor':
      return cursor;
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

export function listProviderIds(): LlmProvider[] {
  return [openai, anthropic, cursor];
}

export type { LlmProvider, ModelInfo, ReviewInput };
