export default {
  test: {
    include: ['contract/**/*.contract.test.ts'],
    globalSetup: ['./contract/globalSetup.ts'],
    globals: true,
    fileParallelism: false,
  },
};
