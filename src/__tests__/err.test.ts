import { describe, it, expect } from "vitest";
import { Err } from "../types";

describe("Err", () => {
  it("stores message", () => {
    const e = new Err("oops");
    expect(e.message).toBe("oops");
  });

  it("is instanceof Error", () => {
    expect(new Err("x")).toBeInstanceOf(Error);
  });

  it("addCause with an Error", () => {
    const cause = new Error("root");
    const e = new Err("outer").addCause(cause);
    expect(e.cause).toBe(cause);
  });

  it("addCause with a string wraps it in Err", () => {
    const e = new Err("outer").addCause("string cause");
    expect(e.cause).toBeInstanceOf(Err);
    expect((e.cause as Err).message).toBe("string cause");
  });

  it("withMetadata stores meta and returns self", () => {
    const e = new Err("x").withMetadata({ code: 404 });
    expect(e.meta).toEqual({ code: 404 });
  });

  it("toString includes message", () => {
    expect(new Err("boom").toString()).toContain("boom");
  });

  it("toString includes cause", () => {
    const e = new Err("outer").addCause(new Error("inner cause"));
    expect(e.toString()).toContain("inner cause");
  });

  it("toString includes metadata as JSON", () => {
    const e = new Err("x").withMetadata({ key: "val" });
    const s = e.toString();
    expect(s).toContain('"key"');
    expect(s).toContain('"val"');
  });

  it("chaining addCause and withMetadata returns the same instance", () => {
    const e = new Err("x");
    expect(e.addCause("c")).toBe(e);
    expect(e.withMetadata({})).toBe(e);
  });
});
