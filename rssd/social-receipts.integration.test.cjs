const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { getPublicKey, nip19, verifyEvent } = require('nostr-tools');
const { Relay } = require('nostr-tools/relay');

// No production token, database or external relay is used in this test.
delete process.env.REDIS_URL;
process.env.JWT_SECRET = 'local-social-receipts-test-only';
const base = '../apps/backend/dist/libraries';
const { AuthService } = require(`${base}/helpers/src/auth/auth.service.js`);
const {
  NostrProvider,
} = require(`${base}/nestjs-libraries/src/integrations/social/nostr.provider.js`);
const {
  TumblrProvider,
} = require(`${base}/nestjs-libraries/src/integrations/social/tumblr.provider.js`);
const {
  PostsService,
} = require(`${base}/nestjs-libraries/src/database/prisma/posts/posts.service.js`);

test('Nostr uses the signed event ID and never retries an unconfirmed publish', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const originalConnect = Relay.prototype.connect;
  const port = server.address().port;
  const seen = [];
  let accept = true;
  server.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message[0] !== 'EVENT') return;
      const event = message[1];
      seen.push(event);
      socket.send(
        JSON.stringify([
          'OK',
          event.id,
          accept,
          accept ? 'saved' : 'blocked: test',
        ])
      );
    })
  );
  Relay.prototype.connect = function (options) {
    this.url = `ws://127.0.0.1:${port}`;
    return originalConnect.call(this, options);
  };

  try {
    const secret = '11'.repeat(32);
    const key = Uint8Array.from(Buffer.from(secret, 'hex'));
    const token = AuthService.signJWT({ password: secret });
    const provider = new NostrProvider();
    const post = (message) => ({
      id: 'local-post',
      message,
      media: [],
      settings: {},
    });
    const result = await provider.post(getPublicKey(key), token, [
      post('local relay test'),
    ]);
    assert.equal(seen.length, 5);
    assert.ok(seen.every((event) => verifyEvent(event)));
    assert.ok(seen.every((event) => event.id === seen[0].id));
    assert.equal(result[0].postId, seen[0].id);
    assert.equal(
      nip19.decode(result[0].releaseURL.split('/').pop()).data,
      seen[0].id
    );

    seen.length = 0;
    accept = false;
    let failure;
    try {
      await provider.post(getPublicKey(key), token, [
        post('unconfirmed local test'),
      ]);
    } catch (err) {
      failure = err;
    }
    assert.equal(seen.length, 5);
    assert.equal(failure?.type, 'bad_body');
    assert.match(failure.message, new RegExp(seen[0].id));
    assert.match(
      failure.message,
      /may have been published; check the event before retrying/i
    );
  } finally {
    Relay.prototype.connect = originalConnect;
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('opening a legacy Tumblr receipt persists its corrected URL without changing its ID', async () => {
  const integration = {
    providerIdentifier: 'tumblr',
    internalId: 'example-blog',
    token: 'local-token',
  };
  const oldUrl =
    'https://www.tumblr.com/blog/view/example-blog/post/123456789012345678';
  const expectedUrl = 'https://www.tumblr.com/example-blog/123456789012345678';
  const post = {
    id: 'local-post',
    releaseId: '123456789012345678',
    releaseURL: oldUrl,
    settings: '{}',
    integration,
  };
  const saved = [];
  const service = Object.create(PostsService.prototype);
  service._integrationManager = {
    getSocialIntegration: () => new TumblrProvider(),
  };
  service._postRepository = {
    getPostById: async () => post,
    updateResolvedRelease: async (...args) => saved.push(args),
  };

  assert.deepEqual(await service.getReleaseURL('local-org', post.id), {
    releaseURL: expectedUrl,
    pending: false,
    unavailable: false,
  });
  assert.deepEqual(saved, [
    [post.id, 'local-org', post.releaseId, expectedUrl],
  ]);

  // Unrecognized/custom-domain receipts keep their original URL and ID.
  post.releaseURL = 'https://custom.example/post/123456789012345678';
  saved.length = 0;
  assert.equal(
    (await service.getReleaseURL('local-org', post.id)).releaseURL,
    post.releaseURL
  );
  assert.equal(saved.length, 0);
});
