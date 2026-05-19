// utils.js – DOM ヘルパー

export function el(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if      (key === 'class')      element.className = value;
    else if (key === 'text')       element.textContent = value;
    else if (key.startsWith('on')) element.addEventListener(key.substring(2), value);
    else                           element.setAttribute(key, value);
  }
  for (const child of children) {
    if (child) element.appendChild(child);
  }
  return element;
}
