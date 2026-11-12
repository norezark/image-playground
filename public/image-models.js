// Shared by the browser (side-effect import) and Node.js (require), without a build step.
(function () {
  'use strict';
  const IMAGE_26 = /^gpt-image-2\.6-(flare|sunburst)$/;
  const IMAGE_25 = /^gpt-image-2\.5-(flare|sunburst)(-2026-09-08)?$/;
  const hasValue = value => value !== undefined && value !== null && value !== '';

  function getImageModelCapabilities(model = '') {
    const image26 = IMAGE_26.test(model);
    const image25 = IMAGE_25.test(model);
    return {
      image26, image25,
      extendedQuality: image26 || image25,
      complexity: image26,
      markup: image26 || image25,
      transparency: image26 || image25,
      inputFidelity: !image26,
      formats: image26 ? ['png', 'jpeg', 'webp', 'gif', 'svg'] : ['png', 'jpeg', 'webp'],
    };
  }

  function validateImageOptions(params, { editing = false, hasMarkup = false } = {}) {
    const caps = getImageModelCapabilities(params.model);
    const format = params.format || 'png';
    const n = hasValue(params.n) ? Number(params.n) : 1;
    if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('生成枚数は1〜10で指定してください。');
    if (!caps.formats.includes(format)) throw new Error('このモデルでは指定した出力形式を利用できません。');
    if (hasValue(params.complexity) && (!caps.complexity || !['low', 'medium', 'high'].includes(params.complexity))) {
      throw new Error('ComplexityはGPT Image 2.6でlow / medium / highから選択してください。');
    }
    if (hasMarkup && (!editing || !caps.markup)) throw new Error('描き込みにはGPT Image 2.5 / 2.6と入力画像が必要です。');
    if (format === 'svg' && (editing || n !== 1)) throw new Error('SVGは入力画像なし・生成枚数1で利用してください。');
    if (hasValue(params.frame_count) || hasValue(params.frame_duration_ms)) {
      if (format !== 'gif') throw new Error('フレーム設定はGIF出力でのみ利用できます。');
      const frames = hasValue(params.frame_count) ? Number(params.frame_count) : 9;
      const duration = hasValue(params.frame_duration_ms) ? Number(params.frame_duration_ms) : 200;
      if (!Number.isInteger(frames) || frames < 2 || frames > 16) throw new Error('GIFのフレーム数は2〜16で指定してください。');
      if (!Number.isInteger(duration) || duration < 20 || duration > 2000) throw new Error('GIFの表示時間は20〜2000msで指定してください。');
    }
    if (hasValue(params.svg_model) || hasValue(params.svg_reasoning)) {
      if (format !== 'svg') throw new Error('SVG作成モデルの設定はSVG出力でのみ利用できます。');
      if (typeof params.svg_model !== 'string' || !params.svg_model.trim()) throw new Error('SVGの推論量を指定する場合は作成モデルも指定してください。');
      if (hasValue(params.svg_reasoning) && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(params.svg_reasoning)) {
        throw new Error('SVG作成モデルの推論量が不正です。');
      }
    }
    if (params.background === 'transparent' && !['png', 'webp'].includes(format)) {
      throw new Error('透過背景にはPNG / WebPを選択してください。');
    }
    if (!caps.image26) return;
    if (hasValue(params.quality) && !['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(params.quality)) {
      throw new Error('画質の設定が不正です。');
    }
    if (hasValue(params.output_compression)) {
      const compression = Number(params.output_compression);
      if (!['jpeg', 'webp'].includes(format) || !Number.isInteger(compression) || compression < 0 || compression > 100) {
        throw new Error('圧縮率はJPEG / WebPで0〜100から指定してください。');
      }
    }
    if (params.size && params.size !== 'auto') {
      const match = /^(\d+)x(\d+)$/.exec(params.size);
      const [width, height] = match ? match.slice(1).map(Number) : [0, 0];
      if (!width || !height || width % 16 || height % 16 || Math.max(width, height) > 3840 || Math.max(width, height) / Math.min(width, height) > 3) {
        throw new Error('画像サイズは各辺16の倍数・最大辺3840px・縦横比3:1以内で指定してください。');
      }
      if (format !== 'gif' && (width * height < 655360 || width * height > 8294400)) {
        throw new Error('画像の画素数は655,360〜8,294,400で指定してください。');
      }
    }
  }

  const api = { getImageModelCapabilities, validateImageOptions };
  globalThis.ImagePlaygroundModels = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
