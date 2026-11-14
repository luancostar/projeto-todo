module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  // Cobertura obrigatória: apenas os arquivos de produção em TypeScript (cli.ts entra quando existir).
  collectCoverageFrom: ['api.ts', 'db.ts'],
  coverageReporters: ['text', 'text-summary'],
  coverageThreshold: { global: { lines: 100 } },
};
