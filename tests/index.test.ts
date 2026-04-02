import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index.js';

describe('isotopes', () => {
  it('should export VERSION', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
