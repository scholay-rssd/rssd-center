jest.mock('@gitroom/nestjs-libraries/integrations/social.abstract', () => ({
  SocialAbstract: class {},
  BadBody: class extends Error {
    type = 'bad_body';
    constructor(
      _provider: string,
      _json: string,
      _body: string,
      message: string
    ) {
      super(message);
    }
  },
}));
jest.mock('@gitroom/helpers/auth/auth.service', () => ({
  AuthService: { verifyJWT: jest.fn(() => ({ password: '01'.repeat(32) })) },
}));
jest.mock('nostr-tools', () => ({
  SimplePool: jest.fn(),
  finalizeEvent: jest.fn(),
  getPublicKey: jest.fn(),
  nip19: { noteEncode: jest.fn(() => 'note1encoded') },
}));
jest.mock('nostr-tools/relay', () => ({
  Relay: jest.fn(),
  useWebSocketImplementation: jest.fn(),
}));

import { finalizeEvent, nip19 } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';
import { NostrProvider } from '../libraries/nestjs-libraries/src/integrations/social/nostr.provider';
import { TumblrProvider } from '../libraries/nestjs-libraries/src/integrations/social/tumblr.provider';

const eventId = 'ab'.repeat(32);
const note = {
  id: 'post-1',
  message: 'A post with https://example.org',
  media: [],
  settings: {},
} as any;

describe('Nostr publishing receipts', () => {
  let relays: Array<{
    connect: jest.Mock;
    publish: jest.Mock;
    close: jest.Mock;
  }>;

  beforeEach(() => {
    relays = [];
    (Relay as unknown as jest.Mock).mockReset().mockImplementation(() => {
      const relay = {
        connect: jest.fn().mockResolvedValue(undefined),
        publish: jest
          .fn()
          .mockRejectedValue(new Error('relay did not confirm')),
        close: jest.fn(),
      };
      relays.push(relay);
      return relay;
    });
    (finalizeEvent as jest.Mock)
      .mockReset()
      .mockImplementation((event) => ({ ...event, id: eventId }));
    (nip19.noteEncode as jest.Mock).mockClear();
  });

  it('uses the signed event ID after a relay confirms that event', async () => {
    (Relay as unknown as jest.Mock).mockImplementationOnce(() => {
      const relay = {
        connect: jest.fn().mockResolvedValue(undefined),
        publish: jest.fn().mockResolvedValue('accepted'),
        close: jest.fn(),
      };
      relays.push(relay);
      return relay;
    });

    const result = await new NostrProvider().post('pubkey', 'token', [note]);
    expect(result).toEqual([
      {
        id: 'post-1',
        postId: eventId,
        releaseURL: 'https://primal.net/e/note1encoded',
        status: 'completed',
      },
    ]);
    expect(nip19.noteEncode).toHaveBeenCalledWith(eventId);
    expect(relays).toHaveLength(5);
    for (const relay of relays) {
      expect(relay.connect).toHaveBeenCalledWith({ timeout: 8000 });
      expect(relay.publish).toHaveBeenCalledWith(
        expect.objectContaining({ id: eventId, content: note.message })
      );
      expect(relay.close).toHaveBeenCalledTimes(1);
    }
  });

  it('stops with the event ID when no relay confirms, because it may be live', async () => {
    await expect(
      new NostrProvider().post('pubkey', 'token', [note])
    ).rejects.toMatchObject({
      type: 'bad_body',
      message: expect.stringContaining(
        `event ${eventId}. It may have been published`
      ),
    });
    expect(relays).toHaveLength(5);
    expect(relays.every((relay) => relay.close.mock.calls.length === 1)).toBe(
      true
    );
  });

  it('uses the same confirmation path for replies and preserves the reply tags', async () => {
    (Relay as unknown as jest.Mock).mockImplementation(() => {
      const relay = {
        connect: jest.fn().mockResolvedValue(undefined),
        publish: jest.fn().mockResolvedValue('accepted'),
        close: jest.fn(),
      };
      relays.push(relay);
      return relay;
    });
    const result = await new NostrProvider().comment(
      'author',
      'root',
      'previous',
      'token',
      [note],
      {} as any
    );
    expect(result[0].postId).toBe(eventId);
    expect(finalizeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: [
          ['e', 'previous', '', 'reply'],
          ['p', 'author'],
        ],
      }),
      expect.any(Uint8Array)
    );
  });
});

describe('Tumblr publication and legacy links', () => {
  const integration = {
    internalId: 'example-blog',
    profile: 'https://www.tumblr.com/blog/view/example-blog',
  } as any;

  it('uses the actual blog and exact string post ID for a new post', async () => {
    const provider = new TumblrProvider();
    (provider as any).fetch = jest.fn().mockResolvedValue({
      json: async () => ({ response: { id_string: '123456789012345678' } }),
    });
    const result = await provider.post(
      'example-blog',
      'token',
      [note],
      integration
    );
    expect(result[0]).toMatchObject({
      postId: '123456789012345678',
      releaseURL: 'https://www.tumblr.com/example-blog/123456789012345678',
    });
  });

  it('does not claim success when the post ID is absent or an unsafe number', async () => {
    for (const id of [undefined, 9007199254740992]) {
      const provider = new TumblrProvider();
      (provider as any).fetch = jest
        .fn()
        .mockResolvedValue({ json: async () => ({ response: { id } }) });
      await expect(
        provider.post('example-blog', 'token', [note], integration)
      ).rejects.toMatchObject({
        type: 'bad_body',
        message: expect.stringContaining('may be live'),
      });
    }
  });

  it('repairs a known broken dashboard URL without changing the post ID', async () => {
    const provider = new TumblrProvider();
    expect(
      await provider.resolveReleaseId(
        'token',
        '123456789012345678',
        integration,
        {},
        'https://www.tumblr.com/blog/view/example-blog/post/123456789012345678'
      )
    ).toEqual({
      postId: '123456789012345678',
      releaseURL: 'https://www.tumblr.com/example-blog/123456789012345678',
    });
    expect(
      await provider.resolveReleaseId(
        'token',
        '123456789012345678',
        integration,
        {},
        'https://custom.example/post/123456789012345678'
      )
    ).toBeUndefined();
  });
});
