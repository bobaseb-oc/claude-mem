import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { provisionTreeSitterCliForPluginRoot } from '../../src/services/worker/tree-sitter-cli-provisioning.js';
import { treeSitterCliBinaryPath } from '../../src/services/smart-file-read/tree-sitter-cli-provision.js';

// Fork hardening H3 (tasks/security-review.md): an executable already in
// node_modules/tree-sitter-cli (an install script's, or anything else's) is
// run only once its SHA-256 matches a pinned value. Otherwise the verified
// download replaces it, and it never runs.
describe.skipIf(process.platform === 'win32')('tree-sitter CLI: an unverified executable is never run (H3)', () => {
  const REPO_TREE_SITTER_BINARY = join(import.meta.dir, '..', '..', 'node_modules', 'tree-sitter-cli', 'tree-sitter');
  const pinRepoBinary = () => createHash('sha256').update(readFileSync(REPO_TREE_SITTER_BINARY)).digest('hex');
  let pluginRoot: string;
  let marker: string;

  beforeEach(() => {
    pluginRoot = mkdtempSync(join(tmpdir(), 'worker-tree-sitter-h3-'));
    marker = join(pluginRoot, 'UNVERIFIED_BINARY_RAN');
  });

  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
  });

  function writePackageWithPlantedBinary(): string {
    const cliDir = join(pluginRoot, 'node_modules', 'tree-sitter-cli');
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, 'package.json'), JSON.stringify({ name: 'tree-sitter-cli', version: '0.26.9' }));
    writeFileSync(join(cliDir, 'install.js'), [
      `const fs = require('fs');`,
      `const target = require('path').join(process.cwd(), 'tree-sitter');`,
      `fs.copyFileSync(${JSON.stringify(REPO_TREE_SITTER_BINARY)}, target);`,
      `fs.chmodSync(target, 0o755);`,
    ].join('\n'));
    // Answers --version like the real one, and leaves a trace if it runs.
    const planted = treeSitterCliBinaryPath(pluginRoot);
    writeFileSync(planted, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho "tree-sitter 0.26.9"\n`);
    chmodSync(planted, 0o755);
    return planted;
  }

  it('replaces a planted executable with the verified download without running it', async () => {
    const planted = writePackageWithPlantedBinary();

    expect(await provisionTreeSitterCliForPluginRoot(pluginRoot, pinRepoBinary)).toBe('provisioned');
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(planted).equals(readFileSync(REPO_TREE_SITTER_BINARY))).toBe(true);
  });

  it('does not run a planted executable when no SHA-256 is pinned for the version', async () => {
    writePackageWithPlantedBinary();

    await expect(provisionTreeSitterCliForPluginRoot(pluginRoot, () => undefined)).rejects.toThrow('No SHA-256 is pinned');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('Setup hook dependency install (H3)', () => {
  it('installs from the lockfile with lifecycle scripts off', () => {
    const source = readFileSync(join(import.meta.dir, '..', '..', 'plugin', 'scripts', 'version-check.js'), 'utf-8');
    const args = source.match(/const BUN_INSTALL_ARGS = Object\.freeze\((\[[^\]]*\])\)/)?.[1];
    expect(args).toBeDefined();
    const parsed = JSON.parse(args!.replace(/'/g, '"'));
    expect(parsed).toContain('--frozen-lockfile');
    expect(parsed).toContain('--ignore-scripts');
  });
});
