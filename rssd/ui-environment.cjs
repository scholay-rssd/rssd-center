// These component tests exercise data loading, not raster rendering. Keep the
// optional native canvas dependency out of jsdom on every supported platform.
try { require.cache[require.resolve('canvas')] = { loaded: true, exports: { createCanvas: undefined } }; } catch {}

const { TextEncoder, TextDecoder } = require('util');
const { webcrypto } = require('crypto');
const JsdomEnvironment = require('jest-environment-jsdom').TestEnvironment;

class RssdUiEnvironment extends JsdomEnvironment {
  async setup() {
    await super.setup();
    Object.defineProperty(this.global, 'TextEncoder', { value: TextEncoder, configurable: true });
    Object.defineProperty(this.global, 'TextDecoder', { value: TextDecoder, configurable: true });
    Object.defineProperty(this.global, 'crypto', { value: webcrypto, configurable: true });
  }
}

module.exports = RssdUiEnvironment;
