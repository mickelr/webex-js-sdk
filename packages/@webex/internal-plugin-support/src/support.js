/*!
 * Copyright (c) 2015-2020 Cisco Systems, Inc. See LICENSE file.
 */

import {WebexPlugin} from '@webex/webex-core';
import {defaults} from 'lodash';
import uuid from 'uuid';

const Support = WebexPlugin.extend({
  namespace: 'Support',

  getFeedbackUrl(options) {
    options = options || {};

    return this.request({
      method: 'POST',
      api: 'conversation',
      resource: 'users/deskFeedbackUrl',
      body: defaults(options, {
        appVersion: this.config.appVersion,
        appType: this.config.appType,
        feedbackId: options.feedbackId || uuid.v4(),
        languageCode: this.config.languageCode,
      }),
    }).then((res) => res.body.url);
  },

  getSupportUrl() {
    return this.webex
      .request({
        method: 'GET',
        api: 'conversation',
        resource: 'users/deskSupportUrl',
        qs: {
          languageCode: this.config.languageCode,
        },
      })
      .then((res) => res.body.url);
  },

  /**
   * Sends logs to the backend
   *
   * @param {Object} metadata metadata about the logs
   * @param {Array} logs logs to send, if undefined, SDK's logs will be sent
   * @param {Object} options additional options
   * @param {string} options.type 'full' or 'diff', if not specified then the config.incrementalLogs value is used to determine the type,
   *                               this option only applies if logs parameter is undefined
   *                               'diff' means that only the logs since the last log upload will be sent
   *                               'full' means that all the logs from internal buffers will be sent
   * @returns {Promise}
   */
  submitLogs(metadata, logs, options = {}) {
    const metadataArray = this._constructFileMetadata(metadata);

    const {type} = options;

    // this is really testing that Ampersand is fully ready.  once it's ready, these exist
    if (
      !logs &&
      this.webex.logger.sdkBuffer &&
      this.webex.logger.clientBuffer &&
      this.webex.logger.buffer
    ) {
      const diff = type !== undefined ? type === 'diff' : this.config.incrementalLogs;

      logs = this.webex.logger.formatLogs({diff});
    }

    let filename;

    if (metadata.locusId && metadata.callStart) {
      filename = `${metadata.locusId}_${metadata.callStart}.txt`;
    } else {
      filename = `${this.webex.sessionId}.txt`;
    }

    let userId;

    return this.webex.credentials
      .getUserToken()
      .catch(() => this.webex.credentials.getClientToken())
      .then(async (token) => {
        const headers = {authorization: token.toString()};

        const initalOpts = {
          service: 'clientLogs',
          resource: 'logs/urls',
        };

        const finalOpts = {
          service: 'clientLogs',
          resource: 'logs/meta',
        };

        const uploadOptions = defaults(initalOpts, {
          file: logs,
          shouldAttemptReauth: false,
          headers,
          phases: {
            initialize: {
              body: {
                file: filename,
              },
            },
            upload: {
              $uri: (session) => session.tempURL,
            },
            finalize: defaults(finalOpts, {
              $body: (session) => {
                userId = session.userId;

                return {
                  filename: session.logFilename,
                  data: metadataArray,
                  userId: this.webex.internal.device.userId || session.userId,
                };
              },
            }),
          },
        });

        return this.webex.upload(uploadOptions);
      })
      .then((body) => {
        if (userId && !body.userId) {
          body.userId = userId;
        }

        return body;
      });
  },

  /**
   * Constructs an array of key-value pairs for log upload.
   * @param {*} metadata
   * @returns {array}
   */
  _constructFileMetadata(metadata) {
    const metadataArray = [
      'locusId',
      'appVersion',
      'callStart',
      'feedbackId',
      'correlationId',
      'meetingId',
      'surveySessionId',
      'productAreaTag',
      'issueTypeTag',
      'issueDescTag',
      'locussessionid',
      'autoupload',
    ]
      .map((key) => {
        if (metadata[key]) {
          return {
            key,
            value: metadata[key],
          };
        }

        return null;
      })
      .filter((entry) => Boolean(entry));

    if (this.webex.sessionId) {
      metadataArray.push({
        key: 'trackingId',
        value: this.webex.sessionId,
      });
    }

    if (this.webex.internal.support.config.appVersion) {
      metadataArray.push({
        key: 'appVersion',
        value: this.webex.internal.support.config.appVersion,
      });
    }

    if (this.webex.internal.device.userId) {
      metadataArray.push({
        key: 'userId',
        value: this.webex.internal.device.userId,
      });
    }

    if (this.webex.internal.device.orgId) {
      metadataArray.push({
        key: 'orgId',
        value: this.webex.internal.device.orgId,
      });
    }

    return metadataArray;
  },
});

export default Support;
