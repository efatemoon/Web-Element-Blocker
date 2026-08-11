/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/ad-block-test/setup.js'],
    testMatch: ['**/ad-block-test/**/*.test.js'],
    verbose: true,
    collectCoverageFrom: [
        'web-element-blocker.user.js'
    ],
    coverageThreshold: {
        global: {
            branches: 50,
            functions: 50,
            lines: 50,
            statements: 50
        }
    }
};
