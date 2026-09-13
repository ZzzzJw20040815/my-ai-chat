export function visualViewportBounds(targetWindow = window) {
  const viewport = targetWindow.visualViewport;
  const top = Number.isFinite(viewport?.offsetTop) ? viewport.offsetTop : 0;
  const height = Number.isFinite(viewport?.height) && viewport.height > 0 ? viewport.height : targetWindow.innerHeight;
  return { top, height: Math.max(1, height) };
}

export function positionMobileSheet(sheet, scrim, targetWindow = window, margin = 10) {
  const viewport = visualViewportBounds(targetWindow);
  const available = Math.max(140, viewport.height - (margin * 2));
  sheet.style.left = margin + 'px';
  sheet.style.right = margin + 'px';
  sheet.style.bottom = 'auto';
  sheet.style.maxHeight = available + 'px';
  const measured = Math.min(available, sheet.getBoundingClientRect().height || sheet.scrollHeight || available);
  sheet.style.top = Math.max(viewport.top + margin, viewport.top + viewport.height - measured - margin) + 'px';
  if (scrim) {
    scrim.style.top = viewport.top + 'px';
    scrim.style.height = viewport.height + 'px';
  }
  return { ...viewport, available, sheetTop: Number.parseFloat(sheet.style.top) };
}

export function clearMobileSheetPosition(sheet, scrim) {
  for (const property of ['left', 'right', 'top', 'bottom', 'maxHeight']) sheet.style[property] = '';
  if (scrim) {
    scrim.style.top = '';
    scrim.style.height = '';
  }
}
