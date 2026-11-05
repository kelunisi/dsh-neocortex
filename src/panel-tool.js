const READ_ACTIONS = new Set(['state', 'preview_review']);
const ACTIONS = new Set([...READ_ACTIONS, 'undo', 'manual_review', 'retry_review', 'update_settings']);

export function isPanelReadAction(action) {
  return READ_ACTIONS.has(action);
}

export function executePanelTool(panel, request, sessionId) {
  const { action, id, settings } = request;
  if (!ACTIONS.has(action)) {
    return { status: 'rejected', reason: 'unknown-or-user-only-action', action };
  }
  switch (action) {
    case 'state':
      return panel.state();
    case 'preview_review':
      if (!id) return { status: 'rejected', reason: 'id-required' };
      return panel.review.preview(id);
    case 'undo':
      if (!id) return { status: 'rejected', reason: 'id-required' };
      return panel.undo({ id }, sessionId);
    case 'manual_review':
      return panel.manualReview({}, sessionId);
    case 'retry_review':
      return panel.retryReview({}, sessionId);
    case 'update_settings':
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return { status: 'rejected', reason: 'settings-required' };
      }
      return panel.updateSettings(settings);
    default:
      return { status: 'rejected', reason: 'unknown-or-user-only-action', action };
  }
}
