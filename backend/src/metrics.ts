// Counters of this process since it started, for the monitoring
// (routes/monitor.ts); the monitoring takes the differences.
export const metrics = {
  requests: 0,
  // Answered 5xx.
  serverErrors: 0,
  // Answered 429: rate limits and too many failed logins.
  rateLimited: 0,
  failedLogins: 0,
};
