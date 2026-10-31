module.exports = {
  rootDir: '..',
  testEnvironment: '<rootDir>/rssd/ui-environment.cjs',
  testMatch: ['<rootDir>/rssd/*.ui.test.tsx'],
  transform: { '^.+\\.tsx?$': ['ts-jest', { diagnostics: false, tsconfig: { isolatedModules: true, target: 'ES2022', module: 'CommonJS', jsx: 'react-jsx', esModuleInterop: true } }] },
  moduleNameMapper: {
    '\\.(css)$': '<rootDir>/rssd/ui-style-mock.cjs',
    '^@gitroom/helpers/(.*)$': '<rootDir>/libraries/helpers/src/$1',
    '^@gitroom/frontend/(.*)$': '<rootDir>/apps/frontend/src/$1',
  },
};
