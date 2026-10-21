// An Error carrying the HTTP status the server should answer with, plus optional fields (e.g. costUsd).
export const httpError = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });
