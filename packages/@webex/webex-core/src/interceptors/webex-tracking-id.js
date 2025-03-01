/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */

import {Interceptor} from '@webex/http-core';

export const sequenceNumbers = new Map();

/**
 * @class
 */
export default class WebexTrackingIdInterceptor extends Interceptor {
  /**
   * Sequence number; increments on access
   * @type {Number}
   */
  get sequence() {
    let sq = sequenceNumbers.get(this) || 0;

    sq += 1;
    sequenceNumbers.set(this, sq);

    return sq;
  }

  /**
   * @returns {WebexTrackingIdInterceptor}
   */
  static create() {
    return new WebexTrackingIdInterceptor({webex: this});
  }

  /**
   * @see Interceptor#onRequest
   * @param {Object} options
   * @returns {Object}
   */
  onRequest(options) {
    options.headers = options.headers || {};
    // If trackingid is already set, don't overwrite it
    if ('trackingid' in options.headers) {
      // If trackingid is set to null, false, or undefined, delete it to
      // prevent a CORS preflight.
      if (!options.headers.trackingid) {
        Reflect.deleteProperty(options.headers, 'trackingid');
      }

      return options;
    }

    if (this.requiresTrackingId(options)) {
      options.headers.trackingid = `${this.webex.sessionId}_${this.sequence}`;
    }

    if (options.headers.trackingid && options.replayCount) {
      const tid = options.headers.trackingid.split('+');

      tid[1] = options.replayCount;
      options.headers.trackingid = tid.join('+');
    }

    return options;
  }

  /**
   * Determines whether or not include a tracking id
   * @param {Object} options
   * @returns {boolean}
   */
  requiresTrackingId(options) {
    return !options.headers.trackingid;
  }
}
