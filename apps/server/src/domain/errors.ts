/**
 * Domain errors that a route turns into a status code.
 *
 * They exist so the domain layer never imports Express: a service says what went wrong, and the
 * HTTP layer alone decides what that is in HTTP.
 */

export class NotFound extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFound';
  }
}

export class Conflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Conflict';
  }
}

export class Invalid extends Error {
  constructor(
    message: string,
    readonly fields: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'Invalid';
  }
}
