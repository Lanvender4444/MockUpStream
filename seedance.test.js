import { test, expect } from "bun:test";
import { SeedanceTaskStore, buildError, statusForPoll } from "./formats/seedance.js";

const config = {
  completionTokens: 108000,
  seedanceVideoUrl: "https://example.com/mock-video.mp4",
  seedanceLastFrameUrl: "https://example.com/mock-last-frame.png",
  seedanceFailureCode: "OutputVideoSensitiveContentDetected",
  seedanceFailureMessage: "blocked by mock moderation",
  seedanceFinalStatus: "succeeded",
  seedanceQueuedPolls: 1,
  seedanceRunningPolls: 2,
  seedanceSeed: 42,
  seedanceResolution: "1080p",
  seedanceDuration: 5,
  seedanceRatio: "16:9",
  seedanceFramesPerSecond: 24,
  seedanceServiceTier: "default",
  seedanceExecutionExpiresAfter: 172800,
};

test("Seedance submit returns only a non-empty id and preserves the model", () => {
  const tasks = new SeedanceTaskStore({ nowSec: () => 1734000000 });
  const request = {
    model: "doubao-seedance-1-0-pro-250528",
    content: [{ type: "text", text: "a mock video" }],
    resolution: "1080p",
    ratio: "16:9",
    duration: 5,
  };
  const response = tasks.create(request, config);
  expect(response).toEqual({ id: "cgt-mock-1" });
  expect(tasks.inspect(response.id).model).toBe("doubao-seedance-1-0-pro-250528");
});

test("Seedance poll progresses queued -> running -> succeeded", () => {
  let now = 1734000000;
  const tasks = new SeedanceTaskStore({ nowSec: () => now++ });
  const { id } = tasks.create({ model: "doubao-seedance-1-0-pro-250528" }, config);

  const queued = tasks.query(id);
  expect(queued.status).toBe("queued");
  expect(queued.content).toBeUndefined();
  expect(queued.usage).toBeUndefined();
  expect(tasks.query(id).status).toBe("running");
  expect(tasks.query(id).status).toBe("running");
  const done = tasks.query(id);

  expect(done.status).toBe("succeeded");
  expect(done.content.video_url).toBe("https://example.com/mock-video.mp4");
  expect(done.usage).toEqual({ completion_tokens: 108000, total_tokens: 108000 });
  expect(done.resolution).toBe("1080p");
  expect(done.duration).toBe(5);
  expect(done.ratio).toBe("16:9");
  expect(done.framespersecond).toBe(24);
  expect(done.seed).toBe(42);
  expect(done.service_tier).toBe("default");
  expect(done.execution_expires_after).toBe(172800);
  expect(done.created_at).toBe(1734000000);
});

test("Seedance failed task matches Ark's compact error response", () => {
  const tasks = new SeedanceTaskStore();
  const { id } = tasks.create(
    { model: "seedance-x" },
    { ...config, seedanceFinalStatus: "failed", seedanceQueuedPolls: 0, seedanceRunningPolls: 0 }
  );
  const failed = tasks.query(id);
  expect(failed).toMatchObject({
    id,
    model: "seedance-x",
    status: "failed",
    error: {
      code: "OutputVideoSensitiveContentDetected",
      message: "blocked by mock moderation",
    },
  });
  expect(failed.content).toBeUndefined();
  expect(failed.usage).toBeUndefined();
  expect(failed.resolution).toBeUndefined();
});

test("Seedance echoes resolved Ark task properties and optional last frame", () => {
  const tasks = new SeedanceTaskStore({ nowSec: () => 1734000000 });
  const { id } = tasks.create({
    model: "doubao-seedance-1-5-pro-251215",
    resolution: "720p",
    ratio: "9:16",
    frames: 121,
    seed: 1234,
    service_tier: "flex",
    execution_expires_after: 3600,
    return_last_frame: true,
    generate_audio: true,
    draft: false,
    safety_identifier: "user-hash",
    priority: 3,
    tools: [{ type: "web_search" }],
  }, { ...config, seedanceQueuedPolls: 0, seedanceRunningPolls: 0 });

  const done = tasks.query(id);
  expect(done).toMatchObject({
    status: "succeeded",
    content: {
      video_url: "https://example.com/mock-video.mp4",
      last_frame_url: "https://example.com/mock-last-frame.png",
    },
    seed: 1234,
    resolution: "720p",
    ratio: "9:16",
    frames: 121,
    framespersecond: 24,
    generate_audio: true,
    draft: false,
    safety_identifier: "user-hash",
    priority: 3,
    service_tier: "flex",
    execution_expires_after: 3600,
    tools: [{ type: "web_search" }],
    usage: {
      completion_tokens: 108000,
      total_tokens: 108000,
      tool_usage: { web_search: 1 },
    },
  });
  expect(done.duration).toBeUndefined();
});

test("Seedance unknown task id returns null", () => {
  expect(new SeedanceTaskStore().query("cgt-mock-missing")).toBeNull();
});

test("Seedance HTTP errors use Ark's four-field error object", () => {
  expect(buildError({ errorStatus: 429, errorMessage: "too many tasks" })).toEqual({
    error: {
      code: "QuotaExceeded",
      message: "too many tasks",
      param: "",
      type: "TooManyRequests",
    },
  });
});

test("statusForPoll clamps the configured state boundaries", () => {
  const cfg = { queuedPolls: 2, runningPolls: 1, finalStatus: "succeeded" };
  expect([1, 2, 3, 4].map((n) => statusForPoll(cfg, n))).toEqual([
    "queued", "queued", "running", "succeeded",
  ]);
});
