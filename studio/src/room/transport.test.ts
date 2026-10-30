import { describe, expect, it, vi } from "vitest";
import { OfflineTransport } from "./transport";

describe("OfflineTransport", () => {
  it("records every publish in order", () => {
    const t = new OfflineTransport();
    t.publish("ROBOT_CTRL", '{"cmd":"stop"}');
    t.publish("ROBOT_CTRL", '{"cmd":"go"}');
    expect(t.published).toEqual([
      { topic: "ROBOT_CTRL", message: '{"cmd":"stop"}' },
      { topic: "ROBOT_CTRL", message: '{"cmd":"go"}' },
    ]);
  });

  it("emit reaches the subscribers of that topic only, with the sender", () => {
    const t = new OfflineTransport();
    const events = vi.fn();
    const other = vi.fn();
    t.subscribe("ROBOT_EVENTS", events);
    t.subscribe("ROBOT_CTRL", other);
    t.emit("ROBOT_EVENTS", "hello", "agent");
    expect(events).toHaveBeenCalledExactlyOnceWith("hello", "agent");
    expect(other).not.toHaveBeenCalled();
  });

  it("emit with no subscriber is harmless", () => {
    expect(() => new OfflineTransport().emit("NOBODY", "x", "y")).not.toThrow();
  });

  it("send only counts, and the rest are harmless no-ops", async () => {
    const t = new OfflineTransport();
    t.send({ kind: "data", reliable: true, bytes: new Uint8Array([1]) });
    t.send({ kind: "pubsub", topic: "teleop-v2-ctl", message: "{}", persist: false });
    expect(t.sent).toBe(2);
    expect(t.published).toEqual([]);
    t.attach({ postMessage: vi.fn() } as unknown as Worker);
    await expect(t.enableMic(true)).resolves.toBeUndefined();
    expect(t.left).toBe(false);
    await expect(t.leave()).resolves.toBeUndefined();
    expect(t.left).toBe(true);
  });
});
