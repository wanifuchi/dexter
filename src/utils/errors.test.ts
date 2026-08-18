import { describe, expect, test } from 'vitest';
import {
  classifyError,
  formatUserFacingError,
  parseApiErrorInfo,
} from './errors.js';

describe('parseApiErrorInfo', () => {
  test('parses OpenAI inspect-style server errors with request id', () => {
    const raw = 'Request failed: Stream decode error: Responses API error: Object {"type": String("server_error"), "code": String("server_error"), "message": String("An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 6d00f1ae-d92c-4f25-8f66-736d22d5785e in your message."), "param": Null}.';
    expect(parseApiErrorInfo(raw)).toEqual({
      httpCode: undefined,
      type: 'server_error',
      code: 'server_error',
      message: 'An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 6d00f1ae-d92c-4f25-8f66-736d22d5785e in your message.',
      requestId: '6d00f1ae-d92c-4f25-8f66-736d22d5785e',
    });
  });
});

describe('classifyError', () => {
  test('classifies OpenAI stream decode server errors as server', () => {
    const raw = 'Request failed: Stream decode error: Responses API error: Object {"type": String("server_error"), "code": String("server_error"), "message": String("An error occurred while processing your request."), "param": Null}.';
    expect(classifyError(raw)).toBe('server');
  });
});

describe('formatUserFacingError', () => {
  test('returns a transient server error message for recoverable provider failures', () => {
    const raw = 'Request failed: Stream decode error: Responses API error: Object {"type": String("server_error"), "code": String("server_error"), "message": String("An error occurred while processing your request."), "param": Null}.';
    expect(formatUserFacingError(raw, 'OpenAI')).toContain('temporary server error');
  });
});
