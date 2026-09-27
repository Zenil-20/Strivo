// An error that is safe to show to the client: it carries an HTTP status
// and a message we wrote ourselves (never an internal detail).
export class AppError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
