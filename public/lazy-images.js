import { el } from './utils.js';

const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

function loadImage(img, source, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onLoad = () => {
      // Keep the slot occupied until decoding completes, including cached images.
      if (typeof img.decode === 'function') img.decode().then(() => finish(), () => finish());
      else finish();
    };
    const onError = () => finish(new Error('Image loading failed'));
    const onAbort = () => {
      finish(new Error('Image loading cancelled'));
      img.src = PLACEHOLDER;
    };
    const timer = setTimeout(() => {
      finish(new Error('Image loading timed out'));
      img.src = PLACEHOLDER;
    }, 30000);
    img.addEventListener('load', onLoad, { once: true });
    img.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
    img.loading = 'eager'; // IntersectionObserver already controls the preload distance.
    img.src = source;
  });
}

export function createLazyImageLoader({
  maxConcurrent = 2,
  preloadDistance = 500,
  Observer = globalThis.IntersectionObserver,
  schedule = callback => requestAnimationFrame(callback),
} = {}) {
  const queued = new Set();
  const active = new Map();
  let scheduled = false;

  const observer = Observer ? new Observer(observations => {
    for (const observed of observations) {
      const img = observed.target;
      if (!img.isConnected) { release(img); continue; }
      if (observed.isIntersecting) queued.add(img);
      else queued.delete(img); // Fast scrolling must not leave a backlog behind it.
    }
    schedulePump();
  }, { root: null, rootMargin: `${preloadDistance}px 0px`, threshold: 0.01 }) : null;

  function schedulePump() {
    if (scheduled || !queued.size) return;
    scheduled = true;
    schedule(() => { scheduled = false; pump(); });
  }

  async function start(img) {
    const controller = new AbortController();
    active.set(img, controller);
    observer?.unobserve(img);
    try {
      await loadImage(img, img.dataset.src, controller.signal);
    } catch {
      // A failed/cancelled image must not block the remaining visible images.
    } finally {
      img.classList.remove('is-lazy');
      active.delete(img);
      schedulePump();
    }
  }

  function pump() {
    for (const img of queued) {
      if (active.size >= maxConcurrent) break;
      queued.delete(img);
      if (!img.isConnected || active.has(img) || !img.classList.contains('is-lazy')) continue;
      void start(img);
    }
  }

  function observe(img) {
    if (observer) observer.observe(img);
    else { queued.add(img); schedulePump(); }
  }

  function release(img) {
    observer?.unobserve(img);
    queued.delete(img);
    active.get(img)?.abort();
  }

  return {
    observe,
    release,
    create(source, attrs = {}) {
      const img = el('img', {
        ...attrs,
        class: `${attrs.class ? `${attrs.class} ` : ''}is-lazy`,
        src: PLACEHOLDER,
        loading: 'lazy',
        decoding: 'async',
      });
      img.dataset.src = source;
      observe(img);
      return img;
    },
  };
}
