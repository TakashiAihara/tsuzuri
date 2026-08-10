import { describe, expect, test } from "bun:test";

import { decideEmbeddingState, describeMismatch } from "./embedding-state.ts";

const configured = { provider: "openai-compatible", model: "bge-m3" };
const stored = { provider: "openai-compatible", model: "bge-m3", dimensions: 1024 };

describe("decideEmbeddingState", () => {
  test("no configured model is disabled, which is the default and not an error", () => {
    expect(decideEmbeddingState(null, null)).toEqual({ status: "disabled" });
  });

  test("stays disabled even when vectors are already stored", () => {
    // Turning the provider off should stop producing and querying vectors, not
    // report a problem about the ones already on disk.
    expect(decideEmbeddingState(null, stored)).toEqual({ status: "disabled" });
  });

  test("configured with nothing stored means first enablement", () => {
    expect(decideEmbeddingState(configured, null)).toEqual({
      status: "uninitialised",
      configured,
    });
  });

  test("matching provider and model is ready, carrying the stored dimension", () => {
    expect(decideEmbeddingState(configured, stored)).toEqual({
      status: "ready",
      configured,
      dimensions: 1024,
    });
  });

  test("a different model is a mismatch", () => {
    const other = { ...stored, model: "e5-large" };
    expect(decideEmbeddingState(configured, other)).toEqual({
      status: "mismatch",
      configured,
      stored: other,
    });
  });

  test("a different provider is a mismatch even at the same model name", () => {
    const other = { ...stored, provider: "cohere" };
    expect(decideEmbeddingState(configured, other).status).toBe("mismatch");
  });

  test("the stored dimension is authoritative, not configuration", () => {
    // What the model actually produced when probed is a fact; a number in the
    // environment is an opinion, and it does not get to override the column.
    const narrower = { ...stored, dimensions: 512 };
    expect(decideEmbeddingState(configured, narrower)).toEqual({
      status: "ready",
      configured,
      dimensions: 512,
    });
  });
});

describe("describeMismatch", () => {
  test("names both models and the command that resolves it", () => {
    const state = decideEmbeddingState(configured, { ...stored, model: "e5-large" });
    if (state.status !== "mismatch") throw new Error("expected a mismatch");
    const message = describeMismatch(state);
    expect(message).toContain("e5-large");
    expect(message).toContain("bge-m3");
    expect(message).toContain("tsuzuri reindex --embedding-model bge-m3");
  });
});
