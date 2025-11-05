import nock from 'nock';
import { Probot, ProbotOctokit } from 'probot';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, beforeEach, afterEach, test, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, 'fixtures/mock-cert.pem'), 'utf-8');

function makeProbot() {
  return new Probot({
    appId: 123,
    privateKey,
    Octokit: ProbotOctokit.defaults({ retry: { enabled: false }, throttle: { enabled: false } }),
  });
}

function prFixture(number: number, overrides: Partial<any> = {}) {
  return {
    number,
    title: overrides.title ?? `Recovery PR ${number}`,
    html_url: `https://github.com/owner/repo/pull/${number}`,
    state: overrides.state ?? 'open',
    merged: overrides.merged ?? false,
    user: { login: overrides.author ?? 'author' },
    requested_reviewers: overrides.requested_reviewers ?? [],
    head: { sha: overrides.sha ?? 'abcdef1234567890' },
    ...overrides,
  };
}

/**
 * These tests ensure that a restart (cache loss) followed by recovery reuses existing
 * Slack messages without creating duplicates, while still refreshing their content.
 */

describe('recovery idempotency', () => {
  beforeEach(() => {
    process.env.SLACK_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL = 'C123';
    process.env.SLACK_COMMENT_KEYWORDS = 'security';
    nock('https://slack.com').post('/api/conversations.info').reply(200, { ok: true });
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    delete process.env.SLACK_TOKEN;
    delete process.env.SLACK_CHANNEL;
    delete process.env.SLACK_COMMENT_KEYWORDS;
  });

  test('multiple recovery cycles reuse existing main + checks thread (no duplicate postMessage)', async () => {
    const prNumber = 201;
    // First app instance simulates restart scenario; history has existing main + checks thread
    const existingMainTs = '201.1';
    const existingThreadTs = '201.2';

    // GitHub auth + fetch
    nock('https://api.github.com').post('/app/installations/2/access_tokens').reply(200, { token: 'test1' });
    nock('https://api.github.com').get(`/repos/owner/repo/pulls/${prNumber}`).reply(200, prFixture(prNumber));
    nock('https://api.github.com').get(`/repos/owner/repo/pulls/${prNumber}/reviews`).query(true).reply(200, []);
    nock('https://api.github.com').get('/repos/owner/repo/commits/abcdef1234567890/check-runs').query(true).reply(200, { check_runs: [] });

    // Slack history returns existing main message
    nock('https://slack.com')
      .post('/api/conversations.history')
      .reply(200, { ok: true, messages: [ { ts: existingMainTs, text: `Recovered https://github.com/owner/repo/pull/${prNumber}?frombot=pr-message-bot` } ], has_more: false });

    // Thread replies include existing checks thread with "No checks reported." (empty checks)
    nock('https://slack.com')
      .post('/api/conversations.replies')
      .reply(200, { ok: true, messages: [ { ts: existingMainTs, text: 'Parent' }, { ts: existingThreadTs, text: 'No checks reported.' } ] });

    // Expect main + thread update, not postMessage
    const mainUpdate1 = nock('https://slack.com').post('/api/chat.update', (b:any)=> b.ts === existingMainTs).reply(200, { ok: true, ts: existingMainTs });
    const threadUpdate1 = nock('https://slack.com').post('/api/chat.update', (b:any)=> b.ts === existingThreadTs).reply(200, { ok: true, ts: existingThreadTs });

    const probot1 = makeProbot();
    const appModule = await import('../src/index.ts');
    probot1.load(appModule.default);

    await probot1.receive({ name: 'pull_request', id: 'evt-open-201', payload: { action: 'opened', number: prNumber, pull_request: prFixture(prNumber), repository: { name: 'repo', owner: { login: 'owner' } } } as any });

    expect(mainUpdate1.isDone()).toBe(true);
    expect(threadUpdate1.isDone()).toBe(true);
    // Ensure no postMessage took place
    expect(nock.pendingMocks().filter(m => m.includes('chat.postMessage')).length).toBe(0);

    // Simulate second restart: new app instance, same messages again
  // Clear in-memory storage to emulate process restart (loss of cache)
  (appModule as any).__resetTestState?.();
    const probot2 = makeProbot();
    nock('https://slack.com').post('/api/conversations.info').reply(200, { ok: true });

    // GitHub auth + fetch again
    nock('https://api.github.com').post('/app/installations/2/access_tokens').reply(200, { token: 'test2' });
    nock('https://api.github.com').get(`/repos/owner/repo/pulls/${prNumber}`).reply(200, prFixture(prNumber));
    nock('https://api.github.com').get(`/repos/owner/repo/pulls/${prNumber}/reviews`).query(true).reply(200, []);
    nock('https://api.github.com').get('/repos/owner/repo/commits/abcdef1234567890/check-runs').query(true).reply(200, { check_runs: [] });

    // Same history again
    nock('https://slack.com')
      .post('/api/conversations.history')
      .reply(200, { ok: true, messages: [ { ts: existingMainTs, text: `Recovered https://github.com/owner/repo/pull/${prNumber}?frombot=pr-message-bot` } ], has_more: false });
    nock('https://slack.com')
      .post('/api/conversations.replies')
      .reply(200, { ok: true, messages: [ { ts: existingMainTs, text: 'Parent' }, { ts: existingThreadTs, text: 'No checks reported.' } ] });

    // Expect second round of updates (currency refresh) but still no postMessage
    const mainUpdate2 = nock('https://slack.com').post('/api/chat.update', (b:any)=> b.ts === existingMainTs).reply(200, { ok: true, ts: existingMainTs });
    const threadUpdate2 = nock('https://slack.com').post('/api/chat.update', (b:any)=> b.ts === existingThreadTs).reply(200, { ok: true, ts: existingThreadTs });

    probot2.load(appModule.default);
    await probot2.receive({ name: 'pull_request', id: 'evt-open-201-r2', payload: { action: 'opened', number: prNumber, pull_request: prFixture(prNumber), repository: { name: 'repo', owner: { login: 'owner' } } } as any });

    expect(mainUpdate2.isDone()).toBe(true);
    expect(threadUpdate2.isDone()).toBe(true);
    expect(nock.pendingMocks().filter(m => m.includes('chat.postMessage')).length).toBe(0);
  });

  test('keyword comment recovery reuses existing keyword reply after restart', async () => {
    const prNumber = 202;
    const commentId = 9001;
    const existingMainTs = '202.1';
    const existingThreadTs = '202.2';
    const existingKeywordTs = '202.3';

    // First app instance
    nock('https://api.github.com').post('/app/installations/2/access_tokens').reply(200, { token: 'testk1' });
    nock('https://api.github.com').get(`/repos/owner/repo/pulls/${prNumber}`).reply(200, prFixture(prNumber));
    nock('https://api.github.com').get(`/repos/owner/repo/pulls/${prNumber}/reviews`).query(true).reply(200, []);
    nock('https://api.github.com').get('/repos/owner/repo/commits/abcdef1234567890/check-runs').query(true).reply(200, { check_runs: [] });

    // History for recovery
    nock('https://slack.com')
      .post('/api/conversations.history')
      .reply(200, { ok: true, messages: [ { ts: existingMainTs, text: `Recovered https://github.com/owner/repo/pull/${prNumber}?frombot=pr-message-bot` } ], has_more: false });
    nock('https://slack.com')
      .post('/api/conversations.replies')
      .reply(200, { ok: true, messages: [
        { ts: existingMainTs, text: 'Parent' },
        { ts: existingThreadTs, text: 'No checks reported.' },
        { ts: existingKeywordTs, text: `Comment by @bob – https://github.com/owner/repo/pull/${prNumber}#issuecomment-${commentId}\nOriginal body` }
      ] });

    // Expect main & thread refresh + keyword update
    const mainUpdate1 = nock('https://slack.com').post('/api/chat.update', (b:any)=> b.ts === existingMainTs).reply(200, { ok: true, ts: existingMainTs });
    const threadUpdate1 = nock('https://slack.com').post('/api/chat.update', (b:any)=> b.ts === existingThreadTs).reply(200, { ok: true, ts: existingThreadTs });
    const keywordUpdate1 = nock('https://slack.com').post('/api/chat.update', (b:any)=> b.ts === existingKeywordTs).reply(200, { ok: true, ts: existingKeywordTs });

    const probot1 = makeProbot();
    const appModule = await import('../src/index.ts');
    probot1.load(appModule.default);

    await probot1.receive({ name: 'pull_request', id: 'evt-open-202', payload: { action: 'opened', number: prNumber, pull_request: prFixture(prNumber), repository: { name: 'repo', owner: { login: 'owner' } } } as any });

    // Second replies fetch for keyword comment recovery scan
    nock('https://slack.com')
      .post('/api/conversations.replies')
      .reply(200, { ok: true, messages: [
        { ts: existingMainTs, text: 'Parent' },
        { ts: existingThreadTs, text: 'No checks reported.' },
        { ts: existingKeywordTs, text: `Comment by @bob – https://github.com/owner/repo/pull/${prNumber}#issuecomment-${commentId}\nOriginal body` }
      ] });

    // Trigger keyword comment event after recovery
    await probot1.receive({ name: 'issue_comment', id: 'evt-comment-202', payload: { action: 'created', issue: { number: prNumber, pull_request: { url: `https://api.github.com/repos/owner/repo/pulls/${prNumber}` } }, comment: { id: commentId, body: 'Security follow-up', user: { login: 'bob' } }, repository: { name: 'repo', owner: { login: 'owner' } } } as any });

    expect(mainUpdate1.isDone()).toBe(true);
    expect(threadUpdate1.isDone()).toBe(true);
    expect(keywordUpdate1.isDone()).toBe(true);
    expect(nock.pendingMocks().filter(m => m.includes('chat.postMessage')).length).toBe(0);

    // Second restart (new instance)
  (appModule as any).__resetTestState?.();
    const probot2 = makeProbot();
    nock('https://slack.com').post('/api/conversations.info').reply(200, { ok: true });
    nock('https://api.github.com').post('/app/installations/2/access_tokens').reply(200, { token: 'testk2' });
    nock('https://api.github.com').get(`/repos/owner/repo/pulls/${prNumber}`).reply(200, prFixture(prNumber));
    nock('https://api.github.com').get(`/repos/owner/repo/pulls/${prNumber}/reviews`).query(true).reply(200, []);
    nock('https://api.github.com').get('/repos/owner/repo/commits/abcdef1234567890/check-runs').query(true).reply(200, { check_runs: [] });

    nock('https://slack.com')
      .post('/api/conversations.history')
      .reply(200, { ok: true, messages: [ { ts: existingMainTs, text: `Recovered https://github.com/owner/repo/pull/${prNumber}?frombot=pr-message-bot` } ], has_more: false });
    nock('https://slack.com')
      .post('/api/conversations.replies')
      .reply(200, { ok: true, messages: [
        { ts: existingMainTs, text: 'Parent' },
        { ts: existingThreadTs, text: 'No checks reported.' },
        { ts: existingKeywordTs, text: `Comment by @bob – https://github.com/owner/repo/pull/${prNumber}#issuecomment-${commentId}\nSecurity follow-up` }
      ] });

    // Replies fetch for keyword comment event after restart
    nock('https://slack.com')
      .post('/api/conversations.replies')
      .reply(200, { ok: true, messages: [
        { ts: existingMainTs, text: 'Parent' },
        { ts: existingThreadTs, text: 'No checks reported.' },
        { ts: existingKeywordTs, text: `Comment by @bob – https://github.com/owner/repo/pull/${prNumber}#issuecomment-${commentId}\nSecurity follow-up` }
      ] });

    const mainUpdate2 = nock('https://slack.com').post('/api/chat.update', (b:any)=> b.ts === existingMainTs).reply(200, { ok: true, ts: existingMainTs });
    const threadUpdate2 = nock('https://slack.com').post('/api/chat.update', (b:any)=> b.ts === existingThreadTs).reply(200, { ok: true, ts: existingThreadTs });
    const keywordUpdate2 = nock('https://slack.com').post('/api/chat.update', (b:any)=> b.ts === existingKeywordTs).reply(200, { ok: true, ts: existingKeywordTs });

    probot2.load(appModule.default);
    await probot2.receive({ name: 'pull_request', id: 'evt-open-202-r2', payload: { action: 'opened', number: prNumber, pull_request: prFixture(prNumber), repository: { name: 'repo', owner: { login: 'owner' } } } as any });
    await probot2.receive({ name: 'issue_comment', id: 'evt-comment-202-r2', payload: { action: 'created', issue: { number: prNumber, pull_request: { url: `https://api.github.com/repos/owner/repo/pulls/${prNumber}` } }, comment: { id: commentId, body: 'Security follow-up', user: { login: 'bob' } }, repository: { name: 'repo', owner: { login: 'owner' } } } as any });

    expect(mainUpdate2.isDone()).toBe(true);
    expect(threadUpdate2.isDone()).toBe(true);
    expect(keywordUpdate2.isDone()).toBe(true);
    expect(nock.pendingMocks().filter(m => m.includes('chat.postMessage')).length).toBe(0);
  });
});
