import { vi } from "vitest";

// Production uses the Obsidian window timers; Node tests use the same fakeable clock.
vi.stubGlobal("window", globalThis);
