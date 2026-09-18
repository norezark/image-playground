'use strict';

const IMAGE_API_BASES = {
  cometapi: 'https://api.cometapi.com/v1/images',
  openai: 'https://api.openai.com/v1/images',
};
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const PROVIDER_NAMES = { cometapi: 'CometAPI', openai: 'OpenAI公式', gemini: 'Gemini API' };
const KEY_SETTINGS = {
  cometapi: 'COMET_API_KEY または従来の OPENAI_API_KEY',
  openai: 'OPENAI_OFFICIAL_API_KEY',
  gemini: 'NANO_BANANA_API_KEY',
};

function getProviderKeys() {
  return {
    // OPENAI_API_KEY は従来の CometAPI 設定との互換性のためにのみ使用する。
    cometapi: process.env.COMET_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim(),
    openai: process.env.OPENAI_OFFICIAL_API_KEY?.trim(),
    gemini: process.env.NANO_BANANA_API_KEY?.trim(),
  };
}

function getProviderAvailability() {
  return Object.fromEntries(Object.entries(getProviderKeys()).map(([provider, key]) => [provider, !!key]));
}

function validateGenerationParams(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('params が不正です');
  }
  if (params.model !== undefined && (typeof params.model !== 'string' || !params.model)) {
    throw new Error('model が不正です');
  }
  const gemini = isGeminiModel(params.model);
  const provider = params.provider ?? (gemini ? 'gemini' : 'cometapi');
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDER_NAMES, provider)) throw new Error('未対応の接続先です');
  if (gemini !== (provider === 'gemini')) throw new Error('モデルと接続先の組み合わせが不正です');
  if (provider === 'openai') {
    const model = params.model || 'gpt-image-2';
    if (!/^(gpt-image-1(?:\.5|-mini)?|gpt-image-2(?:-2026-04-21)?|gpt-image-2\.5-(flare|sunburst)(?:-2026-09-08)?)$/.test(model)) {
      throw new Error('このモデルは OpenAI公式のモデル一覧にありません');
    }
    if (/^gpt-image-1(?:\.5|-mini)?$/.test(model) && params.size
      && !['auto', '1024x1024', '1536x1024', '1024x1536'].includes(params.size)) {
      throw new Error('この公式モデルのサイズは auto / 1024x1024 / 1536x1024 / 1024x1536 から選択してください');
    }
  }
  if (!getProviderAvailability()[provider]) {
    throw new Error(`${PROVIDER_NAMES[provider]} のAPIキーが未設定です。${KEY_SETTINGS[provider]} を設定してサーバーを再起動してください`);
  }
  return { ...params, provider };
}

function getImageApiConfig(params) {
  const { provider } = validateGenerationParams(params);
  if (!Object.hasOwn(IMAGE_API_BASES, provider)) throw new Error('Images API の接続先が不正です');
  return { provider, base: IMAGE_API_BASES[provider], key: getProviderKeys()[provider] };
}

function isGeminiModel(model) {
  return typeof model === 'string' && model.startsWith('gemini-');
}

// ---- OpenAI API 呼び出し ----
async function apiFetch(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).error?.message || detail; } catch {}
    throw new Error(`API リクエスト失敗: ${res.status} ${res.statusText} - ${detail}`);
  }
  return res.json();
}

async function callGenerations(prompt, params, signal) {
  const { provider, base, key } = getImageApiConfig(params);
  const isImage25 = /^gpt-image-2\.5-(flare|sunburst)(-2026-09-08)?$/.test(params.model);
  const payload = {
    model:  params.model || 'gpt-image-2',
    prompt,
    n:      params.n ? Number(params.n) : 1,
    size:   params.size || '1024x1024',
  };
  if (params.quality)        payload.quality        = params.quality;
  if (params.input_fidelity && !isImage25 && provider === 'cometapi') payload.input_fidelity = params.input_fidelity;
  if (params.background)     payload.background     = params.background;
  // 公式 API と CometAPI の 2.5 は output_format、それ以外の CometAPI は従来の format。
  if (params.format) payload[provider === 'openai' || isImage25 ? 'output_format' : 'format'] = params.format;
  if (params.moderation)     payload.moderation     = params.moderation;
  if (params.style && provider === 'cometapi') payload.style = params.style;
  if (params.output_compression !== undefined && params.output_compression !== '') {
    const v = parseInt(params.output_compression, 10);
    if (!Number.isNaN(v)) payload.output_compression = v;
  }
  return apiFetch(`${base}/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(payload),
    signal,
  });
}

async function callEdits(prompt, params, inputImageFiles, signal) {
  const { base, key } = getImageApiConfig(params);
  const form = new FormData();
  form.append('model',  params.model || 'gpt-image-1.5');
  form.append('prompt', prompt);
  if (params.n)              form.append('n',             String(Number(params.n)));
  if (params.size)           form.append('size',          params.size);
  if (params.quality)        form.append('quality',       params.quality);
  if (params.input_fidelity) form.append('input_fidelity', params.input_fidelity);
  if (params.background)     form.append('background',    params.background);
  if (params.format)         form.append('output_format', params.format);
  if (params.moderation)     form.append('moderation',    params.moderation);
  if (params.output_compression !== undefined && params.output_compression !== '') {
    const v = parseInt(params.output_compression, 10);
    if (!Number.isNaN(v)) form.append('output_compression', String(v));
  }
  for (const img of inputImageFiles) {
    form.append('image[]', new Blob([img.buffer], { type: img.mimeType }), img.filename);
  }
  return apiFetch(`${base}/edits`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}` },
    body: form,
    signal,
  });
}

// ---- Gemini API 呼び出し ----
async function callGemini(prompt, params, inputImageFiles, signal) {
  const NANO_BANANA_API_KEY = process.env.NANO_BANANA_API_KEY;
  if (!NANO_BANANA_API_KEY) {
    throw new Error('NANO_BANANA_API_KEY が設定されていません');
  }
  const model = params.model;
  const n     = Math.max(1, Number(params.n) || 1);

  const parts = [{ text: prompt }];
  for (const img of inputImageFiles) {
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data:     img.buffer.toString('base64'),
      },
    });
  }

  const modalities = params.gemini_output_format === 'IMAGE_AND_TEXT' ? ['TEXT', 'IMAGE'] : ['IMAGE'];
  const generationConfig = { responseModalities: modalities };
  const aspectRatio  = params.gemini_aspect_ratio;
  const imageSize    = params.gemini_image_size;
  const useImageSize = imageSize && model !== 'gemini-2.5-flash-image';
  if (aspectRatio || useImageSize) {
    generationConfig.imageConfig = {};
    if (aspectRatio)  generationConfig.imageConfig.aspectRatio = aspectRatio;
    if (useImageSize) generationConfig.imageConfig.imageSize   = imageSize;
  }
  if (params.gemini_temperature !== undefined && params.gemini_temperature !== null) {
    generationConfig.temperature = Number(params.gemini_temperature);
  }
  if (params.gemini_top_p !== undefined && params.gemini_top_p !== null) {
    generationConfig.topP = Number(params.gemini_top_p);
  }
  if (params.gemini_thinking_level) {
    generationConfig.thinkingConfig = { thinkingLevel: params.gemini_thinking_level };
  }

  const supportsImageSearch = model === 'gemini-3.1-flash-image-preview';
  const useWebSearch   = !!params.gemini_grounding_web;
  const useImageSearch = !!params.gemini_grounding_image && supportsImageSearch;
  const tools = [];
  if (useWebSearch || useImageSearch) {
    if (useWebSearch && !useImageSearch) {
      tools.push({ googleSearch: {} });
    } else {
      const searchTypes = {};
      if (useWebSearch)   searchTypes.webSearch   = {};
      if (useImageSearch) searchTypes.imageSearch = {};
      tools.push({ googleSearch: { searchTypes } });
    }
  }

  const body = { contents: [{ parts }], generationConfig };
  if (tools.length > 0) body.tools = tools;
  const url  = `${GEMINI_API_BASE}/models/${model}:generateContent`;

  const makeRequest = () => apiFetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': NANO_BANANA_API_KEY },
    body:    JSON.stringify(body),
    signal,
  });

  const results = await Promise.all(Array.from({ length: n }, makeRequest));

  const data = [];
  const textReasons = [];
  for (const res of results) {
    const candidate = res?.candidates?.[0];
    const finishReason = candidate?.finishReason;
    for (const part of (candidate?.content?.parts || [])) {
      if (!part.thought && part.inlineData?.data) {
        data.push({ b64_json: part.inlineData.data, mime_type: part.inlineData.mimeType || 'image/png' });
      } else if (part.text) {
        textReasons.push(part.text.trim());
      }
    }
    if (data.length === 0 && finishReason && finishReason !== 'STOP') {
      textReasons.push(`finishReason: ${finishReason}`);
    }
  }

  if (data.length === 0) {
    const reason = textReasons.filter(Boolean).join(' / ') || '画像が生成されませんでした（モデレーションによりブロックされた可能性があります）';
    throw new Error(reason);
  }

  return { data };
}

module.exports = { isGeminiModel, apiFetch, callGenerations, callEdits, callGemini,
  getProviderAvailability, validateGenerationParams };
