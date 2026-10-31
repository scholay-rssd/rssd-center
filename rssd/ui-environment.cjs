// These component tests exercise data loading, not raster rendering. Keep the
// optional native canvas dependency out of jsdom on every supported platform.
try { require.cache[require.resolve('canvas')] = { loaded: true, exports: { createCanvas: undefined } }; } catch {}
module.exports = require('jest-environment-jsdom').TestEnvironment;
