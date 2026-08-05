import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileNotFound, GenericFileError } from './errors.js';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    join(
      packageRoot,
      '..',
      '..',
      'contract',
      'fixtures',
      'app-sync-errors-golden.json',
    ),
    'utf8',
  ),
);

function detailsArgument(argument, details) {
  return argument === 'omitted' ? [] : [details];
}

function assertError(error, message, details) {
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('Error');
  expect(error.message).toBe(message);
  expect(error.details).toEqual(details);
  expect(Object.keys(error)).toEqual(['details']);
  expect(JSON.parse(JSON.stringify(error))).toEqual({ details });
}

it('matches every FileNotFound constructor form in the shared fixture', () => {
  expect(fixture.version).toBe(1);
  for (const testCase of fixture.fileNotFound.cases) {
    const error = new FileNotFound(
      ...detailsArgument(testCase.argument, testCase.details),
    );
    assertError(error, fixture.fileNotFound.message, testCase.details);
  }
});

it('matches every GenericFileError constructor form in the shared fixture', () => {
  for (const testCase of fixture.generic) {
    const error = new GenericFileError(
      testCase.message,
      ...detailsArgument(testCase.argument, testCase.details),
    );
    assertError(error, testCase.message, testCase.details);
  }
});
