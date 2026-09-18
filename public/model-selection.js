// 同じモデルでも接続先を識別する。既存の選択値・provider のない履歴は維持する。
export const PROVIDER_LABELS = { cometapi: 'CometAPI', openai: 'OpenAI公式', gemini: 'Gemini API' };

export function parseModelSelection(value) {
  if (value.startsWith('openai:')) return { provider: 'openai', model: value.slice(7) };
  return { provider: value.startsWith('gemini-') ? 'gemini' : 'cometapi', model: value };
}

export function modelSelectionValue(params = {}) {
  const model = params.model || 'gpt-image-2';
  return params.provider === 'openai' ? `openai:${model}` : model;
}

export function usesStandardImageSizes({ provider, model } = {}) {
  return provider === 'openai' && /^gpt-image-1(?:\.5|-mini)?$/.test(model);
}

export function displayParams(params = {}) {
  const provider = params.provider || parseModelSelection(params.model || '').provider;
  return { ...params, provider: PROVIDER_LABELS[provider] || provider };
}
