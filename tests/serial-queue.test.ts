import assert from "node:assert/strict";
import test from "node:test";
import { createSerialQueue } from "../lib/serial-queue.js";

test("concurrent API requests run sequentially and recover after an error", async () => {
  const enqueue = createSerialQueue();
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];
  const results = await Promise.allSettled([1, 2, 3].map((id) => enqueue(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active--;
    order.push(id);
    if (id === 2) throw new Error("request failed");
    return id;
  })));
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
});