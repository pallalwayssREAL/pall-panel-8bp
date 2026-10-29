'use strict';
/**
 * Express 4 does not forward rejected promises from async route handlers to the
 * error middleware, so a failed DB query leaves the request hanging. This patch
 * (same technique as the "express-async-errors" package, without the dependency)
 * makes every route/middleware that returns a promise forward rejections to next(err).
 */
const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__pallAsyncPatched) {
  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next(); // error-handling middleware: not for normal requests
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
    } catch (err) {
      next(err);
    }
  };
  Layer.prototype.__pallAsyncPatched = true;
}
