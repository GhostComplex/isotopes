// src/daemon/log-rotation.test.ts — Unit tests for LogRotator

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import fss from "node:fs";
import { pipeline } from "node:stream/promises";
import { LogRotator } from "./log-rotation.js";
import type { LogRotationConfig } from "./log-rotation.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  default: {
    stat: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
    writeFile: vi.fn(),
    access: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({
  default: {
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
  },
}));

vi.mock("node:stream/promises", () => ({
  pipeline: vi.fn(),
}));

vi.mock("node:zlib", () => ({
  createGzip: vi.fn(() => ({ _gzip: true })),
}));

const mockFs = fs as unknown as {
  stat: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  access: ReturnType<typeof vi.fn>;
};

const mockFss = fss as unknown as {
  createReadStream: ReturnType<typeof vi.fn>;
  createWriteStream: ReturnType<typeof vi.fn>;
};

const mockPipeline = pipeline as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOG_PATH = "/var/log/isotopes/isotopes.out.log";

const defaultConfig: LogRotationConfig = {
  maxSize: 10 * 1024 * 1024, // 10 MB
  maxFiles: 5,
  compress: true,
};

function makeRotator(
  config?: Partial<LogRotationConfig>,
  logPath?: string,
): LogRotator {
  return new LogRotator(logPath ?? LOG_PATH, { ...defaultConfig, ...config });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.rename.mockResolvedValue(undefined);
  mockFs.unlink.mockResolvedValue(undefined);
  mockFs.writeFile.mockResolvedValue(undefined);
  mockPipeline.mockResolvedValue(undefined);
  mockFss.createReadStream.mockReturnValue({ _readStream: true });
  mockFss.createWriteStream.mockReturnValue({ _writeStream: true });
});

// ---------------------------------------------------------------------------
// shouldRotate
// ---------------------------------------------------------------------------

describe("LogRotator.shouldRotate", () => {
  it("returns true when file exceeds maxSize", async () => {
    mockFs.stat.mockResolvedValue({ size: 15 * 1024 * 1024 }); // 15 MB
    const r = makeRotator();
    expect(await r.shouldRotate()).toBe(true);
  });

  it("returns true when file equals maxSize", async () => {
    mockFs.stat.mockResolvedValue({ size: 10 * 1024 * 1024 }); // exactly 10 MB
    const r = makeRotator();
    expect(await r.shouldRotate()).toBe(true);
  });

  it("returns false when file is under maxSize", async () => {
    mockFs.stat.mockResolvedValue({ size: 5 * 1024 * 1024 }); // 5 MB
    const r = makeRotator();
    expect(await r.shouldRotate()).toBe(false);
  });

  it("returns false when file does not exist", async () => {
    mockFs.stat.mockRejectedValue(new Error("ENOENT"));
    const r = makeRotator();
    expect(await r.shouldRotate()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rotate (with compression)
// ---------------------------------------------------------------------------

describe("LogRotator.rotate (compress=true)", () => {
  beforeEach(() => {
    // File is over limit
    mockFs.stat.mockResolvedValue({ size: 20 * 1024 * 1024 });
  });

  it("shifts existing files up by one index", async () => {
    const r = makeRotator({ maxFiles: 3 });
    await r.rotate();

    // Oldest file (index 3) should be deleted
    expect(mockFs.unlink).toHaveBeenCalledWith(`${LOG_PATH}.3.gz`);

    // index 2 → index 3
    expect(mockFs.rename).toHaveBeenCalledWith(
      `${LOG_PATH}.2.gz`,
      `${LOG_PATH}.3.gz`,
    );

    // index 1 → index 2
    expect(mockFs.rename).toHaveBeenCalledWith(
      `${LOG_PATH}.1.gz`,
      `${LOG_PATH}.2.gz`,
    );
  });

  it("compresses current log to .1.gz", async () => {
    const r = makeRotator({ maxFiles: 3 });
    await r.rotate();

    // Should call pipeline to gzip current log → .1.gz
    expect(mockPipeline).toHaveBeenCalled();
    expect(mockFss.createReadStream).toHaveBeenCalledWith(LOG_PATH);
    expect(mockFss.createWriteStream).toHaveBeenCalledWith(`${LOG_PATH}.1.gz`);

    // Original file removed after compression
    expect(mockFs.unlink).toHaveBeenCalledWith(LOG_PATH);
  });

  it("creates a fresh empty log file", async () => {
    const r = makeRotator();
    await r.rotate();

    expect(mockFs.writeFile).toHaveBeenCalledWith(LOG_PATH, "", "utf-8");
  });

  it("does nothing when file is under maxSize", async () => {
    mockFs.stat.mockResolvedValue({ size: 1024 }); // 1 KB

    const r = makeRotator();
    await r.rotate();

    expect(mockFs.rename).not.toHaveBeenCalled();
    expect(mockPipeline).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// rotate (without compression)
// ---------------------------------------------------------------------------

describe("LogRotator.rotate (compress=false)", () => {
  beforeEach(() => {
    mockFs.stat.mockResolvedValue({ size: 20 * 1024 * 1024 });
  });

  it("renames current log to .1 (no gzip)", async () => {
    const r = makeRotator({ compress: false, maxFiles: 3 });
    await r.rotate();

    // Current log → .1 (plain rename, no pipeline)
    expect(mockFs.rename).toHaveBeenCalledWith(LOG_PATH, `${LOG_PATH}.1`);
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it("shifts files with no extension", async () => {
    const r = makeRotator({ compress: false, maxFiles: 3 });
    await r.rotate();

    expect(mockFs.unlink).toHaveBeenCalledWith(`${LOG_PATH}.3`);
    expect(mockFs.rename).toHaveBeenCalledWith(
      `${LOG_PATH}.2`,
      `${LOG_PATH}.3`,
    );
  });
});

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

describe("LogRotator.cleanup", () => {
  it("deletes files beyond maxFiles", async () => {
    // Files at indices 6, 7 exist; 8 does not
    mockFs.access.mockImplementation(async (p: string) => {
      if (p.endsWith(".6.gz") || p.endsWith(".7.gz")) return undefined;
      throw new Error("ENOENT");
    });

    const r = makeRotator({ maxFiles: 5 });
    await r.cleanup();

    expect(mockFs.unlink).toHaveBeenCalledWith(`${LOG_PATH}.6.gz`);
    expect(mockFs.unlink).toHaveBeenCalledWith(`${LOG_PATH}.7.gz`);
  });

  it("does nothing when no excess files exist", async () => {
    mockFs.access.mockRejectedValue(new Error("ENOENT"));

    const r = makeRotator({ maxFiles: 5 });
    await r.cleanup();

    expect(mockFs.unlink).not.toHaveBeenCalled();
  });
});
