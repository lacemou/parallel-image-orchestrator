#!/usr/bin/env node
import { handleCommand } from './stdin.js';

let buffer = Buffer.alloc(0);
function write(message) {
  const body = Buffer.from(JSON.stringify(message));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([size, body]));
}
process.stdin.on('data', async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < length + 4) return;
    const command = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
    buffer = buffer.subarray(length + 4);
    try {
      const result = await handleCommand(command);
      write(result);
    } catch (error) {
      write({ ok: false, error: error.message });
    }
  }
});
