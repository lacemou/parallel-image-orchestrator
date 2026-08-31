import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrustedClickCommands } from '../extension/send-click.js';

test('builds a browser-level press and release at the center of the send button', () => {
  assert.deepEqual(buildTrustedClickCommands({ content: [10, 20, 110, 20, 110, 60, 10, 60] }), [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 60, y: 40, button: 'none', clickCount: 0 } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 60, y: 40, button: 'left', clickCount: 1 } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 60, y: 40, button: 'left', clickCount: 1 } },
  ]);
});

test('rejects a missing or malformed send-button box model', () => {
  assert.throws(() => buildTrustedClickCommands(null), /send_button_box_missing/);
  assert.throws(() => buildTrustedClickCommands({ content: [1, 2] }), /send_button_box_missing/);
});
