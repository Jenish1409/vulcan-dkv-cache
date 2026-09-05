import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  // Use the test-specific tsconfig so ts-jest sees both src/ and tests/
  // without affecting the production build (tsconfig.json is src-only).
  globals: {
    "ts-jest": {
      tsconfig: "tsconfig.test.json",
    },
  },
  // Map the @/ alias to the src/ directory — mirrors tsconfig paths entry.
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  collectCoverageFrom: ["src/**/*.ts"],
  coverageDirectory: "coverage",
};

export default config;
