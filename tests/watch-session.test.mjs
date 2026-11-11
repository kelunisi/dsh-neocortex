import test from 'node:test';
import assert from 'node:assert/strict';
import { isWatchAgentSession } from '../src/watch/session.js';

test('WATCH-SESSION-01 only internal watch sessions bypass memory injection', () => {
  assert.equal(isWatchAgentSession('watch-agent-123'), true);
  assert.equal(isWatchAgentSession({ id: 'watch-probe-123' }), true);
  assert.equal(isWatchAgentSession('watch-external-123'), false);
  assert.equal(isWatchAgentSession('session-1d681076'), false);
  assert.equal(isWatchAgentSession(undefined), false);
});
