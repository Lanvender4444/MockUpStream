// Volcengine Ark / Doubao Seedance asynchronous video task protocol.
// A task snapshots both the submitted Ark payload and the selected mock configuration.

const DEFAULT_MODEL = "doubao-seedance-1-0-pro-250528";
const FINAL_STATUSES = new Set(["succeeded", "failed"]);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const integer = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

const nonNegativeInt = (value, fallback = 0) => Math.max(0, integer(value, fallback));

function snapshotConfig(body = {}, cfg = {}) {
  const finalStatus = FINAL_STATUSES.has(cfg.seedanceFinalStatus)
    ? cfg.seedanceFinalStatus
    : "succeeded";
  const requestedSeed = integer(body.seed, -1);
  const frames = hasOwn(body, "frames") ? nonNegativeInt(body.frames) : null;
  const tools = Array.isArray(body.tools)
    ? body.tools.filter((tool) => tool && typeof tool === "object").map((tool) => ({ ...tool }))
    : [];

  return {
    completionTokens: nonNegativeInt(cfg.completionTokens, 108000),
    videoUrl: String(cfg.seedanceVideoUrl || "https://example.com/mock-video.mp4"),
    lastFrameUrl: String(cfg.seedanceLastFrameUrl || "https://example.com/mock-last-frame.png"),
    failureCode: String(cfg.seedanceFailureCode || "OutputVideoSensitiveContentDetected"),
    failureMessage: String(cfg.seedanceFailureMessage || "The request failed because the output video may contain sensitive information."),
    finalStatus,
    queuedPolls: nonNegativeInt(cfg.seedanceQueuedPolls),
    runningPolls: nonNegativeInt(cfg.seedanceRunningPolls),
    seed: requestedSeed >= 0 ? requestedSeed : nonNegativeInt(cfg.seedanceSeed, 42),
    resolution: String(body.resolution || cfg.seedanceResolution || "1080p"),
    duration: frames === null ? nonNegativeInt(body.duration, nonNegativeInt(cfg.seedanceDuration, 5)) : null,
    frames,
    ratio: String(body.ratio || cfg.seedanceRatio || "16:9"),
    framesPerSecond: nonNegativeInt(cfg.seedanceFramesPerSecond, 24),
    serviceTier: String(body.service_tier || cfg.seedanceServiceTier || "default"),
    executionExpiresAfter: nonNegativeInt(
      body.execution_expires_after,
      nonNegativeInt(cfg.seedanceExecutionExpiresAfter, 172800),
    ),
    returnLastFrame: body.return_last_frame === true,
    generateAudio: hasOwn(body, "generate_audio") ? Boolean(body.generate_audio) : null,
    draft: hasOwn(body, "draft") ? Boolean(body.draft) : null,
    safetyIdentifier: hasOwn(body, "safety_identifier") ? String(body.safety_identifier) : "",
    priority: hasOwn(body, "priority") ? integer(body.priority) : null,
    tools,
  };
}

export function statusForPoll(cfg, pollCount) {
  if (pollCount <= cfg.queuedPolls) return "queued";
  if (pollCount <= cfg.queuedPolls + cfg.runningPolls) return "running";
  return cfg.finalStatus;
}

function taskProperties(cfg) {
  const properties = {
    seed: cfg.seed,
    resolution: cfg.resolution,
    ratio: cfg.ratio,
    framespersecond: cfg.framesPerSecond,
    service_tier: cfg.serviceTier,
    execution_expires_after: cfg.executionExpiresAfter,
  };
  if (cfg.frames !== null) properties.frames = cfg.frames;
  else properties.duration = cfg.duration;
  if (cfg.generateAudio !== null) properties.generate_audio = cfg.generateAudio;
  if (cfg.draft !== null) properties.draft = cfg.draft;
  if (cfg.safetyIdentifier) properties.safety_identifier = cfg.safetyIdentifier;
  if (cfg.priority !== null) properties.priority = cfg.priority;
  if (cfg.tools.length) properties.tools = cfg.tools;
  return properties;
}

export class SeedanceTaskStore {
  constructor({ nowSec = () => Math.floor(Date.now() / 1000) } = {}) {
    this.nowSec = nowSec;
    this.sequence = 0;
    this.tasks = new Map();
  }

  create(body = {}, cfg = {}) {
    const id = `cgt-mock-${++this.sequence}`;
    const createdAt = this.nowSec();
    this.tasks.set(id, {
      id,
      model: String(body.model || DEFAULT_MODEL),
      cfg: snapshotConfig(body, cfg),
      pollCount: 0,
      createdAt,
      updatedAt: createdAt,
      lastStatus: "queued",
    });
    // Ark's create endpoint returns exactly the task id.
    return { id };
  }

  query(id) {
    const task = this.tasks.get(id);
    if (!task) return null;
    task.pollCount += 1;
    const status = statusForPoll(task.cfg, task.pollCount);
    if (status !== task.lastStatus) {
      task.lastStatus = status;
      task.updatedAt = this.nowSec();
    }

    const response = {
      id: task.id,
      model: task.model,
      status,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
    };

    // Ark returns a compact error object for failed tasks and omits result/usage fields.
    if (status === "failed") {
      response.error = {
        code: task.cfg.failureCode,
        message: task.cfg.failureMessage,
      };
      return response;
    }

    Object.assign(response, taskProperties(task.cfg));
    if (status !== "succeeded") return response;

    response.content = { video_url: task.cfg.videoUrl };
    if (task.cfg.returnLastFrame) response.content.last_frame_url = task.cfg.lastFrameUrl;
    response.usage = {
      completion_tokens: task.cfg.completionTokens,
      total_tokens: task.cfg.completionTokens,
    };
    if (task.cfg.tools.some((tool) => tool.type === "web_search")) {
      response.usage.tool_usage = { web_search: 1 };
    }
    return response;
  }

  inspect(id) {
    const task = this.tasks.get(id);
    return task ? { id: task.id, model: task.model, pollCount: task.pollCount } : null;
  }

  clear() {
    this.sequence = 0;
    this.tasks.clear();
  }
}

function arkErrorCode(status) {
  if (status === 400) return "InvalidParameter";
  if (status === 401) return "AuthenticationError";
  if (status === 403) return "PermissionDenied";
  if (status === 404) return "NotFound";
  if (status === 429) return "QuotaExceeded";
  return "InternalServiceError";
}

function arkErrorType(status) {
  if (status === 400) return "BadRequest";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "NotFound";
  if (status === 429) return "TooManyRequests";
  return "InternalServerError";
}

export function buildError(cfg = {}) {
  const status = Number(cfg.errorStatus) || 500;
  return {
    error: {
      code: String(cfg.errorCode || arkErrorCode(status)),
      message: cfg.errorMessage || "mock injected error",
      param: String(cfg.errorParam || ""),
      type: String(cfg.errorType || arkErrorType(status)),
    },
  };
}
