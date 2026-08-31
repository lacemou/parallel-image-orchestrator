import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

test('native host returns a framed health-check response', async () => {
  const child = spawn(process.execPath, ['bridge/native-host.js']);
  const body = Buffer.from(JSON.stringify({ type: 'health_check' }));
  const frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32LE(body.length, 0); body.copy(frame, 4);
  const output = await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve); child.once('error', reject); child.stdin.end(frame);
  });
  const size = output.readUInt32LE(0);
  const response = JSON.parse(output.subarray(4, size + 4));
  assert.deepEqual(response, { ok: true, status: 'ready' });
});

test('Windows native host forwards a long-lived framed health-check response', { skip: process.platform !== 'win32' || !existsSync('native-host/parallel-image-native-host.exe') }, async () => {
  const child = spawn('native-host/parallel-image-native-host.exe', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const body = Buffer.from(JSON.stringify({ type: 'health_check' }));
  const frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  const output = await new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('windows_health_check_timeout')), 5000);
    child.once('error', reject);
    child.stdout.on('data', (data) => {
      received = Buffer.concat([received, data]);
      if (received.length < 4) return;
      const size = received.readUInt32LE(0);
      if (received.length >= size + 4) {
        clearTimeout(timer);
        resolve(received.subarray(0, size + 4));
      }
    });
    child.stdin.write(frame);
  });
  const size = output.readUInt32LE(0);
  assert.deepEqual(JSON.parse(output.subarray(4, size + 4)), { ok: true, status: 'ready' });
  child.stdin.end();
  child.kill();
});
