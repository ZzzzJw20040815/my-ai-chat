export const SCROLL_TO_BOTTOM_SHOW_DISTANCE = 320;
export const SCROLL_TO_BOTTOM_HIDE_DISTANCE = 96;
export const STREAM_FOLLOW_DISTANCE = 100;

export function distanceFromBottom(scroller) {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
}

export function scrollToBottomVisible(scroller, currentlyVisible = false) {
  const distance = distanceFromBottom(scroller);
  return currentlyVisible
    ? distance > SCROLL_TO_BOTTOM_HIDE_DISTANCE
    : distance > SCROLL_TO_BOTTOM_SHOW_DISTANCE;
}

export function shouldFollowStreaming(scroller) {
  return distanceFromBottom(scroller) <= STREAM_FOLLOW_DISTANCE;
}

export function scrollConversationToBottom(scroller, reducedMotion = false) {
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: reducedMotion ? 'auto' : 'smooth' });
}
