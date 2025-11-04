import { describe, it, expect } from "vitest";
import { Storage } from "../src/storage";

describe("Storage eviction", () => {
  it("evicts oldest when capacity exceeded", () => {
    const s = new Storage(3);
    s.set("a", { channel: "c", ts: "1", thread_ts: "t1" });
    s.set("b", { channel: "c", ts: "2", thread_ts: "t2" });
    s.set("c", { channel: "c", ts: "3", thread_ts: "t3" });
    // Exceed capacity
    s.set("d", { channel: "c", ts: "4", thread_ts: "t4" });
    expect(s.get("a")).toBeUndefined();
    expect(s.get("b")).toBeDefined();
    expect(s.get("c")).toBeDefined();
    expect(s.get("d")).toBeDefined();
  });

  it("returns size equal to entries stored (<= max)", () => {
    const s = new Storage(2);
    s.set("x", { channel: "c", ts: "10", thread_ts: "t10" });
    s.set("y", { channel: "c", ts: "11", thread_ts: "t11" });
    s.set("z", { channel: "c", ts: "12", thread_ts: "t12" });
    expect(s.size()).toBe(2);
  });
});
