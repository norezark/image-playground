'use strict';

const API_BASE        = 'https://api.cometapi.com/v1/images';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

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
  const API_KEY = process.env.OPENAI_API_KEY;
  const payload = {
    model:  params.model || 'gpt-image-2',
    prompt,
    n:      params.n ? Number(params.n) : 1,
    size:   params.size || '1024x1024',
  };
  if (params.quality)        payload.quality        = params.quality;
  if (params.input_fidelity) payload.input_fidelity = params.input_fidelity;
  if (params.background)     payload.background     = params.background;
  if (params.format)         payload.format         = params.format;
  if (params.moderation)     payload.moderation     = params.moderation;
  if (params.style)          payload.style          = params.style;
  if (params.output_compression !== undefined && params.output_compression !== '') {
    const v = parseInt(params.output_compression, 10);
    if (!Number.isNaN(v)) payload.output_compression = v;
  }
  return apiFetch(`${API_BASE}/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(payload),
    signal,
  });
}

async function callEdits(prompt, params, inputImageFiles, signal) {
  const API_KEY = process.env.OPENAI_API_KEY;
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
  return apiFetch(`${API_BASE}/edits`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}` },
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

module.exports = { isGeminiModel, apiFetch, callGenerations, callEdits, callGemini };
