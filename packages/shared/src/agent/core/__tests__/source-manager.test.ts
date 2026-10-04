/**
 * Tests for SourceManager
 *
 * Tests the centralized source state management used by both
 * ClaudeAgent and PiAgent.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { SourceManager } from '../source-manager.ts';
import type { LoadedSource } from '../../../sources/types.ts';

// Helper to create mock LoadedSource objects
function createMockSource(
  slug: string,
  overrides: Partial<LoadedSource['config']> = {}
): LoadedSource {
  return {
    config: {
      id: `${slug}-id`,
      name: slug.charAt(0).toUpperCase() + slug.slice(1),
      slug,
      enabled: true,
      provider: 'test',
      type: 'mcp',
      tagline: `${slug} tagline`,
      ...overrides,
    },
    guide: null,
    folderPath: `/test/sources/${slug}`,
    workspaceRootPath: '/test/workspace',
    workspaceId: 'test-workspace',
  };
}

describe('SourceManager', () => {
  let sourceManager: SourceManager;
  let debugMessages: string[];

  beforeEach(() => {
    debugMessages = [];
    sourceManager = new SourceManager({
      onDebug: (msg) => debugMessages.push(msg),
    });
  });

  describe('State Management', () => {
    it('should start with no active sources', () => {
      expect(sourceManager.getActiveSlugs().size).toBe(0);
      expect(sourceManager.getIntendedSlugs().size).toBe(0);
    });

    it('should update active state from MCP and API servers', () => {
      sourceManager.updateActiveState(['github', 'slack'], ['gmail'], ['github', 'slack', 'gmail']);

      const activeSlugs = sourceManager.getActiveSlugs();
      expect(activeSlugs.has('github')).toBe(true);
      expect(activeSlugs.has('slack')).toBe(true);
      expect(activeSlugs.has('gmail')).toBe(true);
    });

    it('should track intended slugs separately from active slugs', () => {
      // Intended slugs include sources that UI shows as active, even if build failed
      sourceManager.updateActiveState(['github'], [], ['github', 'failing-source']);

      expect(sourceManager.isSourceActive('github')).toBe(true);
      expect(sourceManager.isSourceActive('failing-source')).toBe(false);

      expect(sourceManager.isSourceIntendedActive('github')).toBe(true);
      expect(sourceManager.isSourceIntendedActive('failing-source')).toBe(true);
    });

    it('should log debug messages about source state', () => {
      sourceManager.updateActiveState(['github'], [], ['github', 'failing-source']);

      expect(debugMessages.some(m => m.includes('Active sources'))).toBe(true);
      expect(debugMessages.some(m => m.includes('failed builds'))).toBe(true);
    });
  });

  describe('Source Collection Management', () => {
    it('should store and retrieve all sources', () => {
      const sources = [
        createMockSource('github'),
        createMockSource('slack'),
        createMockSource('gmail'),
      ];

      sourceManager.setAllSources(sources);

      const retrieved = sourceManager.getAllSources();
      expect(retrieved.length).toBe(3);
      expect(retrieved[0]?.config.slug).toBe('github');
    });
  });

  describe('Source Visibility Tracking', () => {
    it('should track which sources have been seen', () => {
      sourceManager.markSourceSeen('github');

      // This is internal state, verified through formatSourceState behavior
      // When sources are "seen", they won't show introduction text again
    });

    it('should mark sources as unseen', () => {
      sourceManager.markSourceSeen('github');
      sourceManager.markSourceUnseen('github');

      // Source will show introduction text again
    });

    it('should reset all seen sources', () => {
      sourceManager.markSourceSeen('github');
      sourceManager.markSourceSeen('slack');
      sourceManager.resetSeenSources();

      // All sources will show introduction text again
    });
  });

  describe('Source State Formatting', () => {
    beforeEach(() => {
      sourceManager.setAllSources([
        createMockSource('github', { enabled: true, tagline: 'GitHub integration' }),
        createMockSource('slack', { enabled: true, tagline: 'Slack messaging' }),
        createMockSource('disabled-source', { enabled: false, tagline: 'Disabled' }),
      ]);
    });

    it('should format source state with active and inactive sources', () => {
      sourceManager.updateActiveState(['github'], [], ['github']);

      const formatted = sourceManager.formatSourceState();

      expect(formatted).toContain('<sources>');
      expect(formatted).toContain('</sources>');
      expect(formatted).toContain('Active: github');
      expect(formatted).toContain('slack (inactive)');
    });

    it('should show "Active: none" when no sources are active', () => {
      sourceManager.updateActiveState([], [], []);

      const formatted = sourceManager.formatSourceState();

      expect(formatted).toContain('Active: none');
    });

    it('should include taglines for new sources', () => {
      sourceManager.updateActiveState(['github'], [], ['github']);

      const formatted = sourceManager.formatSourceState();

      // First call should include taglines for unseen sources
      expect(formatted).toContain('github');
      expect(formatted).toContain('GitHub integration');
    });

    it('should mark sources with failed builds', () => {
      // github is intended but not actually active (build failed)
      sourceManager.updateActiveState([], [], ['github']);

      const formatted = sourceManager.formatSourceState();

      expect(formatted).toContain('github (no tools)');
    });

    it('should expose local source paths instead of marking them as failed tools', () => {
      sourceManager.setAllSources([
        createMockSource('repo', {
          provider: 'filesystem',
          type: 'local',
          local: { path: '/projects/repo' },
          tagline: 'Local project repository',
        }),
      ]);
      sourceManager.updateActiveState([], [], ['repo']);

      const formatted = sourceManager.formatSourceState();

      expect(formatted).toContain('Active: repo (local: /projects/repo)');
      expect(formatted).toContain('Local source folders:');
      expect(formatted).toContain('- repo: /projects/repo (configured local folder; use filesystem tools for this source)');
      expect(formatted).toContain('Local path: /projects/repo');
      expect(formatted).not.toContain('repo (no tools)');
    });

    it('should keep local source paths in context after the source has been introduced', () => {
      sourceManager.setAllSources([
        createMockSource('repo', {
          provider: 'filesystem',
          type: 'local',
          local: { path: '/projects/repo' },
        }),
      ]);
      sourceManager.updateActiveState([], [], ['repo']);

      sourceManager.formatSourceState();
      const formatted = sourceManager.formatSourceState();

      expect(formatted).toContain('Active: repo (local: /projects/repo)');
      expect(formatted).toContain('- repo: /projects/repo (configured local folder; use filesystem tools for this source)');
      expect(formatted).not.toContain('Local path: /projects/repo');
    });
  });

  describe('Authentication Utilities', () => {
    it('should return correct auth tool for OAuth MCP sources', () => {
      const source = createMockSource('oauth-source', {
        type: 'mcp',
        mcp: { url: 'https://example.com/mcp', authType: 'oauth' },
      });

      const authTool = sourceManager.getAuthToolName(source);
      expect(authTool).toBe('source_oauth_trigger');
    });

    it('should return correct auth tool for bearer MCP sources', () => {
      const source = createMockSource('bearer-source', {
        type: 'mcp',
        mcp: { url: 'https://example.com/mcp', authType: 'bearer' },
      });

      const authTool = sourceManager.getAuthToolName(source);
      expect(authTool).toBe('source_credential_prompt');
    });

    it('should return correct auth tool for Google API sources', () => {
      const source = createMockSource('google-source', {
        type: 'api',
        provider: 'google',
        api: { baseUrl: 'https://www.googleapis.com', authType: 'oauth' },
      });

      const authTool = sourceManager.getAuthToolName(source);
      expect(authTool).toBe('source_google_oauth_trigger');
    });

    it('should return correct auth tool for Slack API sources', () => {
      const source = createMockSource('slack-source', {
        type: 'api',
        provider: 'slack',
        api: { baseUrl: 'https://slack.com/api', authType: 'oauth' },
      });

      const authTool = sourceManager.getAuthToolName(source);
      expect(authTool).toBe('source_slack_oauth_trigger');
    });

    it('should return null for sources without auth', () => {
      const source = createMockSource('no-auth-source', {
        type: 'mcp',
        mcp: { url: 'https://example.com/mcp', authType: 'none' },
      });

      const authTool = sourceManager.getAuthToolName(source);
      expect(authTool).toBeNull();
    });
  });
});
