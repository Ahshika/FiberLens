/** iPhone / iPad detection (iPadOS reports itself as a Mac with touch). */
export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
